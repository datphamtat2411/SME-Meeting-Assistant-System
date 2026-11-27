import { i18n } from '@/lib/i18n'

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
  value: string | null | undefined,
  t: (key: string) => string = (key) => i18n.t(key)
): string {
  switch (canonicalResultAvailability(value)) {
    case 'AVAILABLE':
      return t('workspace:resultAvailable')
    case 'NOT_AVAILABLE':
      return t('workspace:resultNotAvailable')
    case 'PROCESSING':
      return t('workspace:resultProcessing')
    case 'NEEDS_REVIEW':
      return t('workspace:resultReview')
    case 'FAILED':
      return t('workspace:resultFailed')
    case 'UNKNOWN':
      return t('workspace:unknownStatus')
  }
}
