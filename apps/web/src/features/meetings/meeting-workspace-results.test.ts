import { describe, expect, it } from 'vitest'
import {
  canonicalResultAvailability,
  resultAvailabilityLabel,
} from './meeting-workspace-results'

describe('meeting workspace result availability', () => {
  it.each([
    ['AVAILABLE', 'AVAILABLE', 'Available'],
    ['MISSING', 'MISSING', 'Not available'],
    ['NEEDS_REVIEW', 'NEEDS_REVIEW', 'Action required'],
    ['FAILED', 'FAILED', 'Failed'],
    ['FUTURE_STATE', 'UNKNOWN', 'Unknown status'],
    [undefined, 'UNKNOWN', 'Unknown status'],
  ] as const)(
    'keeps %s distinct from successful availability',
    (value, canonical, label) => {
      expect(canonicalResultAvailability(value)).toBe(canonical)
      expect(resultAvailabilityLabel(value)).toBe(label)
    }
  )
})
