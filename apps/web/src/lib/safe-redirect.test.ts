import { describe, expect, it } from 'vitest'
import { getSafeRedirect } from './safe-redirect'

describe('getSafeRedirect', () => {
  it('preserves safe internal path, query, and hash values', () => {
    expect(getSafeRedirect('/settings?tab=profile#security')).toBe(
      '/settings?tab=profile#security'
    )
  })

  it('accepts same-origin absolute HTTP URLs and returns only their route', () => {
    const redirect = new URL(
      '/meetings?filter=active#today',
      window.location.origin
    ).toString()

    expect(getSafeRedirect(redirect)).toBe('/meetings?filter=active#today')
  })

  it.each([
    'https://external.example/steal',
    '//external.example/steal',
    'javascript:alert(1)',
    'ftp://external.example/file',
    'http://[invalid',
    '/\\external.example/steal',
    undefined,
  ])('falls back for unsafe redirect %s', (redirect) => {
    expect(getSafeRedirect(redirect)).toBe('/')
  })
})
