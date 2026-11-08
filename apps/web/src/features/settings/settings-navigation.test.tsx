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
import { FontProvider } from '@/context/font-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { navigationGroups } from '@/components/layout/data/navigation-data'
import type { NavItem } from '@/components/layout/types'
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

describe('settings navigation and cleanup', () => {
  beforeEach(() => {
    clearCookies()
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

  it('replaces fixture settings forms with truthful unavailable states', async () => {
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <ProfileForm />
          <AccountForm />
          <NotificationsForm />
        </>
      ),
    })
    const route = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => null,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    const screen = await render(<RouterProvider router={router} />)

    await expect
      .element(screen.getByText(/not available in this workspace/i).first())
      .toBeInTheDocument()
    await expect.element(screen.getByText('Username')).not.toBeInTheDocument()
    await expect
      .element(screen.getByText('Date of birth'))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByText('Marketing emails'))
      .not.toBeInTheDocument()
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
