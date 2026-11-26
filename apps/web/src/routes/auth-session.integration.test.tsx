import {
  AxiosError,
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosResponse,
} from 'axios'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { routeTree } from '@/routeTree.gen'
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import {
  CoreApiError,
  coreApi,
  coreApiAxios,
  resetCsrfToken,
} from '@/lib/core-api'
import { RECOVERY_DISABLED_MARKER } from '@/lib/request-recovery'
import { DirectionProvider } from '@/context/direction-provider'
import { FontProvider } from '@/context/font-provider'
import { ThemeProvider } from '@/context/theme-provider'
import {
  AUTH_LIFECYCLE_STORAGE_KEY,
  resetAuthLifecycleAfterSignIn,
} from '@/features/auth/session/auth-lifecycle'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import {
  configureSessionRevalidation,
  revalidateBrowserSession,
} from '@/features/auth/session/session-revalidation'

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
const organizationUnitId = '11111111-1111-4111-8111-111111111111'
const organizationUnit = {
  id: organizationUnitId,
  code: 'OPS',
  name: 'Operations',
  parentId: null,
  status: 'ACTIVE',
}

function emptyPage(page: number, size: number) {
  return {
    data: [],
    meta: {
      pagination: {
        page,
        size,
        totalElements: 0,
        totalPages: 0,
        hasNext: false,
        hasPrevious: false,
      },
    },
  }
}

const apiError = (status: number, kind: 'http' | 'network' | 'server') =>
  new CoreApiError({
    message: `session check failed: ${status}`,
    status: status || undefined,
    code: status === 401 ? 'AUTH_REQUIRED' : 'AUTHZ_FORBIDDEN',
    kind,
  })

function unauthorizedError(config: Parameters<AxiosAdapter>[0]): AxiosError {
  const response: AxiosResponse<unknown> = {
    data: {
      code: 'AUTH_REQUIRED',
      message: 'Authentication is required.',
    },
    status: 401,
    statusText: 'Unauthorized',
    headers: new AxiosHeaders(),
    config,
  }

  return new AxiosError(
    'Request failed with status 401',
    'ERR_BAD_REQUEST',
    config,
    undefined,
    response
  )
}

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

  return { router, screen, queryClient }
}

