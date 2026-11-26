import { act } from 'react'
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
import { containProtectedState } from '@/protected-state-containment'
import { routeTree } from '@/routeTree.gen'
import '@/styles/index.css'
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
  getSessionContextKey,
  revalidateBrowserSession,
} from '@/features/auth/session/session-revalidation'
import {
  preferencesQueryKey,
  type Preferences,
} from '@/features/settings/preferences-api'
import { profileQueryKey } from '@/features/settings/profile/profile-api'

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
const dashboardAsOf = '2026-11-26T08:00:00Z'
const dashboard = {
  asOf: dashboardAsOf,
  timezone: 'Asia/Ho_Chi_Minh',
  upcomingWindow: {
    fromInclusive: dashboardAsOf,
    toExclusive: '2026-12-10T08:00:00Z',
    limit: 10,
  },
  recentWindow: {
    fromInclusive: '2026-10-27T08:00:00Z',
    toExclusive: dashboardAsOf,
    limit: 10,
  },
  meetingCountsByState: {},
  upcomingMeetings: [],
  recentMeetings: [],
  assignedActionItems: { open: 0, inProgress: 0, done: 0, overdue: 0 },
}
const preferences = {
  timezone: 'Asia/Ho_Chi_Minh',
  locale: 'en-US',
  meetingEmailEnabled: true,
  actionItemEmailEnabled: true,
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
    getCurrentUser.mockImplementation(async (url) => {
      if (url === '/dashboard/me') return dashboard as never
      if (url === '/me/preferences') return preferences as never
      return identity as never
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/action-items') return emptyPage(0, 5) as never
      throw new Error('Unexpected Core GET with meta: ' + url)
    })
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

  it('discards a pending dashboard response when the verified actor changes', async () => {
    let verifiedIdentity = identity
    let oldSignal: { aborted: boolean } | undefined
    let releaseOld!: (value: typeof dashboard) => void
    const oldResponse = new Promise<typeof dashboard>((resolve) => {
      releaseOld = resolve
    })
    const replacement = {
      ...identity,
      userId: '66666666-6666-4666-8666-666666666666',
      displayName: 'Replacement Operator',
      session: {
        ...identity.session,
        id: '77777777-7777-4777-8777-777777777777',
      },
    }
    const oldDashboard = {
      ...dashboard,
      assignedActionItems: { ...dashboard.assignedActionItems, done: 99 },
    }
    const replacementDashboard = {
      ...dashboard,
      assignedActionItems: { ...dashboard.assignedActionItems, done: 42 },
    }
    getCurrentUser.mockImplementation(async (url, config) => {
      if (url === '/dashboard/me') {
        if (verifiedIdentity.userId === identity.userId) {
          oldSignal = config?.signal
          return oldResponse
        }
        return replacementDashboard
      }
      if (url === '/me/preferences') return preferences
      if (url === '/auth/me') return verifiedIdentity
      throw new Error('Unexpected Core GET ' + url)
    })
    const { queryClient, screen } = await renderRoute('/')
    const dispose = configureSessionRevalidation({
      queryClient,
      onContainment: () => containProtectedState(queryClient),
      onChanged: () => undefined,
    })
    try {
      await expect
        .element(
          screen.getByRole('heading', {
            name: 'Welcome back, ' + identity.displayName,
          })
        )
        .toBeVisible()
      await expect.poll(() => Boolean(oldSignal)).toBe(true)

      const previousExportKey = 'sme:meeting-minutes-export:previous-session'
      sessionStorage.setItem(previousExportKey, '{}')
      const previousReportKey = [
        'dashboard',
        'management',
        getSessionContextKey(identity),
      ]
      queryClient.setQueryData(previousReportKey, { protected: true })
      verifiedIdentity = replacement
      await revalidateBrowserSession()
      expect(sessionStorage.getItem(previousExportKey)).toBeNull()
      expect(queryClient.getQueryData(previousReportKey)).toBeUndefined()
      await expect
        .element(
          screen.getByRole('heading', {
            name: 'Welcome back, ' + replacement.displayName,
          })
        )
        .toBeVisible()
      await expect
        .element(screen.getByText('42', { exact: true }))
        .toBeVisible()

      releaseOld(oldDashboard)
      await oldResponse
      await expect.poll(() => oldSignal?.aborted).toBe(true)
      expect(
        queryClient.getQueryData([
          'dashboard',
          'me',
          getSessionContextKey(identity),
        ])
      ).toBeUndefined()
      await expect
        .element(screen.getByText('99', { exact: true }))
        .not.toBeInTheDocument()
      await expect
        .element(screen.getByText('42', { exact: true }))
        .toBeVisible()
    } finally {
      releaseOld(oldDashboard)
      dispose()
    }
  })

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

  it('isolates an in-flight regional preferences read after session replacement', async () => {
    const previousPreferences: Preferences = {
      timezone: 'America/New_York',
      locale: 'en-US',
      meetingEmailEnabled: false,
      actionItemEmailEnabled: true,
    }
    const nextPreferences: Preferences = {
      timezone: 'Asia/Tokyo',
      locale: 'ja-JP',
      meetingEmailEnabled: true,
      actionItemEmailEnabled: false,
    }
    const nextIdentity = {
      ...identity,
      userId: '66666666-6666-4666-8666-666666666666',
      session: {
        ...identity.session,
        id: '77777777-7777-4777-8777-777777777777',
      },
    }
    let replaced = false
    let resolvePrevious!: (value: Preferences) => void
    const pending = new Promise<Preferences>((resolve) => {
      resolvePrevious = resolve
    })
    let previousSignal: AbortSignal | undefined
    getCurrentUser.mockImplementation(
      async (url: string, config?: { signal?: AbortSignal }) => {
        if (url !== '/me/preferences') {
          return (replaced ? nextIdentity : identity) as never
        }
        if (replaced) return nextPreferences as never
        previousSignal = config?.signal
        return pending as never
      }
    )
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (_url, config) =>
      emptyPage(
        Number(config?.params?.page ?? 0),
        Number(config?.params?.size ?? 100)
      )
    )
    const { queryClient, screen } = await renderRoute('/calendar?month=2026-11')
    const dispose = configureSessionRevalidation({
      queryClient,
      onContainment: () => {
        void queryClient.cancelQueries()
        queryClient.removeQueries()
        queryClient.getMutationCache().clear()
      },
      onChanged: () => undefined,
    })
    try {
      await expect
        .element(screen.getByText('Loading regional preferences…'))
        .toBeVisible()
      await vi.waitFor(() => expect(previousSignal).toBeDefined())

      replaced = true
      await revalidateBrowserSession()
      const timezone = screen.getByLabelText('Calendar time zone')
      await expect.element(timezone).toHaveTextContent('Asia/Tokyo')
      expect(previousSignal?.aborted).toBe(true)

      await act(async () => {
        resolvePrevious(previousPreferences)
        await pending
      })
      await expect.element(timezone).toHaveTextContent('Asia/Tokyo')
      expect(queryClient.getQueryData(preferencesQueryKey)).toEqual(
        nextPreferences
      )
    } finally {
      dispose()
      resetAuthLifecycleAfterSignIn()
      await screen.unmount()
      resolvePrevious(previousPreferences)
    }
  })

  it.each(['success', 'error'] as const)(
    'isolates a pending notification preference update after session replacement (%s)',
    async (outcome) => {
      const previousPreferences: Preferences = {
        timezone: 'America/New_York',
        locale: 'en-US',
        meetingEmailEnabled: true,
        actionItemEmailEnabled: true,
      }
      const nextPreferences: Preferences = {
        timezone: 'Asia/Tokyo',
        locale: 'ja-JP',
        meetingEmailEnabled: true,
        actionItemEmailEnabled: false,
      }
      const nextIdentity = {
        ...identity,
        userId: '66666666-6666-4666-8666-666666666666',
        session: {
          ...identity.session,
          id: '77777777-7777-4777-8777-777777777777',
        },
      }
      let replaced = false
      getCurrentUser.mockImplementation(
        async (url: string) =>
          (url === '/me/preferences'
            ? replaced
              ? nextPreferences
              : previousPreferences
            : replaced
              ? nextIdentity
              : identity) as never
      )
      let resolve!: (value: Preferences) => void
      let reject!: (error: Error) => void
      const pending = new Promise<Preferences>((done, fail) => {
        resolve = done
        reject = fail
      })
      const patch = vi
        .spyOn(coreApi, 'patch')
        .mockImplementationOnce(() => pending as never)
      const { queryClient, screen } = await renderRoute(
        '/settings/notifications'
      )
      const dispose = configureSessionRevalidation({
        queryClient,
        onContainment: () => {
          void queryClient.cancelQueries()
          queryClient.removeQueries()
          queryClient.getMutationCache().clear()
        },
        onChanged: () => undefined,
      })
      try {
        const meetingEmails = screen.getByRole('switch', {
          name: 'Meeting emails',
        })
        await expect.element(meetingEmails).toBeChecked()
        const previousControl = meetingEmails.element()
        await userEvent.click(meetingEmails)
        await userEvent.click(
          screen.getByRole('button', { name: 'Save notifications' })
        )
        await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
        const oldMutation = queryClient.getMutationCache().getAll()[0]
        if (!oldMutation)
          throw new Error('Expected a pending preference update')
        expect(oldMutation.state.status).toBe('pending')

        replaced = true
        await revalidateBrowserSession()
        await expect.element(meetingEmails).toBeChecked()
        await expect
          .element(screen.getByRole('switch', { name: 'Action item emails' }))
          .not.toBeChecked()
        expect(previousControl.isConnected).toBe(false)
        expect(queryClient.getQueryData(preferencesQueryKey)).toEqual(
          nextPreferences
        )
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

        if (outcome === 'success') {
          resolve({ ...previousPreferences, meetingEmailEnabled: false })
        } else {
          reject(apiError(503, 'server'))
        }
        await vi.waitFor(() => expect(oldMutation.state.status).toBe(outcome))
        await expect.element(meetingEmails).toBeChecked()
        await expect
          .element(screen.getByRole('button', { name: 'Save notifications' }))
          .toBeDisabled()
        expect(queryClient.getQueryData(preferencesQueryKey)).toEqual(
          nextPreferences
        )
        expect(invalidate).not.toHaveBeenCalledWith({
          queryKey: preferencesQueryKey,
        })
        expect(patch).toHaveBeenCalledTimes(1)
      } finally {
        dispose()
        resetAuthLifecycleAfterSignIn()
        await screen.unmount()
        resolve(previousPreferences)
      }
    }
  )

  it.each(['success', 'error'] as const)(
    'isolates a pending profile update after session replacement (%s)',
    async (outcome) => {
      const originalProfile = {
        id: identity.userId,
        email: identity.email,
        displayName: identity.displayName,
        globalRole: identity.globalRole,
        accountStatus: identity.accountStatus,
        primaryOrgUnitId: identity.primaryOrgUnitId,
      }
      const nextIdentity = {
        ...identity,
        userId: '66666666-6666-4666-8666-666666666666',
        email: 'next@example.test',
        displayName: 'Next user',
        session: {
          ...identity.session,
          id: '77777777-7777-4777-8777-777777777777',
        },
      }
      const nextProfile = {
        ...originalProfile,
        id: nextIdentity.userId,
        email: nextIdentity.email,
        displayName: nextIdentity.displayName,
      }
      const originalResponse = {
        data: originalProfile,
        etag: '"profile-v1"',
        meta: {},
      }
      const nextResponse = {
        data: nextProfile,
        etag: '"next-v1"',
        meta: {},
      }
      const read = vi
        .spyOn(coreApi, 'getWithMetaAndEtag')
        .mockResolvedValue(originalResponse)
      let resolve!: (value: typeof originalResponse) => void
      let reject!: (error: CoreApiError) => void
      const pending = new Promise<typeof originalResponse>((done, fail) => {
        resolve = done
        reject = fail
      })
      const patch = vi
        .spyOn(coreApi, 'patchWithMetaAndEtag')
        .mockImplementationOnce(() => pending as never)

      const { queryClient, screen } = await renderRoute('/settings')
      const dispose = configureSessionRevalidation({
        queryClient,
        onContainment: () => {
          void queryClient.cancelQueries()
          queryClient.removeQueries()
          queryClient.getMutationCache().clear()
        },
        onChanged: () => undefined,
      })
      try {
        const name = screen.getByRole('textbox', { name: 'Display name' })
        await expect.element(name).toHaveValue(originalProfile.displayName)
        const originalInput = name.element()
        await userEvent.fill(name, 'Previous user draft')
        await userEvent.click(
          screen.getByRole('button', { name: 'Save profile' })
        )
        await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
        const oldMutation = queryClient.getMutationCache().getAll()[0]
        if (!oldMutation) throw new Error('Expected a pending profile update')
        expect(oldMutation.state.status).toBe('pending')

        // Revalidate a different session through the real authenticated route.
        // Cache removal alone does not replace mounted Query observers or forms.
        getCurrentUser.mockResolvedValue(nextIdentity as never)
        read.mockResolvedValue(nextResponse)
        await revalidateBrowserSession()

        await expect.element(name).toHaveValue(nextProfile.displayName)
        expect(originalInput.isConnected).toBe(false)
        const nextSnapshot = { profile: nextProfile, etag: nextResponse.etag }
        expect(queryClient.getQueryData(profileQueryKey)).toEqual(nextSnapshot)
        const readsBeforeCompletion = read.mock.calls.length
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

        // Deliberately deliver the old response after the new editor is mounted.
        if (outcome === 'success') {
          resolve({
            ...originalResponse,
            data: { ...originalProfile, displayName: 'Previous user draft' },
            etag: '"profile-v2"',
          })
        } else {
          reject(
            new CoreApiError({
              message: 'Stale profile',
              status: 412,
              kind: 'http',
            })
          )
        }

        await vi.waitFor(() => expect(oldMutation.state.status).toBe(outcome))
        await expect.element(name).toHaveValue(nextProfile.displayName)
        await expect
          .element(screen.getByRole('textbox', { name: 'Organization email' }))
          .toHaveValue(nextProfile.email)
        await expect
          .element(screen.getByRole('button', { name: 'Save profile' }))
          .toBeDisabled()
        await expect
          .element(screen.getByText('Review the latest profile'))
          .not.toBeInTheDocument()
        expect(queryClient.getQueryData(profileQueryKey)).toEqual(nextSnapshot)
        expect(queryClient.getQueryData(currentUserQueryKey)).toEqual(
          nextIdentity
        )
        expect(read).toHaveBeenCalledTimes(readsBeforeCompletion)
        expect(patch).toHaveBeenCalledTimes(1)
        expect(invalidate).not.toHaveBeenCalledWith({
          queryKey: currentUserQueryKey,
        })
      } finally {
        dispose()
        resetAuthLifecycleAfterSignIn()
        await screen.unmount()
        resolve(originalResponse)
      }
    }
  )

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
      onContainment: () => containProtectedState(queryClient),
      onChanged: () => undefined,
    })

    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      // Radix makes the background inaccessible while a modal is open.
      // Capture the workspace heading before opening it.
      const heading = screen.getByRole('heading', { name: 'Members' })
      await expect.element(heading).toBeVisible()
      const headingElement = heading.element()
      await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
      const name = screen.getByRole('textbox', { name: 'Name' })
      await userEvent.fill(name, 'Private unsaved draft')
      const dialog = screen.getByRole('dialog', { name: 'Create account' })
      await expect.element(dialog).toBeVisible()
      const portalHost = dialog
        .element()
        .closest('[data-slot="workspace-portal-host"]')
      expect(portalHost).not.toBeNull()
      const boundary = portalHost?.closest<HTMLDivElement>(
        '[data-slot="workspace-visibility-boundary"]'
      )
      expect(boundary).not.toBeNull()
      getCurrentUser.mockImplementationOnce(async () => {
        await pending
        return administrator as never
      })

      const checking = revalidateBrowserSession()
      try {
        await expect
          .element(screen.getByText('Checking your session'))
          .toBeVisible()
        // Role locators exclude inaccessible elements. Verify the real DOM
        // independently so an aria-hidden but visibly leaked portal still fails.
        await expect
          .poll(() =>
            Array.from(document.querySelectorAll('[role="dialog"]')).some(
              (element) => element.checkVisibility()
            )
          )
          .toBe(false)
        await expect.poll(() => headingElement.checkVisibility()).toBe(false)
        expect(
          document.querySelector('[data-slot="workspace-portal-host"]')
        ).toBe(portalHost)
        expect(boundary?.hidden).toBe(true)
        await expect.element(dialog).not.toBeInTheDocument()
        await expect.element(heading).not.toBeInTheDocument()
      } finally {
        release()
        await checking
      }
      await expect.element(dialog).toBeVisible()
      expect(
        dialog.element().closest('[data-slot="workspace-portal-host"]')
      ).toBe(portalHost)
      await expect.element(name).toBeVisible()
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
    const preferences: Preferences = {
      timezone: 'UTC',
      locale: 'en-US',
      meetingEmailEnabled: true,
      actionItemEmailEnabled: true,
    }
    getCurrentUser
      .mockRejectedValueOnce(apiError(0, 'network'))
      .mockImplementation(
        async (url: string) =>
          (url === '/me/preferences' ? preferences : identity) as never
      )

    const { screen } = await renderRoute('/calendar')

    await expect
      .element(screen.getByText('Session temporarily unavailable'))
      .toBeInTheDocument()
    await screen.getByRole('button', { name: 'Retry' }).click()

    await expect.element(screen.getByText('Canonical User')).toBeInTheDocument()
    expect(
      getCurrentUser.mock.calls.filter(([url]) => url === '/auth/me')
    ).toHaveLength(2)
  })

  it('revalidates identity when navigating between protected routes', async () => {
    const { router, screen } = await renderRoute('/')
    await expect
      .element(screen.getByRole('heading', { name: 'Dashboard', exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Scheduled meetings'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Canonical User', { exact: true }))
      .toBeInTheDocument()
    const initialChecks = getCurrentUser.mock.calls.filter(
      ([url]) => url === '/auth/me'
    ).length

    await router.navigate({ to: '/calendar' })

    await expect
      .element(screen.getByRole('heading', { name: 'Calendar' }))
      .toBeInTheDocument()
    expect(
      getCurrentUser.mock.calls.filter(([url]) => url === '/auth/me').length
    ).toBeGreaterThan(initialChecks)
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
