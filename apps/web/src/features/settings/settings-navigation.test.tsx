import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  isRedirect,
  RouterProvider,
} from '@tanstack/react-router'
import { Route as displayRoute } from '@/routes/_authenticated/settings/display'
import { clearCookies } from '@/test-utils/cookies'
import { Bell, Palette, UserCog, Wrench } from 'lucide-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { getCookie } from '@/lib/cookies'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  beginRequestRecoveryLogout,
  resetRequestRecoveryState,
} from '@/lib/request-recovery'
import { FontProvider } from '@/context/font-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { navigationGroups } from '@/components/layout/data/navigation-data'
import type { NavItem } from '@/components/layout/types'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import { AccountForm } from './account/account-form'
import { AppearanceForm } from './appearance/appearance-form'
import { SidebarNav } from './components/sidebar-nav'
import { NotificationsForm } from './notifications/notifications-form'
import { preferencesQueryKey } from './preferences-api'
import { profileQueryKey } from './profile/profile-api'
import { ProfileForm } from './profile/profile-form'

const showSubmittedData = vi.hoisted(() => vi.fn())

vi.mock('@/lib/show-submitted-data', () => ({ showSubmittedData }))

const settingsItems = [
  { title: 'Profile', href: '/settings', icon: <UserCog size={18} /> },
  { title: 'Account', href: '/settings/account', icon: <Wrench size={18} /> },
  {
    title: 'Appearance',
    href: '/settings/appearance',
    icon: <Palette size={18} />,
  },
  {
    title: 'Notifications',
    href: '/settings/notifications',
    icon: <Bell size={18} />,
  },
] as const

function createSettingsRouter(initialPath: string) {
  const rootRoute = createRootRoute({
    component: () => <SidebarNav items={[...settingsItems]} />,
  })
  const paths = [
    '/settings',
    '/settings/account',
    '/settings/appearance',
    '/settings/notifications',
  ]
  const routeTree = rootRoute.addChildren(
    paths.map((path) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        component: () => null,
      })
    )
  )

  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
}

const profile = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'employee@example.com',
  displayName: 'Employee One',
  globalRole: 'EMPLOYEE' as const,
  accountStatus: 'ACTIVE' as const,
  primaryOrgUnitId: null,
}

const preferences = {
  timezone: 'Asia/Ho_Chi_Minh',
  locale: 'vi-VN',
  meetingEmailEnabled: true,
  actionItemEmailEnabled: false,
}

function mockSettingsReads() {
  vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
    data: profile,
    etag: '"profile-v1"',
    meta: {},
  })
  return vi.spyOn(coreApi, 'get').mockImplementation((url) => {
    if (url === '/me/preferences') return Promise.resolve(preferences) as never
    return Promise.reject(new Error('Unexpected GET: ' + url)) as never
  })
}

async function renderApiSettings(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 10_000 },
      mutations: { retry: false },
    },
  })
  const screen = await render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { screen, queryClient }
}

