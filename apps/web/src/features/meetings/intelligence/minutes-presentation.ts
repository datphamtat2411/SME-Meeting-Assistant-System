import { i18n } from '@/lib/i18n'

type Translate = (key: string, options?: { value: string }) => string

const warningKeys: Record<string, string> = {
  TRANSCRIPT_NOT_AVAILABLE: 'minutes:warning_TRANSCRIPT_NOT_AVAILABLE',
  TRANSCRIPT_PROCESSING: 'minutes:warning_TRANSCRIPT_PROCESSING',
  TRANSCRIPT_FAILED: 'minutes:warning_TRANSCRIPT_FAILED',
  TRANSCRIPT_SUSPICIOUS_SEGMENTS:
    'minutes:warning_TRANSCRIPT_SUSPICIOUS_SEGMENTS',
  TRANSCRIPT_UNRESOLVED_SEGMENTS:
    'minutes:warning_TRANSCRIPT_UNRESOLVED_SEGMENTS',
  TRANSCRIPT_INCOMPLETE_COVERAGE:
    'minutes:warning_TRANSCRIPT_INCOMPLETE_COVERAGE',
  TRANSCRIPT_QUALITY_WARNING: 'minutes:warning_TRANSCRIPT_QUALITY_WARNING',
  SUMMARY_NOT_AVAILABLE: 'minutes:warning_SUMMARY_NOT_AVAILABLE',
  SUMMARY_SOURCE_STALE: 'minutes:warning_SUMMARY_SOURCE_STALE',
  SUMMARY_QUALITY_WARNING: 'minutes:warning_SUMMARY_QUALITY_WARNING',
  DECISION_SOURCE_STALE: 'minutes:warning_DECISION_SOURCE_STALE',
  DECISION_EVIDENCE_WARNING: 'minutes:warning_DECISION_EVIDENCE_WARNING',
}

const statusKeys: Record<string, string> = {
  COMPLETE: 'minutes:status_COMPLETE',
  PARTIAL: 'minutes:status_PARTIAL',
  NEEDS_REVIEW: 'minutes:status_NEEDS_REVIEW',
  AVAILABLE: 'minutes:status_AVAILABLE',
  NOT_AVAILABLE: 'minutes:status_NOT_AVAILABLE',
  PROCESSING: 'minutes:status_PROCESSING',
  FAILED: 'minutes:status_FAILED',
  CONFIRMED: 'minutes:status_CONFIRMED',
  OPEN: 'minutes:status_OPEN',
  IN_PROGRESS: 'minutes:status_IN_PROGRESS',
  DONE: 'minutes:status_DONE',
  CANCELLED: 'minutes:status_CANCELLED',
  STALE: 'minutes:status_STALE',
  DRAFT: 'minutes:status_DRAFT',
  SCHEDULED: 'minutes:status_SCHEDULED',
  ENDED: 'minutes:status_ENDED',
  AI_GENERATED: 'minutes:status_AI_GENERATED',
  HUMAN_EDIT: 'minutes:status_HUMAN_EDIT',
  AI_EXTRACTED: 'minutes:status_AI_EXTRACTED',
  MANUAL: 'minutes:status_MANUAL',
  READY: 'minutes:status_READY',
  READY_WITH_WARNINGS: 'minutes:status_READY_WITH_WARNINGS',
  PROPOSED: 'minutes:status_PROPOSED',
}

export function minutesWarning(
  value: string,
  t: Translate = (key, options) => i18n.t(key, options)
) {
  return Object.prototype.hasOwnProperty.call(warningKeys, value)
    ? t(warningKeys[value])
    : value
}

export function minutesStatusLabel(
  value: string,
  t: Translate = (key, options) => i18n.t(key, options)
) {
  return Object.prototype.hasOwnProperty.call(statusKeys, value)
    ? t(statusKeys[value])
    : t('minutes:unrecognized', { value })
}

export function formatMinutesDuration(
  ms: number | null,
  t: Translate = (key, options) => i18n.t(key, options)
) {
  if (ms === null) return t('minutes:notAvailable')
  if (ms < 1000) return `${ms} ms`
  const seconds = Math.floor(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remaining = seconds % 60
  return (
    [
      hours ? `${hours}h` : '',
      minutes ? `${minutes}m` : '',
      remaining ? `${remaining}s` : '',
    ]
      .filter(Boolean)
      .join(' ') || '0s'
  )
}
