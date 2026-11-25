import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { loadConfigFromFile } from 'vite'
import { localMediaProxy } from '../config/local-media-proxy.ts'

type Certificate = {
  keyFile: string
  certFile: string
}

type ProxyResponse = {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

type UpstreamRequest = {
  method: string | undefined
  url: string | undefined
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

type ResponseMode = 'upload' | 'playback' | 'redirect' | 'text' | 'failure'

const bucket = 'bucket'
const meetingId = '11111111-1111-4111-8111-111111111111'
const mediaId = '22222222-2222-4222-8222-222222222222'
const signature = 'a'.repeat(64)

let tempDirectory: string
let upstreamPort: number
let proxy: ProxyHarness
let upstreamRequests: UpstreamRequest[] = []
let responseMode: ResponseMode = 'upload'
let upstream: ReturnType<typeof createHttpsServer>
let trustedCertificate: Certificate

function createCertificate(
  directory: string,
  name: string,
  commonName: string
): Certificate {
  const keyFile = join(directory, `${name}.key`)
  const certFile = join(directory, `${name}.crt`)
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '1',
      '-subj',
      `/CN=${commonName}`,
      '-addext',
      `subjectAltName=DNS:${commonName}`,
    ],
    { stdio: 'ignore' }
  )
  return { keyFile, certFile }
}

function listen(
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('The test server did not expose a TCP address.'))
        return
      }
      resolve(address.port)
    })
  })
}

function close(
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function signedPath(kind: 'pending' | 'sources' = 'pending'): string {
  return (
    `/${bucket}/meetings/${meetingId}/${kind}/${mediaId}` +
    `?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${signature}`
  )
}

function requestProxy(
  port: number,
  path: string,
  method: string,
  headers: Record<string, string> = {},
  body?: Buffer
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          })
        )
        response.on('error', reject)
      }
    )
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

type ProxyHarness = {
  port: number
  server: ReturnType<typeof createHttpServer>
}

async function startProxy(
  origin: string,
  caFile: string,
  host = '127.0.0.1'
): Promise<ProxyHarness> {
  let middleware:
    | ((
        request: import('node:http').IncomingMessage,
        response: import('node:http').ServerResponse,
        next: () => void
      ) => void)
    | undefined
  const server = createHttpServer((request, response) => {
    if (!middleware) {
      response.statusCode = 500
      response.end()
      return
    }
    middleware(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })
  const plugin = localMediaProxy(origin, caFile)
  plugin.configureServer?.({
    config: { server: { host } },
    httpServer: server,
    middlewares: {
      use(handler: typeof middleware) {
        middleware = handler
      },
    },
  } as never)
  return { server, port: await listen(server) }
}

function configureWithoutListening(
  origin: string,
  caFile: string | undefined,
  host: string | boolean | undefined = '127.0.0.1'
): void {
  localMediaProxy(origin, caFile).configureServer?.({
    config: { server: { host } },
    httpServer: { once() {} },
    middlewares: { use() {} },
  } as never)
}

async function loadWebConfig(
  overrides: Partial<
    Record<
      | 'WEB_DEV_HTTPS_KEY_FILE'
      | 'WEB_DEV_HTTPS_CERT_FILE'
      | 'VITE_CORE_API_PROXY_TARGET'
      | 'VITE_LOCAL_MEDIA_STORAGE_ORIGIN'
      | 'LOCAL_MEDIA_STORAGE_CA_FILE',
      string
    >
  > = {}
) {
  const names = [
    'WEB_DEV_HTTPS_KEY_FILE',
    'WEB_DEV_HTTPS_CERT_FILE',
    'VITE_CORE_API_BASE_URL',
    'VITE_CORE_API_PROXY_TARGET',
    'VITE_LOCAL_MEDIA_STORAGE_ORIGIN',
    'LOCAL_MEDIA_STORAGE_CA_FILE',
  ] as const
  const previous = new Map<string, string | undefined>()
  for (const name of names) {
    previous.set(name, process.env[name])
    process.env[name] =
      overrides[name] ??
      (name === 'VITE_CORE_API_BASE_URL'
        ? '/api/v1'
        : name === 'VITE_CORE_API_PROXY_TARGET'
          ? 'http://127.0.0.1:8080'
          : '')
  }
  try {
    const result = await loadConfigFromFile(
      {
        command: 'serve',
        mode: 'int03',
        isSsrBuild: false,
        isPreview: false,
      },
      resolve('vite.config.ts'),
      process.cwd(),
      'silent',
      undefined,
      'bundle'
    )
    if (!result) throw new Error('Vite did not load the Web configuration.')
    return result.config
  } finally {
    for (const name of names) {
      const value = previous.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

before(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), 'sme-int03-'))
  trustedCertificate = createCertificate(
    tempDirectory,
    'trusted',
    'storage.internal'
  )
  createCertificate(tempDirectory, 'wrong', 'other.internal')

  upstream = createHttpsServer(
    {
      key: await readFile(trustedCertificate.keyFile),
      cert: await readFile(trustedCertificate.certFile),
    },
    (request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        upstreamRequests.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks),
        })
        if (responseMode === 'upload') {
          response.statusCode = 204
          response.end()
          return
        }
        if (responseMode === 'playback') {
          const body = Buffer.from('wav')
          response.statusCode = 206
          response.setHeader('Content-Type', 'audio/wav')
          response.setHeader('Content-Length', body.length)
          response.setHeader('Content-Range', 'bytes 0-2/3')
          response.setHeader('Accept-Ranges', 'bytes')
          response.end(body)
          return
        }
        if (responseMode === 'redirect') {
          response.statusCode = 302
          response.setHeader('Location', 'https://redirect.invalid/object')
          response.end('redirect')
          return
        }
        if (responseMode === 'text') {
          response.statusCode = 200
          response.setHeader('Content-Type', 'text/plain')
          response.end('not audio')
          return
        }
        response.statusCode = 500
        response.setHeader('Content-Type', 'application/xml')
        response.end('<error/>')
      })
    }
  )
  upstreamPort = await listen(upstream)
  proxy = await startProxy(
    `https://storage.internal:${upstreamPort}`,
    trustedCertificate.certFile
  )
})

