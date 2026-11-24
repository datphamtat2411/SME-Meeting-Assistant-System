import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { routeTree } from '@/routeTree.gen'
import { clearCookies } from '@/test-utils/cookies'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { CoreApiError, coreApi, resetCsrfToken } from '@/lib/core-api'
import { DirectionProvider } from '@/context/direction-provider'
import { FontProvider } from '@/context/font-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { resetAuthLifecycleAfterSignIn } from '@/features/auth/session/auth-lifecycle'

vi.mock('react-top-loading-bar', () => ({
  default: () => null,
}))

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const meetingId = '11111111-1111-4111-8111-111111111111'

const identity = {
  userId,
  email: 'operator@example.test',
  displayName: 'Authorized Operator',
  globalRole: 'EMPLOYEE' as const,
  accountStatus: 'ACTIVE' as const,
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: false, unitIds: [] },
  session: {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    clientType: 'WEB' as const,
    createdAt: '2026-11-23T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2027-11-23T00:00:00Z',
  },
}

const pagination = {
  page: 0,
  size: 10,
  totalElements: 0,
  totalPages: 0,
  hasNext: false,
  hasPrevious: false,
}

const emptyList = {
  data: [],
  meta: { pagination },
}

const meeting = {
  id: meetingId,
  title: 'Planning Meeting',
  description: 'A controlled route-smoke meeting fixture.',
  organizerUserId: userId,
  roomId: null,
  scheduledStartAt: '2026-11-23T10:00:00Z',
  scheduledEndAt: '2026-11-23T11:00:00Z',
  status: 'IN_PROGRESS' as const,
  startedAt: '2026-11-23T10:00:00Z',
  endedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: userId,
  createdAt: '2026-11-23T09:00:00Z',
  updatedAt: '2026-11-23T10:00:00Z',
}

const meetingListItem = {
  ...meeting,
  display: {
    organizerName: identity.displayName,
    roomName: null,
    roomLocation: null,
    participantCount: 1,
    participantPreview: [{ userId, displayName: identity.displayName }],
  },
}

const meetingList = {
  data: [meetingListItem],
  meta: {
    pagination: {
      ...pagination,
      size: 10,
      totalElements: 1,
      totalPages: 1,
    },
  },
}

const dashboard = {
  asOf: '2026-11-23T09:00:00Z',
  timezone: 'Asia/Ho_Chi_Minh',
  meetingCountsByState: { SCHEDULED: 1, IN_PROGRESS: 1 },
  upcomingMeetings: [
    {
      id: meetingId,
      title: meeting.title,
      status: meeting.status,
      scheduledStartAt: meeting.scheduledStartAt,
      scheduledEndAt: meeting.scheduledEndAt,
      endedAt: null,
    },
  ],
  recentMeetings: [],
  assignedActionItems: { open: 1, inProgress: 0, done: 2, overdue: 0 },
}

const profile = {
  id: userId,
  email: identity.email,
  displayName: identity.displayName,
  globalRole: identity.globalRole,
  accountStatus: identity.accountStatus,
  primaryOrgUnitId: null,
}

const preferences = {
  timezone: 'Asia/Ho_Chi_Minh',
  locale: 'en-US',
  meetingEmailEnabled: true,
  actionItemEmailEnabled: true,
}

const participant = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  meetingId,
  userId,
  addedByUserId: userId,
  addedAt: '2026-11-23T09:00:00Z',
  removedAt: null,
  removedByUserId: null,
  displayName: identity.displayName,
}

type FixtureOptions = {
  identity?: unknown
  meetingList?: unknown
  meetingListError?: unknown
  meetingDetail?: unknown
  meetingDetailError?: unknown
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
}

function apiError(status: number, message = `Core response ${status}`) {
  return new CoreApiError({
    message,
    status,
    kind: status >= 500 ? 'server' : 'http',
  })
}