describe('settings navigation and cleanup', () => {
  beforeEach(() => {
    clearCookies()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    resetRequestRecoveryState()
  })

  it('exposes supported settings destinations without legacy template routes', () => {
    const allItems = navigationGroups.reduce<NavItem[]>((items, group) => {
      items.push(...group.items)
      return items
    }, [])
    const settings = allItems.find((item) => item.title === 'Settings')
    const destinations = allItems.flatMap((item) => {
      if (item.items) return item.items.map((subItem) => subItem.url)
      return item.url ? [item.url] : []
    })

    expect(settings?.items?.map((item) => item.title)).toEqual([
      'Account',
      'Profile',
      'Appearance',
      'Notifications',
    ])
    expect(destinations).not.toContain('/apps')
    expect(destinations).not.toContain('/tasks')
  })

  it('synchronizes the mobile settings selector with direct route changes', async () => {
    await page.viewport(390, 844)
    const router = createSettingsRouter('/settings')
    const screen = await render(<RouterProvider router={router} />)
    const selector = screen.getByRole('combobox')

    await expect.element(selector).toHaveTextContent('Profile')
    await userEvent.click(selector)
    await userEvent.click(screen.getByRole('option', { name: 'Account' }))
    await expect
      .poll(() => router.history.location.pathname)
      .toBe('/settings/account')
    await expect.element(selector).toHaveTextContent('Account')

    await router.navigate({ to: '/settings/account' })
    await expect.element(selector).toHaveTextContent('Account')
    await router.navigate({ to: '/settings/notifications' })
    await expect.element(selector).toHaveTextContent('Notifications')
  })

  it('redirects the removed Display deep link to Appearance', () => {
    const beforeLoad = displayRoute.options.beforeLoad as
      | (() => never)
      | undefined
    let redirect: unknown

    try {
      beforeLoad?.()
    } catch (error) {
      redirect = error
    }

    expect(isRedirect(redirect)).toBe(true)
    expect((redirect as { options: { to: string } }).options.to).toBe(
      '/settings/appearance'
    )
  })

  it('loads profile and preferences from the Core API instead of fixture fields', async () => {
    const get = mockSettingsReads()
    const { screen } = await renderApiSettings(
      <>
        <ProfileForm />
        <AccountForm />
        <NotificationsForm />
      </>
    )

    await expect
      .element(screen.getByRole('textbox', { name: 'Display name' }))
      .toHaveValue('Employee One')
    await expect
      .element(screen.getByRole('textbox', { name: 'Organization email' }))
      .toHaveValue('employee@example.com')
    await expect
      .element(screen.getByRole('combobox', { name: 'Time zone' }))
      .toHaveTextContent('Asia/Ho Chi Minh')
    await expect
      .element(screen.getByRole('combobox', { name: 'Regional format' }))
      .toHaveTextContent('vi-VN')
    await expect
      .element(screen.getByRole('switch', { name: 'Meeting emails' }))
      .toHaveAttribute('aria-checked', 'true')
    await expect
      .element(screen.getByRole('switch', { name: 'Action item emails' }))
      .toHaveAttribute('aria-checked', 'false')
    expect(coreApi.getWithMetaAndEtag).toHaveBeenCalledWith(
      '/me/profile',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(get.mock.calls.map(([url]) => url)).toContain('/me/preferences')
    await expect.element(screen.getByText('Username')).not.toBeInTheDocument()
    await expect
      .element(screen.getByText('Date of birth'))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByText('Marketing emails'))
      .not.toBeInTheDocument()
  })

  it('saves profile changes through the API and invalidates identity data', async () => {
    mockSettingsReads()
    const patch = vi.spyOn(coreApi, 'patchWithMetaAndEtag')
    patch.mockImplementation((url, value) => {
      if (url === '/me/profile') {
        return Promise.resolve({
          data: {
            ...profile,
            displayName: (value as { displayName: string }).displayName,
          },
          etag: '"profile-v2"',
          meta: {},
        }) as never
      }
      return Promise.reject(new Error('Unexpected PATCH: ' + url)) as never
    })
    const { screen, queryClient } = await renderApiSettings(<ProfileForm />)
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const name = screen.getByRole('textbox', { name: 'Display name' })
    const save = screen.getByRole('button', { name: 'Save profile' })

    await expect.element(name).toHaveValue(profile.displayName)
    await expect.element(save).toBeDisabled()
    await userEvent.fill(name, 'Updated Employee')
    await expect.element(save).toBeEnabled()
    await userEvent.click(save)

    await vi.waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        '/me/profile',
        { displayName: 'Updated Employee' },
        { headers: { 'If-Match': '"profile-v1"' } }
      )
    )
    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: currentUserQueryKey,
      })
    )
    expect(showSubmittedData).not.toHaveBeenCalled()
  })

  it('preserves a dirty profile and requires review after a stale update', async () => {
    const read = vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: profile,
      etag: '"profile-v1"',
      meta: {},
    })
    const latest = { ...profile, displayName: 'Changed elsewhere' }
    const patch = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockImplementationOnce(async () => {
        read.mockResolvedValue({
          data: latest,
          etag: '"profile-v2"',
          meta: {},
        })
        throw new CoreApiError({
          message: 'Stale profile',
          status: 412,
          kind: 'http',
        })
      })
      .mockResolvedValueOnce({
        data: { ...profile, displayName: 'My draft' },
        etag: '"profile-v3"',
        meta: {},
      })
    const { screen } = await renderApiSettings(<ProfileForm />)
    const name = screen.getByRole('textbox', { name: 'Display name' })
    const save = screen.getByRole('button', { name: 'Save profile' })
    await expect.element(name).toHaveValue(profile.displayName)
    await userEvent.fill(name, 'My draft')
    await userEvent.click(save)
    await expect.element(name).toHaveValue('My draft')
    await expect
      .element(screen.getByText('Latest retrieved name: Changed elsewhere'))
      .toBeVisible()
    await expect.element(save).toBeDisabled()
    expect(patch).toHaveBeenCalledTimes(1)
    await userEvent.click(
      screen.getByRole('button', { name: 'Keep my draft against this version' })
    )
    await expect.element(save).toBeEnabled()
    await userEvent.click(save)
    await vi.waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith(
        '/me/profile',
        { displayName: 'My draft' },
        { headers: { 'If-Match': '"profile-v2"' } }
      )
    )
  })

  it('persists account preferences and notification switches through the API', async () => {
    const get = mockSettingsReads()
    let saved = { ...preferences }
    get.mockImplementation(() => Promise.resolve(saved) as never)
    const patch = vi.spyOn(coreApi, 'patch')
    patch.mockImplementation((url, value) => {
      if (url === '/me/preferences') {
        saved = { ...saved, ...(value as object) }
        return Promise.resolve(saved) as never
      }
      return Promise.reject(new Error('Unexpected PATCH: ' + url)) as never
    })
    const { screen, queryClient } = await renderApiSettings(
      <>
        <AccountForm />
        <NotificationsForm />
      </>
    )
    const locale = screen.getByRole('combobox', { name: 'Regional format' })

    await expect.element(locale).toHaveTextContent('vi-VN')
    await userEvent.click(locale)
    await userEvent.click(screen.getByRole('option', { name: /en-US/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Save preferences' })
    )
    await vi.waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/preferences', {
        locale: 'en-US',
      })
    )
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(['me', 'preferences'])).toMatchObject({
        locale: 'en-US',
      })
    )

    const actionEmails = screen.getByRole('switch', {
      name: 'Action item emails',
    })
    await expect.element(actionEmails).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(actionEmails)
    await vi.waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/preferences', {
        actionItemEmailEnabled: true,
      })
    )
    await expect.element(actionEmails).toHaveAttribute('aria-checked', 'true')
    expect(showSubmittedData).not.toHaveBeenCalled()
  })

  it('preserves the reviewed ETag when a dirty profile is refreshed', async () => {
    mockSettingsReads()
    const patch = vi.spyOn(coreApi, 'patchWithMetaAndEtag')
    const { screen, queryClient } = await renderApiSettings(<ProfileForm />)
    const name = screen.getByRole('textbox', { name: 'Display name' })
    const save = screen.getByRole('button', { name: 'Save profile' })

    await expect.element(name).toHaveValue(profile.displayName)
    await userEvent.fill(name, 'My draft')
    queryClient.setQueryData(profileQueryKey, {
      profile: { ...profile, displayName: 'Remote edit' },
      etag: '"profile-v2"',
    })
    await expect.element(name).toHaveValue('My draft')
    await expect.element(save).toBeDisabled()
    await expect
      .element(screen.getByText('Latest retrieved name: Remote edit'))
      .toBeVisible()
    expect(patch).not.toHaveBeenCalled()
  })

  it.each([428, 503])(
    'requires review after a profile update returns %i',
    async (status) => {
      mockSettingsReads()
      const patch = vi
        .spyOn(coreApi, 'patchWithMetaAndEtag')
        .mockRejectedValue(
          new CoreApiError({
            message: 'Update could not be confirmed',
            status,
            kind: status === 503 ? 'server' : 'http',
          })
        )
      const { screen } = await renderApiSettings(<ProfileForm />)
      const name = screen.getByRole('textbox', { name: 'Display name' })
      const save = screen.getByRole('button', { name: 'Save profile' })

      await expect.element(name).toHaveValue(profile.displayName)
      await userEvent.fill(name, 'Unconfirmed draft')
      await userEvent.click(save)
      await expect
        .element(
          screen.getByRole('button', {
            name: 'Keep my draft against this version',
          })
        )
        .toBeEnabled()
      await expect.element(name).toHaveValue('Unconfirmed draft')
      await expect.element(save).toBeDisabled()
      expect(patch).toHaveBeenCalledTimes(1)
    }
  )

  it('clears a converged Account draft and follows later server updates', async () => {
    mockSettingsReads()
    const { screen, queryClient } = await renderApiSettings(<AccountForm />)
    const locale = screen.getByRole('combobox', { name: 'Regional format' })
    const save = screen.getByRole('button', { name: 'Save preferences' })

    await expect.element(locale).toHaveTextContent('vi-VN')
    await userEvent.click(locale)
    await userEvent.click(screen.getByRole('option', { name: /en-US/ }))
    await expect.element(save).toBeEnabled()
    queryClient.setQueryData(preferencesQueryKey, {
      ...preferences,
      locale: 'en-US',
      timezone: 'Asia/Tokyo',
    })
    await expect.element(save).toBeDisabled()
    await expect
      .element(screen.getByRole('combobox', { name: 'Time zone' }))
      .toHaveTextContent('Asia/Tokyo')

    queryClient.setQueryData(preferencesQueryKey, {
      ...preferences,
      locale: 'ja-JP',
      timezone: 'Asia/Tokyo',
    })
    await expect.element(locale).toHaveTextContent('ja-JP')
    await expect.element(save).toBeDisabled()
  })

  it('clears a timezone using the keyboard-accessible regional picker', async () => {
    const get = mockSettingsReads()
    const saved = { ...preferences, timezone: null }
    const patch = vi.spyOn(coreApi, 'patch').mockImplementation(async () => {
      get.mockResolvedValue(saved)
      return saved as never
    })
    const { screen } = await renderApiSettings(<AccountForm />)
    const timezone = screen.getByRole('combobox', { name: 'Time zone' })
    await expect.element(timezone).toHaveTextContent('Asia/Ho Chi Minh')
    await userEvent.click(timezone)
    await expect
      .element(screen.getByRole('dialog', { name: 'Time zone options' }))
      .toBeVisible()
    const search = screen.getByRole('combobox', { name: 'Search time zone' })
    await userEvent.fill(search, 'browser default')
    await expect
      .element(screen.getByRole('option', { name: 'Use browser default' }))
      .toBeVisible()
    await userEvent.keyboard('{Enter}')
    await expect.element(timezone).toHaveTextContent('Use browser default')
    await expect.element(timezone).toHaveFocus()
    await userEvent.click(
      screen.getByRole('button', { name: 'Save preferences' })
    )
    await vi.waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/preferences', { timezone: null })
    )
  })

  it('reconciles an uncertain Account save without replaying it', async () => {
    const get = mockSettingsReads()
    const patch = vi.spyOn(coreApi, 'patch').mockImplementation(async () => {
      get.mockResolvedValue({ ...preferences, locale: 'en-US' })
      throw new CoreApiError({ message: 'Connection lost', kind: 'network' })
    })
    const { screen } = await renderApiSettings(<AccountForm />)
    const locale = screen.getByRole('combobox', { name: 'Regional format' })
    const save = screen.getByRole('button', { name: 'Save preferences' })
    await expect.element(locale).toHaveTextContent('vi-VN')
    await userEvent.click(locale)
    await userEvent.click(screen.getByRole('option', { name: /en-US/ }))
    await userEvent.click(save)
    const refresh = screen.getByRole('button', {
      name: 'Refresh saved preferences',
    })
    await expect.element(refresh).toBeEnabled()
    await expect.element(save).toBeDisabled()
    await userEvent.click(refresh)
    await expect.element(refresh).not.toBeInTheDocument()
    await expect.element(locale).toHaveTextContent('en-US')
    await expect.element(save).toBeDisabled()
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it('does not begin profile recovery reads after a session boundary', async () => {
    mockSettingsReads()
    const get = vi.mocked(coreApi.getWithMetaAndEtag)
    vi.spyOn(coreApi, 'patchWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({ message: 'Stale profile', status: 412, kind: 'http' })
    )
    const { screen, queryClient } = await renderApiSettings(<ProfileForm />)
    const name = screen.getByRole('textbox', { name: 'Display name' })
    const save = screen.getByRole('button', { name: 'Save profile' })
    await expect.element(name).toHaveValue(profile.displayName)
    const cancel = queryClient.cancelQueries.bind(queryClient)
    const cancellation = vi
      .spyOn(queryClient, 'cancelQueries')
      .mockImplementationOnce(cancel)
      .mockImplementationOnce(async (filters, options) => {
        await cancel(filters, options)
        beginRequestRecoveryLogout()
        resetRequestRecoveryState()
      })

    await userEvent.fill(name, 'My draft')
    await userEvent.click(save)
    await vi.waitFor(() => expect(cancellation).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0))
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('does not begin Account recovery reads after a session boundary', async () => {
    const get = mockSettingsReads()
    vi.spyOn(coreApi, 'patch').mockRejectedValue(
      new CoreApiError({ message: 'Connection lost', kind: 'network' })
    )
    const { screen, queryClient } = await renderApiSettings(<AccountForm />)
    const locale = screen.getByRole('combobox', { name: 'Regional format' })
    await expect.element(locale).toHaveTextContent('vi-VN')
    await userEvent.click(locale)
    await userEvent.click(screen.getByRole('option', { name: /en-US/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Save preferences' })
    )
    const refresh = screen.getByRole('button', {
      name: 'Refresh saved preferences',
    })
    await expect.element(refresh).toBeEnabled()
    const readsBeforeRecovery = get.mock.calls.length
    const cancel = queryClient.cancelQueries.bind(queryClient)
    const cancellation = vi
      .spyOn(queryClient, 'cancelQueries')
      .mockImplementationOnce(async (filters, options) => {
        await cancel(filters, options)
        beginRequestRecoveryLogout()
        resetRequestRecoveryState()
      })

    await userEvent.click(refresh)
    await vi.waitFor(() => expect(cancellation).toHaveBeenCalledTimes(1))
    await expect.element(refresh).toBeEnabled()
    expect(get).toHaveBeenCalledTimes(readsBeforeRecovery)
  })

  it('ignores a profile mutation response from a previous session', async () => {
    mockSettingsReads()
    const nextProfile = {
      ...profile,
      id: '22222222-2222-4222-8222-222222222222',
      displayName: 'Next user',
    }
    let finish!: (value: {
      data: typeof profile
      etag: string
      meta: Record<string, never>
    }) => void
    const pending = new Promise<{
      data: typeof profile
      etag: string
      meta: Record<string, never>
    }>((resolve) => {
      finish = resolve
    })
    const patch = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockImplementationOnce(() => pending as never)
    const { screen, queryClient } = await renderApiSettings(<ProfileForm />)
    const name = screen.getByRole('textbox', { name: 'Display name' })
    await expect.element(name).toHaveValue(profile.displayName)
    await userEvent.fill(name, 'Previous user draft')
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1))

    const oldMutation = queryClient.getMutationCache().getAll()[0]
    if (!oldMutation) throw new Error('Expected a pending profile update')
    vi.mocked(coreApi.getWithMetaAndEtag).mockResolvedValue({
      data: nextProfile,
      etag: '"next-v1"',
      meta: {},
    })
    beginRequestRecoveryLogout()
    queryClient.removeQueries()
    queryClient.getMutationCache().clear()
    resetRequestRecoveryState()
    const nextSnapshot = { profile: nextProfile, etag: '"next-v1"' }
    queryClient.setQueryData(profileQueryKey, nextSnapshot)
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    finish({
      data: { ...profile, displayName: 'Previous user draft' },
      etag: '"profile-v2"',
      meta: {},
    })

    await vi.waitFor(() => expect(oldMutation.state.status).toBe('success'))
    await expect.element(name).toHaveValue('Next user')
    expect(queryClient.getQueryData(profileQueryKey)).toEqual(nextSnapshot)
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: currentUserQueryKey,
    })
  })

  it('shows an API failure and supports a real retry instead of hiding it', async () => {
    const get = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({
          message: 'Profile service unavailable',
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          kind: 'server',
        })
      )
      .mockResolvedValueOnce({ data: profile, etag: '"profile-v1"', meta: {} })
    const { screen } = await renderApiSettings(<ProfileForm />)

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('Profile service unavailable')
    await expect
      .element(screen.getByRole('textbox', { name: 'Display name' }))
      .not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await expect
      .element(screen.getByRole('textbox', { name: 'Display name' }))
      .toHaveValue(profile.displayName)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('preserves local Appearance preferences without generic submission messaging', async () => {
    const screen = await render(
      <ThemeProvider>
        <FontProvider>
          <AppearanceForm />
        </FontProvider>
      </ThemeProvider>
    )

    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    await userEvent.selectOptions(screen.getByRole('combobox'), 'manrope')
    await userEvent.click(
      screen.getByRole('button', { name: 'Update preferences' })
    )

    expect(getCookie('vite-ui-theme')).toBe('dark')
    expect(getCookie('font')).toBe('manrope')
    expect(showSubmittedData).not.toHaveBeenCalled()
  })

  it('keeps theme previews and labels stacked', async () => {
    const screen = await render(
      <ThemeProvider>
        <FontProvider>
          <AppearanceForm />
        </FontProvider>
      </ThemeProvider>
    )

    for (const label of ['Light', 'Dark', 'System']) {
      const labelElement = screen
        .getByText(label, { exact: true })
        .element()
        .closest('label')

      expect(labelElement).not.toBeNull()
      expect(labelElement).toHaveClass('flex-col')
    }

    expect(
      document.querySelector('[data-name="icon-theme-system"]')
    ).not.toBeNull()
  })
})
