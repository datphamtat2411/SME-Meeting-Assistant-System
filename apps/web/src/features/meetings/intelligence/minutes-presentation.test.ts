import { describe, expect, it } from 'vitest'
import { i18n } from '@/lib/i18n'
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

  it('localizes warnings and statuses without changing their identity', () => {
    const translate = (key: string, options?: { value: string }) =>
      i18n.t(key, { ...options, lng: 'vi' })
    expect(minutesStatusLabel('NEEDS_REVIEW', translate)).toBe('Cần xem xét')
    expect(minutesWarning('TRANSCRIPT_FAILED', translate)).toBe(
      'Xử lý bản ghi lời thoại thất bại.'
    )
    expect(minutesWarning('FUTURE_WARNING', translate)).toBe('FUTURE_WARNING')
  })
})
