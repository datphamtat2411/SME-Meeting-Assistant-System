import { AxiosError } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreApiError } from './core-api'
import { handleServerError } from './handle-server-error'
import { i18n, setUiLanguage } from './i18n'
import { UI_LANGUAGE_STORAGE_KEY } from './i18n/language-preference'

const toastError = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: toastError,
  },
}))

beforeEach(() => {
  vi.mocked(toastError).mockClear()
})

afterEach(async () => {
  await setUiLanguage('en')
  localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
})

describe('handleServerError', () => {
  it('shows a generic message when the error is not recognised', () => {
    handleServerError(new Error('network'))

    expect(toastError).toHaveBeenCalledWith('Something went wrong!')
  })

  it('maps a plain object with status 204 to the no-content message', () => {
    handleServerError({ status: 204 })

    expect(toastError).toHaveBeenCalledWith('No content.')
  })

  it('prefers the API title when the error is an Axios error with response data', () => {
    const error = new AxiosError('Bad request')
    error.response = {
      status: 422,
      data: { title: 'Validation failed' },
    } as AxiosError['response']

    handleServerError(error)

    expect(toastError).toHaveBeenCalledWith('Validation failed')
  })

  it('uses a safe server category when Axios response has no data.title', () => {
    const error = new AxiosError('Request failed')
    error.response = {
      status: 500,
      data: {},
    } as AxiosError['response']

    handleServerError(error)

    expect(toastError).toHaveBeenCalledWith(i18n.t('errors:internal'))
  })

  it.each([
    [401, 'errors:authRequired'],
    [403, 'errors:forbidden'],
    [404, 'errors:notFound'],
    [502, 'errors:serviceUnavailable'],
    [503, 'errors:serviceUnavailable'],
    [504, 'errors:gatewayTimeout'],
    [599, 'errors:internal'],
  ] as const)(
    'does not disclose diagnostic titles or messages for HTTP %s',
    async (status, key) => {
      const diagnostic = 'Private upstream or account detail'
      const error = new AxiosError(diagnostic)
      error.response = {
        status,
        data: { title: diagnostic, message: diagnostic },
      } as AxiosError['response']
      const coreError = new CoreApiError({
        status,
        message: diagnostic,
        kind: status >= 500 ? 'server' : 'http',
      })

      for (const language of ['en', 'vi'] as const) {
        await setUiLanguage(language)
        handleServerError(error)
        handleServerError(coreError)
        expect(toastError).toHaveBeenNthCalledWith(
          language === 'en' ? 1 : 3,
          i18n.t(key)
        )
        expect(toastError).toHaveBeenLastCalledWith(i18n.t(key))
      }
      expect(toastError).not.toHaveBeenCalledWith(diagnostic)
    }
  )

  it('falls back to the generic message when Axios data.title is an empty string', () => {
    const error = new AxiosError('Bad request')
    error.response = {
      status: 400,
      data: { title: '' },
    } as AxiosError['response']

    handleServerError(error)

    expect(toastError).toHaveBeenCalledWith('Something went wrong!')
  })

  it('logs the error to the console in development', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = new Error('logged')

    handleServerError(err)

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(err)

    log.mockRestore()
  })

  it('does not log the error to the console in production', () => {
    vi.stubEnv('DEV', false)

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = new Error('not logged')

    handleServerError(err)

    expect(log).not.toHaveBeenCalled()

    log.mockRestore()
  })
})
