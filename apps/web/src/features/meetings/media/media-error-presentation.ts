import { CoreApiError } from '@/lib/core-api'
import {
  featureValidationMessage,
  operationErrorFormMessage,
  requestErrorKey,
  requestStatusErrorKey,
  UiPresentationError,
} from '@/lib/i18n/presentation'

type MediaPresentationValues = Record<string, string | number>

// Keep diagnostic messages available to the original error consumers, but
// never treat arbitrary exception text as an approved user-facing message.
export class MediaPresentationError extends Error {
  readonly presentationMessage: string

  constructor(
    message: string,
    key: string,
    values?: MediaPresentationValues
  ) {
    super(message)
    this.name = 'MediaPresentationError'
    this.presentationMessage = featureValidationMessage(key, values)
  }
}

export function mediaErrorMessage(
  error: unknown,
  fallbackKey = 'media:operationFailed'
): string {
  if (error instanceof MediaPresentationError) return error.presentationMessage
  if (error instanceof UiPresentationError) return error.message
  if (error instanceof CoreApiError) {
    if (requestErrorKey(error) || requestStatusErrorKey(error.status)) {
      return operationErrorFormMessage(error)
    }
  }
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
        return featureValidationMessage('media:browserPermissionDenied')
      case 'NotFoundError':
        return featureValidationMessage('media:browserDeviceUnavailable')
      case 'NotReadableError':
        return featureValidationMessage('media:browserDeviceUnreadable')
    }
  }
  return featureValidationMessage(fallbackKey)
}
