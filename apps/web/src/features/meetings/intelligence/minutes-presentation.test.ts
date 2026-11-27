import { describe, expect, it } from 'vitest'
import {
  formatMinutesDuration,
  minutesStatusLabel,
  minutesWarning,
} from './minutes-presentation'

describe('Minutes presentation', () => {
  it('distinguishes lifecycle states and preserves unknown warning text', () => {
    expect(minutesStatusLabel('OPEN')).toBe('Open')
    expect(minutesStatusLabel('DONE')).toBe('Done')
    expect(minutesStatusLabel('NEEDS_REVIEW')).toBe('Needs review')
    expect(minutesStatusLabel('FUTURE_STATE')).toContain('FUTURE_STATE')
    expect(minutesWarning('FUTURE_WARNING')).toBe('FUTURE_WARNING')
    expect(minutesWarning('TRANSCRIPT_INCOMPLETE_COVERAGE')).toContain(
      'detected speech'
    )
  })

  it('represents durations without fabricating a missing duration', () => {
    expect(formatMinutesDuration(null)).toBe('Not available')
    expect(formatMinutesDuration(3661000)).toBe('1h 1m 1s')
    expect(formatMinutesDuration(0)).toBe('0 ms')
  })
})
