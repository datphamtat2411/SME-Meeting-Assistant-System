import { describe, expect, it } from 'vitest'
import { i18n } from '@/lib/i18n'
import {
  canonicalResultAvailability,
  resultAvailabilityLabel,
} from './meeting-workspace-results'

describe('meeting workspace result availability', () => {
  it.each([
    ['AVAILABLE', 'AVAILABLE', 'Available'],
    ['NOT_AVAILABLE', 'NOT_AVAILABLE', 'Not available'],
    ['PROCESSING', 'PROCESSING', 'Processing'],
    ['NEEDS_REVIEW', 'NEEDS_REVIEW', 'Action required'],
    ['FAILED', 'FAILED', 'Failed'],
    ['FUTURE_STATE', 'UNKNOWN', 'Unknown status'],
    [undefined, 'UNKNOWN', 'Unknown status'],
  ] as const)(
    'keeps %s distinct from successful availability',
    (value, canonical, label) => {
      expect(canonicalResultAvailability(value)).toBe(canonical)
      expect(
        resultAvailabilityLabel(value, (key) => i18n.t(key, { lng: 'en' }))
      ).toBe(label)
    }
  )

  it('keeps review and unknown states distinct in Vietnamese', () => {
    const translate = (key: string) => i18n.t(key, { lng: 'vi' })
    expect(resultAvailabilityLabel('NEEDS_REVIEW', translate)).toBe('Cần thao tác')
    expect(resultAvailabilityLabel('FUTURE_STATE', translate)).toBe(
      'Trạng thái không xác định'
    )
    expect(resultAvailabilityLabel('AVAILABLE', translate)).toBe('Có sẵn')
  })
})
