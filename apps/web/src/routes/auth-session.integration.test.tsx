import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { routeTree } from '@/routeTree.gen'
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { DirectionProvider } from '@/context/direction-provider'
import { FontProvider } from '@/context/font-provider'
import { ThemeProvider } from '@/context/theme-provider'
import {
  AUTH_LIFECYCLE_STORAGE_KEY,
  resetAuthLifecycleAfterSignIn,
} from '@/features/auth/session/auth-lifecycle'

vi.mock('react-top-loading-bar', () => ({
  default: () => null,
}))

const identity = {
  userId: '33333333-3333-4333-8333-333333333333',
  email: 'canonical@example.test',
  displayName: 'Canonical User',
  globalRole: 'EMPLOYEE' as const,
  accountStatus: 'ACTIVE' as const,
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: false, unitIds: [] },
  session: {
    id: '44444444-4444-4444-8444-444444444444',
    clientType: 'WEB' as const,
    createdAt: '2026-01-01T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2027-01-01T00:00:00Z',
  },
}

const apiError = (status: number, kind: 'http' | 'network' | 'server') =>
  new CoreApiError({
    message: `session check failed: ${status}`,
    status: status || undefined,
    code: status === 401 ? 'AUTH_REQUIRED' : 'AUTHZ_FORBIDDEN',
    kind,
  })

let getCurrentUser: MockInstance

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
}

async function renderRoute(initialPath: string) {
  await page.viewport(1280, 800)
  const queryClient = createQueryClient()
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })

  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <FontProvider>
          <DirectionProvider>
            <RouterProvider router={router} />
          </DirectionProvider>
        </FontProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )

  return { router, screen }
}

describe('session restoration and protected routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetAuthLifecycleAfterSignIn()
    getCurrentUser = vi.spyOn(coreApi, 'get')
    getCurrentUser.mockResolvedValue(identity as never)
  })

  it('renders the canonical shell identity after restoring a deep link', async () => {
    const { screen } = await renderRoute('/settings/account')

    await expect.element(screen.getByText('Canonical User')).toBeInTheDocument()
    await expect
      .element(screen.getByText('canonical@example.test'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('CU', { exact: true }).first())
      .toBeInTheDocument()
    await expect.element(screen.getByText('Nguyễn Lan')).not.toBeInTheDocument()
  })

  it('does not render protected descendants while identity validation is pending', async () => {
    let resolveIdentity: (value: typeof identity) => void = () => undefined
    getCurrentUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIdentity = resolve
        }) as never
    )

    const { screen } = await renderRoute('/calendar')

    await expect
      .element(screen.getByText('Checking your session'))
      .toBeInTheDocument()
    await expect.element(screen.getByText('Calendar')).not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('navigation', { name: 'Primary navigation' }))
      .not.toBeInTheDocument()

    resolveIdentity(identity)
    await expect.element(screen.getByText('Canonical User')).toBeInTheDocument()
  })

  it('redirects an unauthenticated deep link once with a safe internal return path', async () => {
    const unauthorized = apiError(401, 'http')
    getCurrentUser.mockRejectedValue(unauthorized)

    const { router, screen } = await renderRoute('/settings/account')

    await expect.poll(() => router.state.location.pathname).toBe('/sign-in')
    await expect
      .poll(() => router.state.location.search.redirect)
      .toBe('/settings/account')
    await expect
      .element(screen.getByRole('button', { name: 'Sign in' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Canonical User'))
      .not.toBeInTheDocument()
    expect(getCurrentUser).toHaveBeenCalledTimes(2)
  })

  it('renders denied without redirecting to sign-in for a 403 identity response', async () => {
    getCurrentUser.mockRejectedValue(apiError(403, 'http'))

    const { router, screen } = await renderRoute('/calendar')

    await expect.element(screen.getByText('Access denied')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/calendar')
    await expect
      .element(screen.getByRole('heading', { name: 'Sign in' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('navigation', { name: 'Primary navigation' }))
      .not.toBeInTheDocument()
  })

  it.each([
    ['network', apiError(0, 'network')],
    ['server', apiError(503, 'server')],
  ] as const)(
    'renders retryable unavailable for %s identity failures',
    async (_, error) => {
      getCurrentUser.mockRejectedValue(error)

      const { router, screen } = await renderRoute('/calendar')

      await expect
        .element(screen.getByText('Session temporarily unavailable'))
        .toBeInTheDocument()
      expect(router.state.location.pathname).toBe('/calendar')
      await expect
        .element(screen.getByRole('heading', { name: 'Sign in' }))
        .not.toBeInTheDocument()
    }
  )

  it('resets retryable recovery state before revalidating an unavailable session', async () => {
    getCurrentUser
      .mockRejectedValueOnce(apiError(0, 'network'))
      .mockResolvedValue(identity as never)

    const { screen } = await renderRoute('/calendar')

    await expect
      .element(screen.getByText('Session temporarily unavailable'))
      .toBeInTheDocument()
    await screen.getByRole('button', { name: 'Retry' }).click()

    await expect.element(screen.getByText('Canonical User')).toBeInTheDocument()
    expect(getCurrentUser).toHaveBeenCalledTimes(2)
  })

  it('revalidates identity when navigating between protected routes', async () => {
    const { router, screen } = await renderRoute('/')
    await expect.element(screen.getByText('Canonical User')).toBeInTheDocument()
    const initialChecks = getCurrentUser.mock.calls.length

    await router.navigate({ to: '/calendar' })

    await expect
      .element(screen.getByRole('heading', { name: 'Calendar' }))
      .toBeInTheDocument()
    expect(getCurrentUser.mock.calls.length).toBeGreaterThan(initialChecks)
  })

  it('redirects an active session away from sign-in to its safe requested destination', async () => {
    const { router, screen } = await renderRoute(
      '/sign-in?redirect=%2Fsettings%2Faccount'
    )

    await expect
      .poll(() => router.state.location.pathname)
      .toBe('/settings/account')
    await expect.element(screen.getByText('Canonical User')).toBeInTheDocument()
    expect(router.state.location.search).toEqual({})
  })

  it('does not probe cached identity while a confirmed logout barrier is active', async () => {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: AUTH_LIFECYCLE_STORAGE_KEY,
        newValue: JSON.stringify({
          sourceId: 'other-tab',
          operationId: 'logout-1',
          generation: 100,
          status: 'logout-confirmed',
        }),
      })
    )

    const { screen } = await renderRoute('/sign-in')

    await expect
      .element(screen.getByRole('button', { name: 'Sign in' }))
      .toBeInTheDocument()
    expect(getCurrentUser).not.toHaveBeenCalled()
  })
})
