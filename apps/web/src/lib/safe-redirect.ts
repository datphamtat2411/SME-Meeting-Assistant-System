const FALLBACK_REDIRECT = '/'

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

function routeFromUrl(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function safeRouteFromUrl(url: URL, origin: string): string | undefined {
  if (!isHttpUrl(url) || url.origin !== origin) return undefined

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }

  // Reject encoded protocol-relative paths, backslashes (which special URL
  // parsers may treat as separators), and control characters before handing
  // the value to the router.
  if (
    decodedPath.startsWith('//') ||
    decodedPath.includes('\\') ||
    containsControlCharacter(decodedPath)
  ) {
    return undefined
  }

  return routeFromUrl(url)
}

export function getSafeRedirect(redirect?: string): string {
  if (!redirect || redirect.trim() !== redirect) return FALLBACK_REDIRECT

  const origin = globalThis.location?.origin
  if (!origin) return FALLBACK_REDIRECT

  if (redirect.startsWith('/') && !redirect.startsWith('//')) {
    if (redirect.startsWith('/\\')) return FALLBACK_REDIRECT

    try {
      const url = new URL(redirect, origin)
      return safeRouteFromUrl(url, origin) ?? FALLBACK_REDIRECT
    } catch {
      return FALLBACK_REDIRECT
    }
  }

  try {
    const url = new URL(redirect)
    return safeRouteFromUrl(url, origin) ?? FALLBACK_REDIRECT
  } catch {
    return FALLBACK_REDIRECT
  }
}
