import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type AnyRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { routeTree } from '@/routeTree.gen'
import { Route as rootRoute } from '@/routes/__root'
import { Route as authenticatedRoute } from '@/routes/_authenticated/route'
import { clearCookies } from '@/test-utils/cookies'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'
import { DirectionProvider } from '@/context/direction-provider'
import { FontProvider } from '@/context/font-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import { toUserPresentation } from '@/components/layout/data/user-presentation'

const identity = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'fallback@example.test',
  displayName: 'Fallback User',
  globalRole: 'EMPLOYEE' as const,
  accountStatus: 'ACTIVE' as const,
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: false, unitIds: [] },
  session: {
    id: '22222222-2222-4222-8222-222222222222',
    clientType: 'WEB' as const,
    createdAt: '2026-01-01T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2027-01-01T00:00:00Z',
  },
}

const dashboard = {
  asOf: '2026-11-11T00:00:00Z',
  timezone: 'Asia/Ho_Chi_Minh',
  meetingCountsByState: { SCHEDULED: 2 },
  upcomingMeetings: [],
  recentMeetings: [],
  assignedActionItems: { open: 1, inProgress: 0, done: 0, overdue: 0 },
}

const emptyMeetingList = {
  data: [],
  meta: {
    pagination: {
      page: 0,
      size: 100,
      totalElements: 0,
      totalPages: 0,
      hasNext: false,
      hasPrevious: false,
    },
  },
}

vi.mock('react-top-loading-bar', () => ({
  default: () => null,
}))

type FailureFixture = {
  active: boolean
  message: string
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
}

function TestProviders({
  children,
  queryClient,
}: {
  children: React.ReactNode
  queryClient: QueryClient
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <FontProvider>
          <DirectionProvider>{children}</DirectionProvider>
        </FontProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

async function renderRouter(
  router: AnyRouter,
  queryClient: QueryClient,
  width = 1280,
  height = 800
) {
  await page.viewport(width, height)

  return render(
    <TestProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </TestProviders>
  )
}

function createGeneratedRouter(
  initialEntries: string[],
  initialIndex = initialEntries.length - 1
) {
  const queryClient = createQueryClient()
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries, initialIndex }),
  })

  return { queryClient, router }
}

function createTestRootRoute() {
  return createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: rootRoute.options.component,
    errorComponent: rootRoute.options.errorComponent,
    notFoundComponent: rootRoute.options.notFoundComponent,
  })
}

function createAuthenticatedFailureRouter(failure: FailureFixture) {
  const queryClient = createQueryClient()
  const testRootRoute = createTestRootRoute()
  const testAuthenticatedRoute = createRoute({
    getParentRoute: () => testRootRoute,
    id: '/_authenticated',
    beforeLoad: authenticatedRoute.options.beforeLoad,
    pendingComponent: authenticatedRoute.options.pendingComponent,
    shouldReload: authenticatedRoute.options.shouldReload,
    component: () => (
      <AuthenticatedLayout user={toUserPresentation(identity)} />
    ),
    errorComponent: authenticatedRoute.options.errorComponent,
    notFoundComponent: authenticatedRoute.options.notFoundComponent,
  })
  const failingRoute = createRoute({
    getParentRoute: () => testAuthenticatedRoute,
    path: '/authenticated-failure',
    loader: () => {
      if (failure.active) throw new Error(failure.message)
    },
    component: () => <p>Recovered authenticated descendant</p>,
  })
  const routeTree = testRootRoute.addChildren([
    testAuthenticatedRoute.addChildren([failingRoute]),
  ])
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({
      initialEntries: ['/authenticated-failure'],
    }),
  })

  return { queryClient, router }
}

function createRootFailureRouter(failure: FailureFixture) {
  const queryClient = createQueryClient()
  const testRootRoute = createTestRootRoute()
  const failingRoute = createRoute({
    getParentRoute: () => testRootRoute,
    path: '/root-failure',
    loader: () => {
      if (failure.active) throw new Error(failure.message)
    },
    component: () => <p>Recovered root descendant</p>,
  })
  const routeTree = testRootRoute.addChildren([failingRoute])
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ['/root-failure'] }),
  })

  return { queryClient, router }
}

