export type ResultAvailability =
  | 'AVAILABLE'
  | 'NOT_AVAILABLE'
  | 'PROCESSING'
  | 'NEEDS_REVIEW'
  | 'FAILED'
  | 'UNKNOWN'

export function canonicalResultAvailability(
  value: string | null | undefined
): ResultAvailability {
  switch (value) {
    case 'AVAILABLE':
    case 'NOT_AVAILABLE':
    case 'PROCESSING':
    case 'NEEDS_REVIEW':
    case 'FAILED':
      return value
    default:
      return 'UNKNOWN'
  }
}

export function resultAvailabilityLabel(
  value: string | null | undefined
): string {
  switch (canonicalResultAvailability(value)) {
    case 'AVAILABLE':
      return 'Available'
    case 'NOT_AVAILABLE':
      return 'Not available'
    case 'PROCESSING':
      return 'Processing'
    case 'NEEDS_REVIEW':
      return 'Action required'
    case 'FAILED':
      return 'Failed'
    case 'UNKNOWN':
      return 'Unknown status'
  }
}
