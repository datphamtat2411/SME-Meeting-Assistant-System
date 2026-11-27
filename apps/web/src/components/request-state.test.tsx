import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { CoreApiError } from '@/lib/core-api'
import { i18n, setUiLanguage } from '@/lib/i18n'
import { UI_LANGUAGE_STORAGE_KEY } from '@/lib/i18n/language-preference'
import { RequestError } from './request-state'

afterEach(async () => {
  await setUiLanguage('en')
  localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
})

describe('RequestError presentation', () => {
  it('localizes an HTTP category without losing a public business message', async () => {
    await setUiLanguage('en')
    const error = new CoreApiError({
      message: 'The selected room is already reserved.',
      status: 409,
      code: 'MEETING_ROOM_CONFLICT',
      kind: 'http',
    })
    const screen = await render(<RequestError error={error} />)
    await expect
      .element(screen.getByText('The selected room is already reserved.'))
      .toBeVisible()
    await expect
      .element(screen.getByText(i18n.t('errors:conflict')))
      .toBeVisible()
    await act(async () => {
      await setUiLanguage('vi')
    })
    await expect
      .element(screen.getByText(i18n.t('errors:conflict')))
      .toBeVisible()
    await expect
      .element(screen.getByText('The selected room is already reserved.'))
      .toBeVisible()
  })

  it.each([
    [500, 'errors:internal'],
    [502, 'errors:serviceUnavailable'],
    [503, 'errors:serviceUnavailable'],
    [504, 'errors:gatewayTimeout'],
    [599, 'errors:internal'],
  ] as const)(
    'uses a safe localized category for HTTP %s without exposing diagnostics',
    async (status, key) => {
      await setUiLanguage('en')
      const diagnostic = 'Upstream failure: internal-host.example.test'
      const error = new CoreApiError({
        message: diagnostic,
        status,
        kind: 'server',
      })
      const screen = await render(<RequestError error={error} />)
      await expect.element(screen.getByText(i18n.t(key))).toBeVisible()
      await expect.element(screen.getByText(diagnostic)).not.toBeInTheDocument()
      await act(async () => {
        await setUiLanguage('vi')
      })
      await expect.element(screen.getByText(i18n.t(key))).toBeVisible()
      await expect.element(screen.getByText(diagnostic)).not.toBeInTheDocument()
    }
  )

  it('keeps safe business details when a generic code is mapped', async () => {
    await setUiLanguage('en')
    const error = new CoreApiError({
      message: 'The room is already reserved.',
      status: 409,
      code: 'RESOURCE_CONFLICT',
      kind: 'http',
    })
    const screen = await render(<RequestError error={error} />)
    await expect
      .element(screen.getByText(i18n.t('errors:conflict')))
      .toBeVisible()
    await expect
      .element(screen.getByText('The room is already reserved.'))
      .toBeVisible()
    await act(async () => {
      await setUiLanguage('vi')
    })
    await expect
      .element(screen.getByText(i18n.t('errors:conflict')))
      .toBeVisible()
    await expect
      .element(screen.getByText('The room is already reserved.'))
      .toBeVisible()
  })

  it('does not repeat a generic validation message in Vietnamese', async () => {
    await setUiLanguage('vi')
    const error = new CoreApiError({
      message: 'Request validation failed.',
      status: 422,
      code: 'VALIDATION_FAILED',
      kind: 'http',
    })
    const screen = await render(<RequestError error={error} />)
    await expect
      .element(screen.getByText(i18n.t('errors:validation')))
      .toBeVisible()
    await expect
      .element(screen.getByText('Request validation failed.'))
      .not.toBeInTheDocument()
  })

  it('does not disclose details of an unmapped authentication failure', async () => {
    await setUiLanguage('vi')
    const error = new CoreApiError({
      message: 'Account exists but its password is incorrect.',
      status: 401,
      code: 'AUTH_CUSTOM_FAILURE',
      kind: 'http',
    })
    const screen = await render(<RequestError error={error} />)
    await expect
      .element(screen.getByText(i18n.t('errors:authRequired')))
      .toBeVisible()
    await expect
      .element(
        screen.getByText('Account exists but its password is incorrect.')
      )
      .not.toBeInTheDocument()
  })

  it('keeps permission failures on their explicit safe presentation', async () => {
    await setUiLanguage('vi')
    const error = new CoreApiError({
      message: 'Untranslated server detail',
      status: 403,
      kind: 'http',
    })
    const screen = await render(<RequestError error={error} />)
    await expect
      .element(screen.getByText(i18n.t('errors:forbidden')))
      .toBeVisible()
    await expect
      .element(screen.getByText('Untranslated server detail'))
      .not.toBeInTheDocument()
  })
})
