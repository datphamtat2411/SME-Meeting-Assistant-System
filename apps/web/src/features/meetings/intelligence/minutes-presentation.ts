const warningMessages: Record<string, string> = {
  TRANSCRIPT_NOT_AVAILABLE: 'A current transcript is not available.',
  TRANSCRIPT_PROCESSING: 'The transcript is still being processed.',
  TRANSCRIPT_FAILED: 'Transcript processing failed.',
  TRANSCRIPT_SUSPICIOUS_SEGMENTS: 'Some transcript segments require review.',
  TRANSCRIPT_UNRESOLVED_SEGMENTS: 'Some speech segments remain unresolved.',
  TRANSCRIPT_INCOMPLETE_COVERAGE:
    'Some detected speech has not been represented in the transcript.',
  TRANSCRIPT_QUALITY_WARNING: 'The transcript has a quality warning.',
  SUMMARY_NOT_AVAILABLE: 'A current summary is not available.',
  SUMMARY_SOURCE_STALE: 'The summary references an older transcript revision.',
  SUMMARY_QUALITY_WARNING: 'The summary has quality warnings.',
  DECISION_SOURCE_STALE: 'A confirmed decision references stale evidence.',
  DECISION_EVIDENCE_WARNING:
    'A confirmed decision has uncertainty or evidence warnings.',
}

const statusLabels: Record<string, string> = {
  COMPLETE: 'Complete',
  PARTIAL: 'Partial',
  NEEDS_REVIEW: 'Needs review',
  AVAILABLE: 'Available',
  NOT_AVAILABLE: 'Not available',
  PROCESSING: 'Processing',
  FAILED: 'Failed',
  CONFIRMED: 'Confirmed',
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
  STALE: 'Stale source',
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  ENDED: 'Ended',
}

export function minutesWarning(value: string) {
  return Object.prototype.hasOwnProperty.call(warningMessages, value)
    ? warningMessages[value]
    : value
}

export function minutesStatusLabel(value: string) {
  return Object.prototype.hasOwnProperty.call(statusLabels, value)
    ? statusLabels[value]
    : 'Unrecognized status: ' + value
}

export function formatMinutesDuration(ms: number | null) {
  if (ms === null) return 'Not available'
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
