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
  status: string
): ProcessingStatusPresentation {
  switch (status) {
    case 'PENDING':
    case 'QUEUED':
      return { label: 'Pending', kind: 'pending' }
    case 'RUNNING':
      return { label: 'Processing', kind: 'processing' }
    case 'WAITING_FOR_REVIEW':
      return { label: 'Action required', kind: 'action' }
    case 'COMPLETED':
      return { label: 'Success', kind: 'success' }
    case 'COMPLETED_WITH_WARNINGS':
      return { label: 'Warning', kind: 'warning' }
    case 'FAILED':
      return { label: 'Failure', kind: 'failure' }
    case 'CANCELLED':
      return { label: 'Cancelled', kind: 'neutral' }
    default:
      return { label: 'Unknown status', kind: 'neutral' }
  }
}
