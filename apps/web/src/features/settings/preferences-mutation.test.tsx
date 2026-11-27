import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'
import {
  beginRequestRecoveryLogout,
  resetRequestRecoveryState,
} from '@/lib/request-recovery'
import {
  preferencesMutationInput,
  preferencesQueryKey,
  usePreferencesMutation,
  type Preferences,
  type PreferencesPatch,
} from './preferences-api'

const defaults: Preferences = {
  timezone: null,
  locale: null,
  meetingEmailEnabled: true,
  actionItemEmailEnabled: true,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function SaveButton({
  label,
  patch,
}: {
  label: string
  patch: PreferencesPatch
}) {
  const mutation = usePreferencesMutation()
  return (
    <button
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(preferencesMutationInput(patch))}
    >
      {label}
    </button>
  )
}

describe('shared preferences mutation lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetRequestRecoveryState()
  })

  it('serializes disjoint writes and preserves the confirmed snapshot', async () => {
    const first = deferred<Preferences>()
    const afterRegion = { ...defaults, timezone: 'Asia/Tokyo' }
    const afterBoth = { ...afterRegion, meetingEmailEnabled: false }
    const patch = vi
      .spyOn(coreApi, 'patch')
      .mockImplementationOnce(() => first.promise as never)
      .mockResolvedValueOnce(afterBoth)
    const client = new QueryClient()
    client.setQueryData(preferencesQueryKey, defaults)
    const screen = await render(
      <QueryClientProvider client={client}>
        <SaveButton label='Save region' patch={{ timezone: 'Asia/Tokyo' }} />
        <SaveButton
          label='Save notifications'
          patch={{ meetingEmailEnabled: false }}
        />
      </QueryClientProvider>
    )

    await userEvent.click(screen.getByRole('button', { name: 'Save region' }))
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    await userEvent.click(
      screen.getByRole('button', { name: 'Save notifications' })
    )
    expect(patch).toHaveBeenCalledTimes(1)
    first.resolve(afterRegion)
    await expect
      .element(screen.getByRole('button', { name: 'Save notifications' }))
      .toBeEnabled()
    expect(patch).toHaveBeenNthCalledWith(1, '/me/preferences', {
      timezone: 'Asia/Tokyo',
    })
    expect(patch).toHaveBeenNthCalledWith(2, '/me/preferences', {
      meetingEmailEnabled: false,
    })
    expect(client.getQueryData(preferencesQueryKey)).toEqual(afterBoth)
  })

  it('does not write a response from an earlier session into a new cache', async () => {
    const pending = deferred<Preferences>()
    const patch = vi
      .spyOn(coreApi, 'patch')
      .mockImplementationOnce(() => pending.promise as never)
    const client = new QueryClient()
    const screen = await render(
      <QueryClientProvider client={client}>
        <SaveButton label='Save region' patch={{ timezone: 'Asia/Tokyo' }} />
      </QueryClientProvider>
    )

    await userEvent.click(screen.getByRole('button', { name: 'Save region' }))
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    beginRequestRecoveryLogout()
    client.removeQueries()
    client.getMutationCache().clear()
    resetRequestRecoveryState()
    const nextUser = { ...defaults, locale: 'vi-VN' }
    client.setQueryData(preferencesQueryKey, nextUser)

    pending.resolve({ ...defaults, timezone: 'Asia/Tokyo' })
    await expect
      .element(screen.getByRole('button', { name: 'Save region' }))
      .toBeEnabled()
    expect(client.getQueryData(preferencesQueryKey)).toEqual(nextUser)
  })
})
