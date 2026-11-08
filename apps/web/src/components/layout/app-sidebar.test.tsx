import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { LayoutProvider } from '@/context/layout-provider'
import { clearCookies } from '@/test-utils/cookies'
import { SkipToMain } from '@/components/skip-to-main'
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { Main } from './main'

function TestShell() {
  return (
    <LayoutProvider>
      <SidebarProvider defaultOpen>
        <SkipToMain />
        <SidebarTrigger aria-label='Open navigation' />
        <AppSidebar />
        <SidebarInset>
          <Main>
            <Outlet />
          </Main>
        </SidebarInset>
      </SidebarProvider>
    </LayoutProvider>
  )
}

function MeetingLivePage() {
  return (
    <>
      <span>Live meeting page</span>
      <Link to='/calendar'>Go to Calendar</Link>
    </>
  )
}

function createTestRouter(initialPath: string) {
  const rootRoute = createRootRoute({ component: TestShell })
  const route = (path: string, text: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => <span>{text}</span>,
    })
  const routeTree = rootRoute.addChildren([
    route('/', 'Dashboard page'),
    route('/meetings', 'Meetings page'),
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/meetings/$meetingId',
      component: () => <span>Meeting detail page</span>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/meetings/$meetingId/live',
      component: MeetingLivePage,
    }),
    route('/calendar', 'Calendar page'),
    route('/action-items', 'Action Items page'),
    route('/assistant', 'AI Assistant page'),
    route('/rooms', 'Meeting Rooms page'),
    route('/members', 'Members page'),
    route('/settings', 'Profile page'),
    route('/settings/account', 'Account page'),
    route('/settings/appearance', 'Appearance page'),
    route('/settings/notifications', 'Notifications page'),
    route('/help-center', 'Help Center page'),
  ])
  const history = createMemoryHistory({ initialEntries: [initialPath] })
  return createRouter({ routeTree, history })
}

async function renderApp(initialPath: string, mobile = false) {
  await page.viewport(mobile ? 390 : 1280, mobile ? 844 : 800)
  const router = createTestRouter(initialPath)
  const screen = await render(<RouterProvider router={router} />)
  return { screen, router }
}

describe('AppSidebar navigation', () => {
  beforeEach(() => {
    clearCookies()
  })

  it('tracks nested meeting routes through link navigation and browser history', async () => {
    const { screen, router } = await renderApp('/meetings/meeting-42/live')

    const meetingsLink = screen.getByRole('link', { name: 'Meetings' })
    await expect.element(meetingsLink).toHaveAttribute('aria-current', 'page')
    await expect.element(screen.getByText('Live meeting page')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('link', { name: 'Go to Calendar' }))
    await expect.element(screen.getByText('Calendar page')).toBeInTheDocument()
    await expect
      .element(screen.getByRole('link', { name: 'Calendar' }))
      .toHaveAttribute('aria-current', 'page')
    await expect.element(meetingsLink).not.toHaveAttribute('aria-current', 'page')

    router.history.back()
    await expect.element(screen.getByText('Live meeting page')).toBeInTheDocument()
    await expect.element(meetingsLink).toHaveAttribute('aria-current', 'page')

    router.history.forward()
    await expect.element(screen.getByText('Calendar page')).toBeInTheDocument()
    await expect
      .element(screen.getByRole('link', { name: 'Calendar' }))
      .toHaveAttribute('aria-current', 'page')
  })

  it('selects and expands the correct nested Settings destination', async () => {
    const { screen } = await renderApp('/settings/account')

    await expect
      .element(screen.getByRole('link', { name: 'Account' }))
      .toHaveAttribute('aria-current', 'page')
    await expect
      .element(screen.getByRole('link', { name: 'Profile' }))
      .not.toHaveAttribute('aria-current', 'page')
    await expect
      .element(screen.getByRole('button', { name: /Settings/ }))
      .toHaveAttribute('aria-expanded', 'true')
  })

  it('closes the mobile drawer after navigation and keeps the destination selected', async () => {
    const { screen } = await renderApp('/meetings', true)

    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }))
    const drawer = screen.getByRole('dialog', { name: 'Sidebar' })
    await expect.element(drawer).toBeInTheDocument()

    await userEvent.click(drawer.getByRole('link', { name: 'Calendar' }))
    await expect.element(screen.getByText('Calendar page')).toBeInTheDocument()
    await expect.element(drawer).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }))
    await expect
      .element(screen.getByRole('link', { name: 'Calendar' }))
      .toHaveAttribute('aria-current', 'page')
  })

  it('preserves accessible desktop navigation while collapsing and expanding', async () => {
    const { screen } = await renderApp('/calendar')
    const brandLink = screen.getByRole('link', {
      name: 'SME Meeting Assistant home',
    })
    const sidebarHeader = brandLink
      .element()
      .closest('[data-sidebar="header"]')
    expect(sidebarHeader).not.toBeNull()
    const toggle = page
      .elementLocator(sidebarHeader!)
      .getByRole('button', { name: 'Toggle Sidebar' })

    await expect
      .poll(() =>
        document
          .querySelector('[data-slot="sidebar"][data-state]')
          ?.getAttribute('data-state')
      )
      .toBe('expanded')
    await userEvent.click(toggle)
    await expect
      .poll(() =>
        document
          .querySelector('[data-slot="sidebar"][data-state]')
          ?.getAttribute('data-state')
      )
      .toBe('collapsed')

    const meetingsLink = screen.getByRole('link', { name: 'Meetings' })
    await expect.element(meetingsLink).toBeInTheDocument()
    await userEvent.hover(meetingsLink)
    await expect.element(screen.getByRole('tooltip')).toHaveTextContent('Meetings')

    await userEvent.click(toggle)
    await expect
      .poll(() =>
        document
          .querySelector('[data-slot="sidebar"][data-state]')
          ?.getAttribute('data-state')
      )
      .toBe('expanded')
  })

  it('resolves the Skip to Main link to the focused shared main landmark', async () => {
    const { screen } = await renderApp('/calendar')
    const main = screen.getByRole('main')

    await expect.element(main).toHaveAttribute('id', 'content')
    await userEvent.click(screen.getByRole('link', { name: 'Skip to Main' }))
    await expect.poll(() => document.activeElement?.id).toBe('content')
  })

  it('renders the shared user presentation and account actions', async () => {
    const { screen } = await renderApp('/calendar')

    await expect.element(screen.getByText('Nguyễn Lan')).toBeInTheDocument()
    await expect.element(screen.getByText('lan.nguyen@sme.local')).toBeInTheDocument()
    await expect
      .element(screen.getByText('NL', { exact: true }))
      .toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Open user menu' }))
    const menu = screen.getByRole('menu')

    await expect
      .element(menu.getByRole('menuitem', { name: 'Profile' }))
      .toHaveAttribute('href', '/settings')
    await expect
      .element(menu.getByRole('menuitem', { name: 'Account' }))
      .toHaveAttribute('href', '/settings/account')
    await expect
      .element(menu.getByRole('menuitem', { name: 'Notifications' }))
      .toHaveAttribute('href', '/settings/notifications')
    await expect.element(menu.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument()
  })
})