describe('session restoration and protected routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    coreApiAxios.defaults.adapter = undefined
    resetCsrfToken()
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
    expect(
      getCurrentUser.mock.calls[getCurrentUser.mock.calls.length - 1]?.[1]
    ).toMatchObject({
      [RECOVERY_DISABLED_MARKER]: true,
    })
  })

  it('renders the sign-in form for an actual anonymous Core 401 without recovery', async () => {
    getCurrentUser.mockRestore()
    const requests: string[] = []
    coreApiAxios.defaults.adapter = async (config) => {
      requests.push(config.url ?? '')
      throw unauthorizedError(config)
    }

    const { screen, router } = await renderRoute('/sign-in')

    await expect
      .element(screen.getByRole('button', { name: 'Sign in' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Session temporarily unavailable'))
      .not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/sign-in')
    expect(requests).toEqual(['/auth/me'])
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

  it('allows an Administrator to enter Members', async () => {
    const administrator = {
      ...identity,
      globalRole: 'ADMINISTRATOR' as const,
      directoryManagementScope: { allUnits: true, unitIds: [] },
    }
    getCurrentUser.mockResolvedValue(administrator as never)
    const protectedRead = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (url, config) => {
        if (url === '/users') {
          return emptyPage(
            Number(config?.params?.page ?? 0),
            Number(config?.params?.size ?? 20)
          )
        }
        if (url === '/organizational-units') {
          return {
            data: [organizationUnit],
            meta: {
              pagination: {
                page: 0,
                size: 100,
                totalElements: 1,
                totalPages: 1,
                hasNext: false,
                hasPrevious: false,
              },
            },
          }
        }
        throw new Error(`Unexpected protected request ${url}`)
      })
    const admin = await renderRoute('/members')
    await expect
      .element(admin.screen.getByRole('heading', { name: 'Members' }))
      .toBeVisible()
    await expect
      .element(admin.screen.getByRole('link', { name: 'Members' }))
      .toBeVisible()
    expect(protectedRead.mock.calls.some(([url]) => url === '/users')).toBe(
      true
    )
  })

  it('allows a scoped Department Manager to enter Members with an Employee-only query', async () => {
    const manager = {
      ...identity,
      globalRole: 'DEPARTMENT_MANAGER' as const,
      directoryManagementScope: {
        allUnits: false,
        unitIds: [organizationUnitId],
      },
    }
    getCurrentUser.mockResolvedValue(manager as never)
    const managerRead = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (url, config) => {
        if (url === '/users') {
          return emptyPage(
            Number(config?.params?.page ?? 0),
            Number(config?.params?.size ?? 20)
          )
        }
        if (url === '/organizational-units') {
          return {
            data: [organizationUnit],
            meta: {
              pagination: {
                page: 0,
                size: 100,
                totalElements: 1,
                totalPages: 1,
                hasNext: false,
                hasPrevious: false,
              },
            },
          }
        }
        throw new Error(`Unexpected protected request ${url}`)
      })
    const managerRoute = await renderRoute('/members')
    await expect
      .element(managerRoute.screen.getByRole('heading', { name: 'Members' }))
      .toBeVisible()
    await expect
      .element(managerRoute.screen.getByRole('link', { name: 'Members' }))
      .toBeVisible()
    expect(
      managerRead.mock.calls.find(([url]) => url === '/users')?.[1]?.params
    ).toMatchObject({ role: 'EMPLOYEE' })
  })

  it('keeps a Department Manager with no grants in the authorized empty-scope experience', async () => {
    getCurrentUser.mockResolvedValue({
      ...identity,
      globalRole: 'DEPARTMENT_MANAGER',
      directoryManagementScope: { allUnits: false, unitIds: [] },
    } as never)
    const protectedRead = vi.spyOn(coreApi, 'getWithMeta')
    const { screen } = await renderRoute('/members')

    await expect
      .element(screen.getByRole('heading', { name: 'Members' }))
      .toBeVisible()
    await expect
      .element(
        screen.getByText(
          'No organizational units are granted for member management.'
        )
      )
      .toBeVisible()
    expect(protectedRead).not.toHaveBeenCalled()
  })

  it.each(['/members', '/users'])(
    'denies Employee direct navigation through %s without mounting protected Member queries',
    async (path) => {
      getCurrentUser.mockResolvedValue(identity as never)
      const protectedRead = vi.spyOn(coreApi, 'getWithMeta')
      const { router, screen } = await renderRoute(path)

      await expect.element(screen.getByText('Access Forbidden')).toBeVisible()
      await expect
        .element(screen.getByRole('link', { name: 'Members' }))
        .not.toBeInTheDocument()
      await expect
        .element(screen.getByRole('link', { name: 'Meeting Rooms' }))
        .toBeVisible()
      expect(protectedRead).not.toHaveBeenCalled()
      if (path === '/users') {
        await expect.poll(() => router.state.location.pathname).toBe('/members')
      }
    }
  )

  it('reacts to actor and role replacement and removes obsolete Member access', async () => {
    const administrator = {
      ...identity,
      userId: '55555555-5555-4555-8555-555555555555',
      globalRole: 'ADMINISTRATOR' as const,
      directoryManagementScope: { allUnits: true, unitIds: [] },
    }
    let verifiedIdentity: typeof administrator | typeof identity = administrator
    getCurrentUser.mockImplementation(async () => verifiedIdentity as never)
    const protectedRead = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (url, config) =>
        url === '/users'
          ? emptyPage(
              Number(config?.params?.page ?? 0),
              Number(config?.params?.size ?? 20)
            )
          : emptyPage(
              Number(config?.params?.page ?? 0),
              Number(config?.params?.size ?? 100)
            )
      )
    const { queryClient, screen } = await renderRoute('/members')
    await expect
      .element(screen.getByRole('heading', { name: 'Members' }))
      .toBeVisible()
    const readsBeforeReplacement = protectedRead.mock.calls.length

    verifiedIdentity = {
      ...identity,
      userId: '66666666-6666-4666-8666-666666666666',
      session: {
        ...identity.session,
        id: '77777777-7777-4777-8777-777777777777',
      },
    }
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey })

    await expect.element(screen.getByText('Access Forbidden')).toBeVisible()
    await expect
      .element(screen.getByRole('link', { name: 'Members' }))
      .not.toBeInTheDocument()
    expect(protectedRead.mock.calls.length).toBe(readsBeforeReplacement)
  })

  it('preserves a compatible Member draft during transient identity verification failure', async () => {
    const administrator = {
      ...identity,
      globalRole: 'ADMINISTRATOR' as const,
      directoryManagementScope: { allUnits: true, unitIds: [] },
    }
    getCurrentUser.mockResolvedValue(administrator as never)
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, config) =>
      url === '/users'
        ? emptyPage(
            Number(config?.params?.page ?? 0),
            Number(config?.params?.size ?? 20)
          )
        : emptyPage(
            Number(config?.params?.page ?? 0),
            Number(config?.params?.size ?? 100)
          )
    )
    const { queryClient, screen } = await renderRoute('/members')
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
    const name = screen.getByRole('textbox', { name: 'Name' })
    await userEvent.fill(name, 'Preserved routed draft')

    getCurrentUser.mockRejectedValue(apiError(0, 'network'))
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey })

    await expect
      .element(screen.getByRole('dialog', { name: 'Create account' }))
      .toBeVisible()
    await expect.element(name).toHaveValue('Preserved routed draft')
    await expect
      .element(screen.getByRole('button', { name: 'Save member' }))
      .toBeDisabled()
  })

  it('shields a mounted draft during mandatory verification and restores it only for the same context', async () => {
    const administrator = {
      ...identity,
      globalRole: 'ADMINISTRATOR' as const,
      directoryManagementScope: { allUnits: true, unitIds: [] },
    }
    getCurrentUser.mockResolvedValue(administrator as never)
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (_url, config) =>
      emptyPage(
        Number(config?.params?.page ?? 0),
        Number(config?.params?.size ?? 20)
      )
    )
    const { queryClient, screen } = await renderRoute('/members')
    const dispose = configureSessionRevalidation({
      queryClient,
      onContainment: () => queryClient.clear(),
      onChanged: () => undefined,
    })

    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
      const name = screen.getByRole('textbox', { name: 'Name' })
      await userEvent.fill(name, 'Private unsaved draft')
      getCurrentUser.mockImplementationOnce(async () => {
        await pending
        return administrator as never
      })

      const checking = revalidateBrowserSession()
      try {
        await expect
          .element(screen.getByText('Checking your session'))
          .toBeVisible()
        await expect
          .element(screen.getByRole('dialog', { name: 'Create account' }))
          .not.toBeVisible()
        await expect
          .element(screen.getByRole('heading', { name: 'Members' }))
          .not.toBeVisible()
      } finally {
        release()
        await checking
      }
      await expect.element(name).toHaveValue('Private unsaved draft')

      getCurrentUser.mockResolvedValue(identity as never)
      await revalidateBrowserSession()
      await expect
        .element(screen.getByRole('dialog', { name: 'Create account' }))
        .not.toBeInTheDocument()
      await expect.element(screen.getByText('Access Forbidden')).toBeVisible()
    } finally {
      dispose()
      resetAuthLifecycleAfterSignIn()
      await screen.unmount()
    }
  })

  it.each([
    ['confirmed authorization denial', apiError(403, 'http')],
    ['confirmed session loss', apiError(401, 'http')],
  ] as const)(
    'removes Member navigation after %s without restoring the stale route identity',
    async (_label, error) => {
      const administrator = {
        ...identity,
        globalRole: 'ADMINISTRATOR' as const,
        directoryManagementScope: { allUnits: true, unitIds: [] },
      }
      getCurrentUser.mockResolvedValue(administrator as never)
      vi.spyOn(coreApi, 'getWithMeta').mockImplementation(
        async (url, config) =>
          url === '/users'
            ? emptyPage(
                Number(config?.params?.page ?? 0),
                Number(config?.params?.size ?? 20)
              )
            : emptyPage(
                Number(config?.params?.page ?? 0),
                Number(config?.params?.size ?? 100)
              )
      )
      const { queryClient, screen } = await renderRoute('/members')
      await expect
        .element(screen.getByRole('link', { name: 'Members' }))
        .toBeVisible()

      getCurrentUser.mockRejectedValue(error)
      await queryClient.invalidateQueries({ queryKey: currentUserQueryKey })

      await expect
        .element(screen.getByRole('link', { name: 'Members' }))
        .not.toBeInTheDocument()
      await expect
        .element(screen.getByRole('link', { name: 'Meeting Rooms' }))
        .toBeVisible()
      await expect
        .element(screen.getByRole('heading', { name: 'Members' }))
        .not.toBeInTheDocument()
    }
  )

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