after(async () => {
  await close(proxy.server)
  await close(upstream)
  await rm(tempDirectory, { recursive: true, force: true })
})

test('forwards a permitted signed PUT with storage identity and filtered headers', async () => {
  responseMode = 'upload'
  upstreamRequests = []
  const result = await requestProxy(
    proxy.port,
    `/__local-media${signedPath()}`,
    'PUT',
    {
      'Content-Type': 'audio/wav',
      'Content-Length': '3',
      Cookie: 'session=must-not-forward',
      Authorization: 'Bearer must-not-forward',
      Origin: 'https://web.example',
    },
    Buffer.from('abc')
  )

  assert.equal(result.status, 200)
  assert.equal(upstreamRequests.length, 1)
  const request = upstreamRequests[0]
  assert.equal(request?.method, 'PUT')
  assert.equal(request?.url, signedPath())
  assert.equal(request?.headers.host, `storage.internal:${upstreamPort}`)
  assert.equal(request?.headers['content-type'], 'audio/wav')
  assert.equal(request?.headers['content-length'], '3')
  assert.equal(request?.headers.cookie, undefined)
  assert.equal(request?.headers.authorization, undefined)
  assert.equal(request?.headers.origin, undefined)
  assert.deepEqual(request?.body, Buffer.from('abc'))
})

test('forwards only a permitted signed playback range and filters session headers', async () => {
  responseMode = 'playback'
  upstreamRequests = []
  const result = await requestProxy(
    proxy.port,
    `/__local-media${signedPath('sources')}`,
    'GET',
    {
      Range: 'bytes=0-2',
      Cookie: 'session=must-not-forward',
      Authorization: 'Bearer must-not-forward',
      Origin: 'https://web.example',
    }
  )

  assert.equal(result.status, 206)
  assert.equal(result.headers['content-type'], 'audio/wav')
  assert.equal(result.headers['content-range'], 'bytes 0-2/3')
  assert.deepEqual(result.body, Buffer.from('wav'))
  assert.equal(upstreamRequests[0]?.headers.range, 'bytes=0-2')
  assert.equal(upstreamRequests[0]?.headers.cookie, undefined)
  assert.equal(upstreamRequests[0]?.headers.authorization, undefined)
  assert.equal(upstreamRequests[0]?.headers.origin, undefined)
})

