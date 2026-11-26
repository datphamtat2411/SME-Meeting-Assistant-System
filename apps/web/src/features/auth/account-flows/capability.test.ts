import { describe, expect, it } from 'vitest'
import { parseAccountCapability } from './capability'

describe('account capability parsing', () => {
  it('accepts an opaque encoded capability without altering it', () => {
    expect(parseAccountCapability('#token=a%2Bb.c-d_')).toBe('a+b.c-d_')
  })

  it.each([
    '',
    'token=missing-fragment-marker',
    '#token=',
    '#token=a&token=b',
    '#token=a&source=email',
    '#source=email&token=a',
    '#token=%ZZ',
    '#token=%FF',
    '#token=%20',
    '#token=a%0Ab',
    '#token=a%00b',
    '#token=' + 'a'.repeat(4097),
  ])('rejects invalid fragments', (fragment) => {
    expect(parseAccountCapability(fragment)).toBeNull()
  })
})