function installCoreFixtures(options: FixtureOptions = {}) {
  const get = vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
    if (url === '/auth/me') return (options.identity ?? identity) as never
    if (url === '/dashboard/me') return dashboard as never
    if (url === '/me/profile') return profile as never
    if (url === '/me/preferences') return preferences as never
    if (url.endsWith(`/meetings/${meetingId}/media`)) return [] as never
    throw new Error(`Unexpected Core GET ${url}`)
  })

  const getWithMeta = vi
    .spyOn(coreApi, 'getWithMeta')
    .mockImplementation(async (url) => {
      if (url === '/meetings') {
        if (options.meetingListError) throw options.meetingListError
        return (options.meetingList ?? meetingList) as never
      }
      if (url === '/action-items') return emptyList as never
      if (url === '/rooms') return emptyList as never
      if (url === '/users') return emptyList as never
      if (url === '/organizational-units') return emptyList as never
      if (url.endsWith(`/meetings/${meetingId}/participants`)) {
        return { data: [participant], meta: {} } as never
      }
      throw new Error(`Unexpected Core GET with meta ${url}`)
    })

  const getWithMetaAndEtag = vi
    .spyOn(coreApi, 'getWithMetaAndEtag')
    .mockImplementation(async (url) => {
      if (url === `/meetings/${meetingId}`) {
        if (options.meetingDetailError) throw options.meetingDetailError
        return {
          data: options.meetingDetail ?? meeting,
          meta: {},
          etag: `"meeting-${meetingId}"`,
        } as never
      }
      throw new Error(`Unexpected Core GET with ETag ${url}`)
    })

  return { get, getWithMeta, getWithMetaAndEtag }
}

async function renderGeneratedRoute(
  initialPath: string,
  width = 1280,
  height = 800
) {
  await page.viewport(width, height)
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
  return { queryClient, router, screen }
}

