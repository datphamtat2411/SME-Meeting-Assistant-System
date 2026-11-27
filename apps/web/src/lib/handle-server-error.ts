import { AxiosError } from 'axios'
import { toast } from 'sonner'
import { CoreApiError } from './core-api'
import { i18n } from './i18n'
import { errorCodeKey } from './i18n/presentation'

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

  if (error instanceof AxiosError) {
    const title = error.response?.data?.title
    if (typeof title === 'string' && title.length > 0) {
      errMsg = title
    }
  }

  const code =
    error instanceof CoreApiError
      ? error.code
      : error instanceof AxiosError
        ? error.response?.data?.code
        : undefined
  const key = errorCodeKey(code)
  toast.error(key ? i18n.t(key) : errMsg)
}
