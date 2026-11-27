import { i18n } from '@/lib/i18n'

export type ProcessingStatusPresentation = {
  label: string
  kind:
    | 'pending'
    | 'processing'
    | 'action'
    | 'success'
    | 'warning'
    | 'failure'
    | 'neutral'
}

/**
 * These are the processing-job states exposed by the Core meeting-processing
 * contract. Unknown values stay visibly neutral instead of being promoted to
 * a successful result.
 */
export function presentProcessingStatus(
  status: string,
  t: (key: string) => string = (key) => i18n.t(key)
): ProcessingStatusPresentation {
  switch (status) {
    case 'PENDING':
    case 'QUEUED':
      return { label: t('processing:pending'), kind: 'pending' }
    case 'RUNNING':
      return { label: t('processing:running'), kind: 'processing' }
    case 'WAITING_FOR_REVIEW':
      return { label: t('processing:actionRequired'), kind: 'action' }
    case 'COMPLETED':
      return { label: t('processing:success'), kind: 'success' }
    case 'COMPLETED_WITH_WARNINGS':
      return { label: t('processing:warning'), kind: 'warning' }
    case 'FAILED':
      return { label: t('processing:failure'), kind: 'failure' }
    case 'CANCELLED':
      return { label: t('processing:cancelled'), kind: 'neutral' }
    default:
      return { label: t('processing:unknown'), kind: 'neutral' }
  }
}

/** Keep stage identifiers opaque to the UI, including unknown future codes. */
export function presentProcessingStage(
  code: string,
  t: (key: string) => string = (key) => i18n.t(key)
): string {
  switch (code) {
    case 'TRANSCRIPTION':
      return t('processing:stage_TRANSCRIPTION')
    case 'TRANSCRIBING':
      return t('processing:stage_TRANSCRIBING')
    case 'CONTEXTUAL_CORRECTION':
      return t('processing:stage_CONTEXTUAL_CORRECTION')
    case 'FINALIZING_TRANSCRIPT':
      return t('processing:stage_FINALIZING_TRANSCRIPT')
    case 'TRANSCRIPT_REVIEW':
      return t('processing:stage_TRANSCRIPT_REVIEW')
    case 'DIARIZING':
      return t('processing:stage_DIARIZING')
    case 'GENERATING_SUMMARY':
      return t('processing:stage_GENERATING_SUMMARY')
    case 'EXTRACTING_DECISIONS':
      return t('processing:stage_EXTRACTING_DECISIONS')
    case 'EXTRACTING_ACTION_ITEMS':
      return t('processing:stage_EXTRACTING_ACTION_ITEMS')
    case 'INDEXING':
      return t('processing:stage_INDEXING')
    case 'INDEXED':
      return t('processing:stage_INDEXED')
    case 'MEETING_INTELLIGENCE':
      return t('processing:stage_MEETING_INTELLIGENCE')
    default:
      return code
  }
}

export function presentProcessingJobType(
  code: string,
  t: (key: string) => string = (key) => i18n.t(key)
): string {
  switch (code) {
    case 'OFFLINE_MEETING_PROCESSING':
      return t('processing:jobType_OFFLINE_MEETING_PROCESSING')
    case 'DERIVED_STAGE_PROCESSING':
      return t('processing:jobType_DERIVED_STAGE_PROCESSING')
    default:
      return code
  }
}