describe('integrated generated Web runtime', () => {
  beforeEach(() => {
    clearCookies()
    resetCsrfToken()
    resetAuthLifecycleAfterSignIn()
    vi.restoreAllMocks()
    installCoreFixtures()
  })

  it.each([
    ['/sign-up', 'Activate your organization account'],
    ['/forgot-password', 'Recover access'],
    ['/otp', 'Reset account password'],
    ['/account-setup', 'Set your password'],
    ['/sign-in-2', 'Sign in'],
  ] as const)('renders the public route %s', async (path, expectedText) => {
    const { screen } = await renderGeneratedRoute(path)

    await expect
      .element(screen.getByText(expectedText, { exact: true }).first())
      .toBeInTheDocument()
  })

  it('renders the canonical sign-in route for an anonymous session', async () => {
    const authRead = vi.mocked(coreApi.get)
    authRead.mockImplementation(async (url) => {
      if (url === '/auth/me') throw apiError(401, 'Authentication required')
      throw new Error(`Unexpected Core GET ${url}`)
    })

    const { router, screen } = await renderGeneratedRoute('/sign-in')

    await expect
      .element(screen.getByRole('button', { name: 'Sign in' }))
      .toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/sign-in')
  })

  it.each([
    ['/401', '401'],
    ['/403', '403'],
    ['/404', '404'],
    ['/500', '500'],
    ['/503', '503'],
  ] as const)('renders the public error route %s', async (path, status) => {
    const { screen } = await renderGeneratedRoute(path)

    await expect
      .element(screen.getByText(status, { exact: true }))
      .toBeInTheDocument()
  })

  it.each([
    ['/', 'Dashboard'],
    ['/meetings', 'Meetings'],
    ['/calendar', 'Calendar'],
    ['/action-items', 'Action Items'],
    ['/assistant', 'AI Assistant & search'],
    ['/rooms', 'Meeting Rooms'],
    ['/settings', 'Profile'],
    ['/settings/account', 'Account'],
    ['/settings/appearance', 'Appearance'],
    ['/settings/notifications', 'Notifications'],
    ['/help-center', 'Help Center'],
  ] as const)(
    'renders primary authenticated route %s with its real feature surface',
    async (path, expectedHeading) => {
      const { screen, router } = await renderGeneratedRoute(path)

      await expect
        .element(
          screen.getByRole('heading', { name: expectedHeading, exact: true })
        )
        .toBeInTheDocument()
      expect(router.state.location.pathname).toBe(path)
    }
  )

  it.each([
    ['/errors/unauthorized', 'Unauthorized Access'],
    ['/errors/forbidden', 'Access Forbidden'],
    ['/errors/not-found', 'Page not found'],
    ['/errors/internal-server-error', 'Oops! Something went wrong'],
    ['/errors/maintenance-error', 'Website is under maintenance!'],
  ] as const)(
    'renders authenticated dynamic error route %s',
    async (path, expectedText) => {
      const { screen, router } = await renderGeneratedRoute(path)

      await expect
        .element(screen.getByText(expectedText, { exact: false }).first())
        .toBeInTheDocument()
      expect(router.state.location.pathname).toBe(path)
    }
  )

  it.each(['/members', '/users'] as const)(
    'renders the Member authorization boundary for an Employee on %s',
    async (path) => {
      const protectedRead = vi.spyOn(coreApi, 'getWithMeta')
      const { router, screen } = await renderGeneratedRoute(path)

      await expect
        .element(screen.getByText('Access Forbidden', { exact: true }))
        .toBeInTheDocument()
      expect(router.state.location.pathname).toBe('/members')
      expect(protectedRead).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['/tasks', 'Tasks', '/tasks'],
    ['/apps', 'App Integrations', '/apps'],
    ['/chats', 'Inbox', '/chats'],
  ] as const)(
    'keeps compatibility route %s reachable without presenting it as Core data',
    async (path, expectedText, expectedPath) => {
      const { screen, router } = await renderGeneratedRoute(path)

      await expect
        .element(screen.getByText(expectedText, { exact: true }))
        .toBeInTheDocument()
      expect(router.state.location.pathname).toBe(expectedPath)
      expect(coreApi.getWithMeta).not.toHaveBeenCalled()
    }
  )

  it('navigates through dashboard, meetings, detail, live, and browser history', async () => {
    const writes = [
      vi.spyOn(coreApi, 'post'),
      vi.spyOn(coreApi, 'postWithMetaAndEtag'),
      vi.spyOn(coreApi, 'patch'),
      vi.spyOn(coreApi, 'patchWithMetaAndEtag'),
      vi.spyOn(coreApi, 'delete'),
      vi.spyOn(coreApi, 'deleteWithMetaAndEtag'),
    ]
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia')
    const { router, screen } = await renderGeneratedRoute('/')

    await expect
      .element(screen.getByRole('heading', { name: 'Dashboard', exact: true }))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('link', { name: 'Browse meetings' }))
    await expect
      .element(screen.getByRole('heading', { name: 'Meetings', exact: true }))
      .toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('link', { name: meeting.title, exact: true })
    )
    await expect
      .element(
        screen.getByRole('heading', { name: meeting.title, exact: true })
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Meeting intelligence workspace'))
      .toBeInTheDocument()

    await router.navigate({
      to: '/meetings/$meetingId/live',
      params: { meetingId },
    })
    await expect.element(screen.getByText('Live route')).toBeInTheDocument()
    await expect
      .element(screen.getByText('Meeting intelligence workspace'))
      .not.toBeInTheDocument()

    router.history.back()
    await expect
      .element(screen.getByText('Meeting intelligence workspace'))
      .toBeInTheDocument()
    router.history.back()
    await expect
      .element(screen.getByRole('heading', { name: 'Meetings', exact: true }))
      .toBeInTheDocument()
    router.history.back()
    await expect
      .element(screen.getByRole('heading', { name: 'Dashboard', exact: true }))
      .toBeInTheDocument()

    for (const write of writes) expect(write).not.toHaveBeenCalled()
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('uses the real mobile sidebar to cross-navigate and close its drawer', async () => {
    const { screen, router } = await renderGeneratedRoute('/calendar', 390, 844)

    await userEvent.click(
      screen.getByRole('banner').getByRole('button', {
        name: 'Toggle Sidebar',
      })
    )
    const drawer = screen.getByRole('dialog', { name: 'Sidebar' })
    await userEvent.click(drawer.getByRole('link', { name: 'Meetings' }))

    await expect
      .element(screen.getByRole('heading', { name: 'Meetings', exact: true }))
      .toBeInTheDocument()
    await expect.element(drawer).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/meetings')
  })

  it('preserves a deep link and renders the meeting 404 boundary without media access', async () => {
    const detailRead = vi.mocked(coreApi.getWithMetaAndEtag)
    detailRead.mockRejectedValue(apiError(404, 'Meeting missing'))
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia')

    const { router, screen } = await renderGeneratedRoute(
      `/meetings/${meetingId}`
    )

    await expect
      .element(screen.getByText('Meeting not found or unavailable'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Meeting intelligence workspace'))
      .not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe(`/meetings/${meetingId}`)
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('redirects a protected deep link for 401 and keeps a 403 session denied', async () => {
    const authRead = vi.mocked(coreApi.get)
    authRead.mockRejectedValue(apiError(401, 'Authentication required'))
    const anonymous = await renderGeneratedRoute('/calendar')

    await expect
      .poll(() => anonymous.router.state.location.pathname)
      .toBe('/sign-in')
    await expect
      .element(anonymous.screen.getByRole('button', { name: 'Sign in' }))
      .toBeInTheDocument()
    anonymous.screen.unmount()

    authRead.mockReset()
    authRead.mockImplementation(async (url) => {
      if (url === '/auth/me') throw apiError(403, 'Forbidden')
      throw new Error(`Unexpected Core GET ${url}`)
    })
    const denied = await renderGeneratedRoute('/calendar')

    await expect
      .element(denied.screen.getByText('Access denied'))
      .toBeInTheDocument()
    expect(denied.router.state.location.pathname).toBe('/calendar')
  })

  it('renders a truthful empty meeting state', async () => {
    const listRead = vi.mocked(coreApi.getWithMeta)
    listRead.mockImplementation(async (url) => {
      if (url === '/meetings') return emptyList as never
      throw new Error(`Unexpected Core GET with meta ${url}`)
    })
    const { screen } = await renderGeneratedRoute('/meetings')

    await expect
      .element(screen.getByText('No accessible meetings.', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'New Meeting' }))
      .toBeInTheDocument()
  })

  it.each([
    [409, 'Conflict'],
    [412, 'Precondition failed'],
    [429, 'Too many requests'],
    [503, 'Core unavailable'],
  ] as const)(
    'renders the recoverable meeting-list failure for HTTP %s',
    async (status, message) => {
      const listRead = vi.mocked(coreApi.getWithMeta)
      listRead.mockRejectedValue(apiError(status, message))
      const { screen } = await renderGeneratedRoute('/meetings')

      await expect
        .element(
          screen.getByText('Meetings could not be loaded', { exact: true })
        )
        .toBeInTheDocument()
      await expect
        .element(screen.getByRole('button', { name: 'Try again' }))
        .toBeInTheDocument()
    }
  )

  it('renders the malformed-response failure instead of falling back to local meetings', async () => {
    const listRead = vi.mocked(coreApi.getWithMeta)
    listRead.mockImplementation(async (url) => {
      if (url === '/meetings') return { data: [], meta: {} } as never
      throw new Error(`Unexpected Core GET with meta ${url}`)
    })
    const { screen } = await renderGeneratedRoute('/meetings')

    await expect
      .element(
        screen.getByText('Meetings could not be loaded', { exact: true })
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Try again' }))
      .toBeInTheDocument()
  })
})
