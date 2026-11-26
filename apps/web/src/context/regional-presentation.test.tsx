import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { act } from 'react'
import { coreApi } from '@/lib/core-api'
import { preferencesQueryKey } from '@/features/settings/preferences-api'
import { resolveRegionalPreferences } from '@/features/settings/regional-preferences'
import {
  RegionalPresentationProvider,
  useRegionalPresentation,
} from './regional-presentation'

const preferences = {
  timezone: 'Asia/Tokyo',
  locale: 'ja-JP',
  meetingEmailEnabled: true,
  actionItemEmailEnabled: true,
}

function Probe() {
  const regional = useRegionalPresentation()
  return (
    <output aria-label='Regional context'>
      {regional.status} {regional.timezone} {regional.locale}
    </output>
  )
}

describe('regional presentation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses confirmed preferences and reacts to shared cache updates', async () => {
    vi.spyOn(coreApi, 'get').mockResolvedValue(preferences)
    const client = new QueryClient()
    const screen = await render(
      <QueryClientProvider client={client}>
        <RegionalPresentationProvider>
          <Probe />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )
    await expect
      .element(screen.getByLabelText('Regional context'))
      .toHaveTextContent('confirmed Asia/Tokyo ja-JP')
    await act(async () => {
      client.setQueryData(preferencesQueryKey, {
        ...preferences,
        timezone: 'America/New_York',
        locale: 'en-GB',
      })
    })
    await expect
      .element(screen.getByLabelText('Regional context'))
      .toHaveTextContent('confirmed America/New_York en-GB')
  })

  it('distinguishes unavailable preferences from confirmed defaults', async () => {
    vi.spyOn(coreApi, 'get').mockRejectedValue(new Error('Offline'))
    const client = new QueryClient()
    const screen = await render(
      <QueryClientProvider client={client}>
        <RegionalPresentationProvider>
          <Probe />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )
    const fallback = resolveRegionalPreferences({ timezone: null, locale: null })
    await expect
      .element(screen.getByLabelText('Regional context'))
      .toHaveTextContent(`unavailable ${fallback.timezone} ${fallback.locale}`)
  })
})