test('rejects unsupported methods, paths, signatures, sizes, and media types before upstream access', async () => {
  upstreamRequests = []
  const invalidRequests: Array<Promise<ProxyResponse>> = [
    requestProxy(proxy.port, `/__local-media${signedPath()}`, 'POST', {
      Connection: 'close',
    }),
    requestProxy(
      proxy.port,
      `/__local-media${signedPath('sources')}`,
      'PUT',
      {
        'Content-Type': 'audio/wav',
        'Content-Length': '3',
        Connection: 'close',
      },
      Buffer.from('abc')
    ),
    requestProxy(
      proxy.port,
      `/__local-media/${bucket}/meetings/${meetingId}/pending/${mediaId}` +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=not-a-signature',
      'PUT',
      {
        'Content-Type': 'audio/wav',
        'Content-Length': '3',
        Connection: 'close',
      },
      Buffer.from('abc')
    ),
    requestProxy(
      proxy.port,
      `/__local-media${signedPath()}`,
      'PUT',
      {
        'Content-Type': 'video/mp4',
        'Content-Length': '3',
        Connection: 'close',
      },
      Buffer.from('abc')
    ),
    requestProxy(
      proxy.port,
      `/__local-media${signedPath()}`,
      'PUT',
      {
        'Content-Type': 'audio/wav',
        'Content-Length': '0',
        Connection: 'close',
      }
    ),
    requestProxy(
      proxy.port,
      `/__local-media${signedPath()}`,
      'PUT',
      {
        'Content-Type': 'audio/wav',
        'Content-Length': String(1024 ** 3 + 1),
        Connection: 'close',
      }
    ),
  ]
  const results = await Promise.all(invalidRequests)

  assert.deepEqual(
    results.map(({ status }) => status),
    [404, 404, 404, 400, 400, 400]
  )
  assert.equal(upstreamRequests.length, 0)
})

test('does not follow redirects or expose unsupported upstream responses', async () => {
  responseMode = 'redirect'
  const redirect = await requestProxy(
    proxy.port,
    `/__local-media${signedPath('sources')}`,
    'GET'
  )
  assert.equal(redirect.status, 502)
  assert.equal(redirect.headers.location, undefined)
  assert.deepEqual(redirect.body, Buffer.alloc(0))

  responseMode = 'text'
  const unsupported = await requestProxy(
    proxy.port,
    `/__local-media${signedPath('sources')}`,
    'GET'
  )
  assert.equal(unsupported.status, 502)
  assert.deepEqual(unsupported.body, Buffer.alloc(0))
})

test('fails closed when the configured storage CA does not verify the upstream', async () => {
  const wrongCaFile = join(tempDirectory, 'wrong.crt')
  const wrongProxy = await startProxy(
    `https://storage.internal:${upstreamPort}`,
    wrongCaFile
  )
  try {
    const result = await requestProxy(
      wrongProxy.port,
      `/__local-media${signedPath()}`,
      'PUT',
      { 'Content-Type': 'audio/wav', 'Content-Length': '3' },
      Buffer.from('abc')
    )
    assert.equal(result.status, 502)
  } finally {
    await close(wrongProxy.server)
  }
})

test('rejects missing CA material, non-HTTPS storage, and non-loopback bindings', () => {
  assert.throws(
    () =>
      configureWithoutListening(
        `https://storage.internal:${upstreamPort}`,
        undefined
      ),
    /requires a loopback Vite server/
  )
  assert.throws(
    () =>
      configureWithoutListening(
        `http://storage.internal:${upstreamPort}`,
        join(tempDirectory, 'trusted.crt')
      ),
    /requires a loopback Vite server/
  )
  assert.throws(
    () =>
      configureWithoutListening(
        `https://storage.internal:${upstreamPort}`,
        join(tempDirectory, 'trusted.crt'),
        '0.0.0.0'
      ),
    /requires a loopback Vite server/
  )
  assert.throws(
    () =>
      configureWithoutListening(
        `https://storage.internal:${upstreamPort}`,
        join(tempDirectory, 'missing-ca.crt')
      ),
    /ENOENT/
  )
})

test('loads the fixed HTTP local Vite and same-origin proxy configuration', async () => {
  const httpDevelopment = await loadWebConfig()
  assert.equal(httpDevelopment.server.host, '127.0.0.1')
  assert.equal(httpDevelopment.server.port, 5173)
  assert.equal(httpDevelopment.server.strictPort, true)
  assert.equal(httpDevelopment.server.https, undefined)
  assert.deepEqual(httpDevelopment.server.proxy?.['/api'], {
    target: 'http://127.0.0.1:8080',
    changeOrigin: false,
  })

  const staleHttpsEnvironment = await loadWebConfig({
    WEB_DEV_HTTPS_KEY_FILE: trustedCertificate.keyFile,
    WEB_DEV_HTTPS_CERT_FILE: trustedCertificate.certFile,
  })
  assert.equal(staleHttpsEnvironment.server.https, undefined)
  assert.equal(staleHttpsEnvironment.server.port, 5173)
})
