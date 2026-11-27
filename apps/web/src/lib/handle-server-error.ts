import { AxiosError } from 'axios'
import { toast } from 'sonner'
import { CoreApiError, normalizeCoreApiError } from './core-api'
import { i18n } from './i18n'
import { requestErrorKey, requestStatusErrorKey } from './i18n/presentation'

export function handleServerError(error: unknown) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log(error)
  }

  let errMsg = i18n.t('errors:generic')

  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    Number(error.status) === 204
  ) {
    errMsg = i18n.t('errors:noContent')
  }

  if (error instanceof CoreApiError || error instanceof AxiosError) {
    const failure = normalizeCoreApiError(error)
    const key =
      requestErrorKey(failure) ??
      (failure.isServerError
        ? requestStatusErrorKey(failure.status)
        : undefined)
    if (key) {
      toast.error(i18n.t(key))
      return
    }

    // The legacy public title is only suitable for a client error.
    if (
      error instanceof AxiosError &&
      failure.status !== undefined &&
      failure.status >= 400 &&
      failure.status < 500
    ) {
      const title = error.response?.data?.title
      if (typeof title === 'string' && title.length > 0) {
        errMsg = title
      }
    }
  }

  toast.error(errMsg)
}
