import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { coreApi } from '@/lib/core-api'
import { setUiLanguage } from '@/lib/i18n'
import { UI_LANGUAGE_STORAGE_KEY } from '@/lib/i18n/language-preference'
import { RegionalPresentationProvider } from '@/context/regional-presentation'
import { preferencesQueryKey } from '@/features/settings/preferences-api'
import { DatePicker } from './date-picker'

const preferences = {
  timezone: 'America/Los_Angeles',
  locale: 'vi-VN',
  meetingEmailEnabled: true,
  actionItemEmailEnabled: true,
}

describe('DatePicker regional presentation', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await setUiLanguage('en')
    localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY)
  })

  it('formats the selected civil day without converting its timezone', async () => {
    vi.spyOn(coreApi, 'get').mockResolvedValue(preferences)
    const client = new QueryClient()
    client.setQueryData(preferencesQueryKey, preferences)
    const selected = new Date(2026, 10, 27)
    const onSelect = vi.fn()
    await setUiLanguage('vi')
    const screen = await render(
      <QueryClientProvider client={client}>
        <RegionalPresentationProvider>
          <DatePicker selected={selected} onSelect={onSelect} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    const button = screen.getByRole('button')
    const label = (locale: string) =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        calendar: 'gregory',
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(2026, 10, 27)))
    await expect.element(button).toHaveTextContent(label('vi-VN'))

    await act(async () => {
      await setUiLanguage('en')
    })
    await expect.element(button).toHaveTextContent(label('vi-VN'))

    await act(async () => {
      client.setQueryData(preferencesQueryKey, {
        ...preferences,
        locale: 'en-GB',
        timezone: 'Asia/Tokyo',
      })
    })
    await expect.element(button).toHaveTextContent(label('en-GB'))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
