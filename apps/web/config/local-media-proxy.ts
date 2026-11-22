import { lookup } from 'node:dns'
import { readFileSync } from 'node:fs'
import { Agent, request } from 'node:https'
import type { Plugin } from 'vite'

const prefix = '/__local-media'
const keyPattern =
  /^\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/meetings\/[0-9a-f-]{36}\/(pending|sources)\/[0-9a-f-]{36}$/
const audioTypes = new Set(['audio/wav', 'audio/mpeg', 'audio/mp4'])

/** Local dev only. The storage boundary still verifies the end-to-end SigV4 capability. */
export function localMediaProxy(origin: string, caFile?: string): Plugin {
  return {
    name: 'local-signed-media',
    apply: 'serve',
    configureServer(server) {
      const target = new URL(origin)
      const host = server.config.server.host
      if (
        target.protocol !== 'https:' || target.hostname !== 'storage.internal' ||
        target.origin !== origin || !caFile ||
        (host !== undefined && host !== false && host !== 'localhost' &&
          host !== '127.0.0.1' && host !== '::1')
      ) {
        throw new Error('Local signed media requires a loopback Vite server and the storage.internal HTTPS origin and CA.')
      }
      const agent = new Agent({
        ca: readFileSync(caFile),
        lookup: (_hostname, options, callback) => lookup('127.0.0.1', options, callback),
      })
      server.httpServer?.once('close', () => agent.destroy())
      server.middlewares.use((incoming, outgoing, next) => {
        if (!incoming.url?.startsWith(`${prefix}/`)) return next()
        const raw = incoming.url.slice(prefix.length)
        const q = raw.indexOf('?')
        const kind = q >= 0 ? keyPattern.exec(raw.slice(0, q))?.[1] : undefined
        const query = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '')
        const upload = kind === 'pending' && incoming.method === 'PUT'
        const playback = kind === 'sources' && incoming.method === 'GET'

        outgoing.setHeader('Cache-Control', 'private, no-store')
        outgoing.setHeader('X-Content-Type-Options', 'nosniff')
        const fail = (status: number) => {
          if (outgoing.headersSent) outgoing.destroy()
          else { outgoing.statusCode = status; outgoing.end() }
        }

        if ((!upload && !playback) || raw.length > 8192 ||
            query.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' ||
            !query.get('X-Amz-Signature')?.match(/^[a-f0-9]{64}$/)) {
          fail(404)
          return
        }

        // Allowlist only transport headers. Never forward browser cookies, auth,
        // private Origin, or arbitrary S3-operation headers.
        const headers: Record<string, string> = { host: target.host }
        const { 'content-type': type, 'content-length': length, range } = incoming.headers
        if (upload) {
          if (!type || !audioTypes.has(type) || !length?.match(/^\d{1,10}$/) ||
              Number(length) < 1 || Number(length) > 1024 ** 3) {
            fail(400)
            return
          }
          headers['content-type'] = type
          headers['content-length'] = length
        } else if (range?.match(/^bytes=(?:\d+-\d*|-\d+)$/)) {
          headers.range = range
        }

        const upstream = request(target, {
          path: raw, method: incoming.method, headers, agent,
        }, (response) => {
          const status = response.statusCode ?? 502
          const type = response.headers['content-type']
          if (upload || ![200, 206].includes(status) || !type || !audioTypes.has(type)) {
            // Do not forward redirects, XML errors, or arbitrary content on the Web origin.
            response.resume()
            fail(upload && status >= 200 && status < 300 ? 200 : status >= 400 ? status : 502)
            return
          }
          outgoing.statusCode = status
          for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges'] as const) {
            const value = response.headers[name]
            if (value) outgoing.setHeader(name, value)
          }
          response.once('error', () => fail(502))
          response.pipe(outgoing)
        })
        upstream.setTimeout(8 * 60 * 1000, () => upstream.destroy())
        upstream.once('error', () => fail(502)) // Do not log the signed URL.
        outgoing.once('close', () => {
          if (!outgoing.writableFinished) upstream.destroy()
        })
        if (upload) incoming.pipe(upstream)
        else upstream.end()
      })
    },
  }
}
