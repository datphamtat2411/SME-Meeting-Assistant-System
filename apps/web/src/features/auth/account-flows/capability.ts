const MAX_CAPABILITY_LENGTH = 4096

/** The server owns capability format, purpose, expiration and consumption. */
export function parseAccountCapability(fragment: string): string | null {
  const raw = fragment.replace(/^#/, '')
  // URLSearchParams tolerates malformed percent encoding; validate decoding first.
  try {
    decodeURIComponent(raw)
  } catch {
    return null
  }
  const values = new URLSearchParams(raw).getAll('token')
  const value = values[0]
  if (
    values.length !== 1 ||
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
