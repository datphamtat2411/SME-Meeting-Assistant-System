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
import { FontProvider } from '@/context/font-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { navigationGroups } from '@/components/layout/data/navigation-data'
import type { NavItem } from '@/components/layout/types'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import { AccountForm } from './account/account-form'
import { AppearanceForm } from './appearance/appearance-form'
import { SidebarNav } from './components/sidebar-nav'
import { NotificationsForm } from './notifications/notifications-form'
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
  return vi.spyOn(coreApi, 'get').mockImplementation((url) => {
    if (url === '/me/profile') return Promise.resolve(profile) as never
    if (url === '/me/preferences') return Promise.resolve(preferences) as never
    return Promise.reject(new Error('Unexpected GET: ' + url)) as never
  })
}

async function renderApiSettings(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
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
      .element(screen.getByRole('textbox', { name: 'IANA timezone' }))
      .toHaveValue('Asia/Ho_Chi_Minh')
    await expect
      .element(screen.getByRole('textbox', { name: 'Language / locale' }))
      .toHaveValue('vi-VN')
    await expect
      .element(screen.getByRole('switch', { name: 'Meeting emails' }))
      .toHaveAttribute('aria-checked', 'true')
    await expect
      .element(screen.getByRole('switch', { name: 'Action item emails' }))
      .toHaveAttribute('aria-checked', 'false')
    expect(get.mock.calls.map(([url]) => url)).toContain('/me/profile')
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
    const patch = vi.spyOn(coreApi, 'patch')
    patch.mockImplementation((url, value) => {
      if (url === '/me/profile') {
        return Promise.resolve({
          ...profile,
          displayName: (value as { displayName: string }).displayName,
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
      expect(patch).toHaveBeenCalledWith('/me/profile', {
        displayName: 'Updated Employee',
      })
    )
    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: currentUserQueryKey,
      })
    )
    expect(showSubmittedData).not.toHaveBeenCalled()
  })

  it('persists account preferences and notification switches through the API', async () => {
    mockSettingsReads()
    const patch = vi.spyOn(coreApi, 'patch')
    patch.mockImplementation((url, value) => {
      if (url === '/me/preferences') {
        return Promise.resolve({
          ...preferences,
          ...(value as object),
        }) as never
      }
      return Promise.reject(new Error('Unexpected PATCH: ' + url)) as never
    })
    const { screen, queryClient } = await renderApiSettings(
      <>
        <AccountForm />
        <NotificationsForm />
      </>
    )
    const locale = screen.getByRole('textbox', { name: 'Language / locale' })

    await expect.element(locale).toHaveValue('vi-VN')
    await userEvent.fill(locale, 'en-US')
    await userEvent.click(
      screen.getByRole('button', { name: 'Save preferences' })
    )
    await vi.waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/preferences', {
        timezone: 'Asia/Ho_Chi_Minh',
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

  it('shows an API failure and supports a real retry instead of hiding it', async () => {
    const get = vi
      .spyOn(coreApi, 'get')
      .mockRejectedValueOnce(
        new CoreApiError({
          message: 'Profile service unavailable',
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          kind: 'server',
        })
      )
      .mockResolvedValueOnce(profile as never)
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
