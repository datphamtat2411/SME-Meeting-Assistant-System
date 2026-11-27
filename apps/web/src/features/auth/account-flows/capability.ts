const MAX_CAPABILITY_LENGTH = 4096

/** The server owns capability format, purpose, expiration and consumption. */
export function parseAccountCapability(fragment: string): string | null {
  if (!fragment.startsWith('#')) return null
  const raw = fragment.slice(1)
  // URLSearchParams tolerates malformed percent encoding; validate decoding first.
  try {
    decodeURIComponent(raw)
  } catch {
    return null
  }
  const parameters = Array.from(new URLSearchParams(raw).entries())
  if (parameters.length !== 1 || parameters[0]?.[0] !== 'token') return null
  const value = parameters[0][1]
  if (
    !value ||
    value.length > MAX_CAPABILITY_LENGTH ||
    /\s/.test(value) ||
    Array.from(value).some((char) => {
      const code = char.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    return null
  }
  return value
}
