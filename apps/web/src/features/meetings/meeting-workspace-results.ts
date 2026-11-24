export type ResultAvailability =
  | 'AVAILABLE'
  | 'MISSING'
  | 'NEEDS_REVIEW'
  | 'FAILED'
  | 'UNKNOWN'

export function canonicalResultAvailability(
  value: string | null | undefined
): ResultAvailability {
  switch (value) {
    case 'AVAILABLE':
    case 'MISSING':
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
    case 'MISSING':
      return 'Not available'
    case 'NEEDS_REVIEW':
      return 'Action required'
    case 'FAILED':
      return 'Failed'
    case 'UNKNOWN':
      return 'Unknown status'
  }
}