describe('router fallback integration', () => {
  beforeEach(() => {
    clearCookies()
    vi.restoreAllMocks()
    vi.spyOn(coreApi, 'get').mockImplementation((url) => {
      if (url === '/auth/me') return Promise.resolve(identity) as never
      if (url === '/dashboard/me') return Promise.resolve(dashboard) as never
      return Promise.reject(new Error('Unexpected GET: ' + url)) as never
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation((url) => {
      if (url === '/meetings') return Promise.resolve(emptyMeetingList) as never
      return Promise.reject(new Error('Unexpected GET with meta: ' + url)) as never
    })
  })

  it('uses the authenticated not-found boundary for nested deep links', async () => {
    const { queryClient, router } = createGeneratedRouter([
      '/settings/unknown-section',
    ])
    const screen = await renderRouter(router, queryClient)

    await expect
      .element(screen.getByText('404', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Page not found', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('/settings/unknown-section', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText(/Oops! Something went wrong/i))
      .not.toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'SME Meeting Assistant home' }).all()
    ).toHaveLength(1)
    expect(
      screen.getByRole('navigation', { name: 'Primary navigation' }).all()
    ).toHaveLength(1)
    expect(screen.getByRole('main').all()).toHaveLength(1)
    await expect
      .element(screen.getByRole('main'))
      .toHaveAttribute('id', 'content')
    await expect
      .element(screen.getByRole('button', { name: 'Go Back' }))
      .toBeDisabled()

    await userEvent.click(
      screen.getByRole('button', { name: 'Go to Dashboard' })
    )
    await expect.poll(() => router.history.location.pathname).toBe('/')
    await expect
      .element(screen.getByRole('heading', { name: 'Dashboard', exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Scheduled meetings'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('No upcoming meetings'))
      .toBeInTheDocument()
  })

  it('uses the root not-found boundary for unknown top-level paths', async () => {
    const { queryClient, router } = createGeneratedRouter([
      '/top-level-does-not-exist',
    ])
    const screen = await renderRouter(router, queryClient)

    await expect
      .element(screen.getByText('404', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('/top-level-does-not-exist', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('link', { name: 'SME Meeting Assistant home' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('navigation', { name: 'Primary navigation' }))
      .not.toBeInTheDocument()
    await expect.element(screen.getByRole('main')).not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Go Back' }))
      .toBeDisabled()

    await userEvent.click(
      screen.getByRole('button', { name: 'Go to Dashboard' })
    )
    await expect.poll(() => router.history.location.pathname).toBe('/')
    await expect
      .element(screen.getByRole('heading', { name: 'Dashboard', exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Scheduled meetings'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('No upcoming meetings'))
      .toBeInTheDocument()
  })

  it('preserves mobile shell navigation and history recovery for authenticated 404s', async () => {
    const { queryClient, router } = createGeneratedRouter(
      ['/calendar', '/settings/unknown-section'],
      1
    )
    const screen = await renderRouter(router, queryClient, 390, 844)

    await expect
      .element(screen.getByRole('button', { name: 'Go Back' }))
      .not.toBeDisabled()

    await userEvent.click(
      screen.getByRole('banner').getByRole('button', { name: 'Toggle Sidebar' })
    )
    const drawer = screen.getByRole('dialog', { name: 'Sidebar' })
    await expect
      .element(drawer.getByRole('navigation', { name: 'Primary navigation' }))
      .toBeInTheDocument()
    await userEvent.click(
      drawer.getByRole('button', { name: 'Toggle Sidebar' }).first()
    )
    await expect.element(drawer).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Go Back' }))
    await expect.poll(() => router.history.location.pathname).toBe('/calendar')
    await expect
      .element(screen.getByRole('heading', { name: 'Calendar' }))
      .toBeInTheDocument()
  })

  it('routes authenticated loader errors through the authenticated error boundary', async () => {
    const failure = {
      active: true,
      message: 'sensitive authenticated fixture failure',
    }
    const { queryClient, router } = createAuthenticatedFailureRouter(failure)
    const screen = await renderRouter(router, queryClient)

    await expect
      .element(screen.getByText('500', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText(/Oops! Something went wrong/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Page not found'))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByText(failure.message))
      .not.toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'SME Meeting Assistant home' }).all()
    ).toHaveLength(1)
    expect(
      screen.getByRole('navigation', { name: 'Primary navigation' }).all()
    ).toHaveLength(1)
    expect(screen.getByRole('main').all()).toHaveLength(1)
    await expect
      .element(screen.getByRole('main'))
      .toHaveAttribute('id', 'content')

    failure.active = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await expect
      .element(screen.getByText('Recovered authenticated descendant'))
      .toBeInTheDocument()
    await expect
      .poll(() => router.history.location.pathname)
      .toBe('/authenticated-failure')
  })

  it('routes root loader errors through the root error boundary and retries cleanly', async () => {
    const failure = {
      active: true,
      message: 'sensitive root fixture failure',
    }
    const { queryClient, router } = createRootFailureRouter(failure)
    const screen = await renderRouter(router, queryClient)

    await expect
      .element(screen.getByText('500', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText(/Oops! Something went wrong/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Page not found'))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByText(failure.message))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('link', { name: 'SME Meeting Assistant home' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('navigation', { name: 'Primary navigation' }))
      .not.toBeInTheDocument()
    await expect.element(screen.getByRole('main')).not.toBeInTheDocument()

    failure.active = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await expect
      .element(screen.getByText('Recovered root descendant'))
      .toBeInTheDocument()
    await expect
      .poll(() => router.history.location.pathname)
      .toBe('/root-failure')
  })
})
