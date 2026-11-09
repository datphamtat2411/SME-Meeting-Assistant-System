const FALLBACK_REDIRECT = '/'

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

function routeFromUrl(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`
}

export function getSafeRedirect(redirect?: string): string {
  if (!redirect || redirect.trim() !== redirect) return FALLBACK_REDIRECT

  const origin = globalThis.location?.origin
  if (!origin) return FALLBACK_REDIRECT

  if (redirect.startsWith('/') && !redirect.startsWith('//')) {
    if (redirect.startsWith('/\\')) return FALLBACK_REDIRECT

    try {
      const url = new URL(redirect, origin)
      return isHttpUrl(url) && url.origin === origin
        ? routeFromUrl(url)
        : FALLBACK_REDIRECT
    } catch {
      return FALLBACK_REDIRECT
    }
  }

  try {
    const url = new URL(redirect)
    return isHttpUrl(url) && url.origin === origin
      ? routeFromUrl(url)
      : FALLBACK_REDIRECT
  } catch {
    return FALLBACK_REDIRECT
  }
}
