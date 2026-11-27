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
