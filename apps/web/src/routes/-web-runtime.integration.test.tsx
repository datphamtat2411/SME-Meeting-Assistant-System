import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { containProtectedState } from '@/protected-state-containment'
import { routeTree } from '@/routeTree.gen'
import { clearCookies } from '@/test-utils/cookies'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { CoreApiError, coreApi, resetCsrfToken } from '@/lib/core-api'
import { DirectionProvider } from '@/context/direction-provider'
import { FontProvider } from '@/context/font-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { ActionCommands } from '@/features/action-items/action-commands'
import { resetAuthLifecycleAfterSignIn } from '@/features/auth/session/auth-lifecycle'
import { configureSessionRevalidation } from '@/features/auth/session/session-revalidation'
import { MinutesPanel } from '@/features/meetings/intelligence/minutes-panel'

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
const emptyActionItemList = {
  data: [],
  meta: {
    pagination: {
      ...pagination,
      size: 5,
    },
  },
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

const dashboardAsOf = '2026-11-23T10:30:00Z'
const dashboard = {
  asOf: dashboardAsOf,
  timezone: 'Asia/Ho_Chi_Minh',
  upcomingWindow: {
    fromInclusive: dashboardAsOf,
    toExclusive: '2026-12-07T10:30:00Z',
    limit: 10,
  },
  recentWindow: {
    fromInclusive: '2026-10-24T10:30:00Z',
    toExclusive: dashboardAsOf,
    limit: 10,
  },
  meetingCountsByState: { SCHEDULED: 0, IN_PROGRESS: 1 },
  upcomingMeetings: [],
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

function assignedWork(status: 'OPEN' | 'IN_PROGRESS') {
  return {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    meetingId,
    title: 'Authorized assigned work',
    details: null,
    status,
    assigneeUserId: userId,
    dueDate: '2026-11-24',
    overdue: true,
    sourceType: 'MANUAL',
    processingJobId: null,
    transcriptId: null,
    contentRevision: null,
    createdByUserId: userId,
    confirmedByUserId: null,
    confirmedAt: null,
    completedByUserId: null,
    completedAt: null,
    cancelledByUserId: null,
    cancelledAt: null,
    version: 1,
    createdAt: dashboardAsOf,
    updatedAt: dashboardAsOf,
    isOfficial: true,
    capabilities: {
      canEdit: false,
      canAssign: false,
      canConfirm: false,
      canReject: false,
      canStart: true,
      canComplete: true,
      canCancel: false,
      canReopen: false,
      canAccessMeeting: false,
      canAccessEvidence: false,
    },
    assignee: { id: userId, displayName: identity.displayName, active: true },
    meeting: { id: meetingId, label: 'Restricted meeting', restricted: true },
    evidence: {
      availability: 'RESTRICTED',
      transcriptId: null,
      contentRevision: null,
      freshness: 'RESTRICTED',
      references: [],
      limitation: null,
    },
  }
}

type FixtureOptions = {
  identity?: unknown
  dashboard?: unknown
  managementError?: unknown
  managementUnitIds?: string[]
  managementActionItems?: {
    open: number
    inProgress: number
    done: number
    cancelled: number
    overdue: number
    totalOfficial: number
  }
  minutes?: unknown
  actionItemsError?: unknown
  actionItemsFailureStatus?: 'OPEN' | 'IN_PROGRESS'
  actionItemsOpen?: unknown
  actionItemsInProgress?: unknown
  meetingList?: unknown
  meetingListError?: unknown
  meetingDetail?: unknown
  meetingDetailError?: unknown
  meetingParticipantsError?: unknown
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
  const get = vi
    .spyOn(coreApi, 'get')
    .mockImplementation(async (url, config) => {
      if (url === '/auth/me') return (options.identity ?? identity) as never
      if (url === '/dashboard/me')
        return (options.dashboard ?? dashboard) as never
      if (url === '/dashboard/management') {
        if (options.managementError) throw options.managementError
        return {
          asOf: dashboardAsOf,
          timezone: dashboard.timezone,
          period: {
            fromInclusive: config?.params?.from,
            toExclusive: config?.params?.to,
            cohortTimeField: 'ACTION_ITEM_CREATED_AT',
            statusTimeSemantics: 'CURRENT_STATE',
          },
          scope: {
            type: 'MANAGED_OFFICIAL_ACTION_ITEMS',
            organizationalUnitIds: config?.params?.orgUnitId
              ? [config.params.orgUnitId]
              : (options.managementUnitIds ?? []),
          },
          actionItems: options.managementActionItems ?? {
            open: 3,
            inProgress: 4,
            done: 5,
            cancelled: 1,
            overdue: 2,
            totalOfficial: 13,
          },
          unavailableMetrics: [
            {
              metric: 'COMPLETION_RATE',
              reason: 'PRODUCT_DENOMINATOR_AND_COHORT_POLICY_NOT_APPROVED',
            },
          ],
        } as never
      }
      if (url === `/meetings/${meetingId}/minutes` && options.minutes)
        return options.minutes as never
      if (url === '/me/profile') return profile as never
      if (url === '/me/preferences') return preferences as never
      if (url.endsWith(`/meetings/${meetingId}/media`)) return [] as never
      throw new Error(`Unexpected Core GET ${url}`)
    })

  const getWithMeta = vi
    .spyOn(coreApi, 'getWithMeta')
    .mockImplementation(async (url, config) => {
      if (url === '/meetings') {
        if (options.meetingListError) throw options.meetingListError
        return (options.meetingList ?? meetingList) as never
      }
      if (url === '/action-items') {
        if (
          config?.params?.status ===
            (options.actionItemsFailureStatus ?? 'IN_PROGRESS') &&
          options.actionItemsError
        ) {
          throw options.actionItemsError
        }
        if (config?.params?.status === 'OPEN' && options.actionItemsOpen) {
          return options.actionItemsOpen as never
        }
        if (
          config?.params?.status === 'IN_PROGRESS' &&
          options.actionItemsInProgress
        ) {
          return options.actionItemsInProgress as never
        }
        return emptyActionItemList as never
      }
      if (url === '/rooms') return emptyList as never
      if (url === '/users') return emptyList as never
      if (url === '/organizational-units') {
        const ids = options.managementUnitIds ?? []
        return {
          data: ids.map((id, index) => ({
            id,
            name: 'Unit ' + (index + 1),
            code: 'UNIT-' + (index + 1),
            parentId: null,
            status: 'ACTIVE',
          })),
          meta: {
            pagination: {
              ...pagination,
              size: 100,
              totalElements: ids.length,
              totalPages: ids.length ? 1 : 0,
            },
          },
        } as never
      }
      if (url.endsWith(`/meetings/${meetingId}/participants`)) {
        if (options.meetingParticipantsError)
          throw options.meetingParticipantsError
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
  height = 800,
  supplement?: React.ReactNode
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
            {supplement}
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
    ['/sign-up', 'Activate your account', 'Back to sign in', '/sign-in'],
    ['/account-setup', 'Activate your account', 'Back to sign in', '/sign-in'],
    [
      '/otp',
      'Reset your password',
      'Request a new reset link',
      '/forgot-password',
    ],
    [
      '/reset-password',
      'Reset your password',
      'Request a new reset link',
      '/forgot-password',
    ],
  ] as const)(
    'renders the public callback %s and requires a capability',
    async (path, title, action, destination) => {
      const post = vi
        .spyOn(coreApi, 'post')
        .mockRejectedValue(
          new Error('Unexpected account-flow mutation without a capability')
        )
      const { screen, router } = await renderGeneratedRoute(path)

      await expect
        .element(screen.getByText(title, { exact: true }))
        .toBeVisible()
      await expect
        .element(screen.getByRole('alert'))
        .toHaveTextContent(/link is missing or invalid/i)
      await expect
        .element(screen.getByLabelText('New password'))
        .not.toBeInTheDocument()
      await expect
        .element(screen.getByLabelText('Confirm password'))
        .not.toBeInTheDocument()
      await expect
        .element(screen.getByRole('link', { name: action, exact: true }))
        .toHaveAttribute('href', destination)
      expect(router.state.location.pathname).toBe(path)
      expect(post).not.toHaveBeenCalled()
    }
  )

  it('renders password recovery and acknowledges a request without revealing account existence', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValue({ message: 'Acknowledged' })
    const { screen, router } = await renderGeneratedRoute('/forgot-password')

    await expect
      .element(screen.getByText('Forgot password', { exact: true }))
      .toBeVisible()
    const email = screen.getByRole('textbox', { name: 'Organization email' })
    const submit = screen.getByRole('button', { name: 'Send recovery link' })
    await expect.element(submit).toBeDisabled()
    expect(post).not.toHaveBeenCalled()
    await userEvent.fill(email, 'operator@example.test')
    await userEvent.click(submit)
    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent(/If an eligible account exists/i)
    expect(post).toHaveBeenCalledExactlyOnceWith(
      '/auth/password-recovery',
      { email: 'operator@example.test' },
      { timeout: 30_000 }
    )
    expect(router.state.location.pathname).toBe('/forgot-password')
    await expect
      .element(screen.getByRole('link', { name: 'Return to sign in' }))
      .toHaveAttribute('href', '/sign-in')
  })

  it('renders the public route /sign-in-2', async () => {
    const { screen } = await renderGeneratedRoute('/sign-in-2')

    await expect
      .element(screen.getByText('Sign in', { exact: true }).first())
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
      if (path === '/') {
        await expect
          .element(
            screen.getByRole('heading', {
              name: 'Welcome back, ' + identity.displayName,
            })
          )
          .toBeVisible()
        await expect
          .element(screen.getByText('Scheduled meetings'))
          .toBeInTheDocument()
        await expect
          .element(screen.getByText('No upcoming meeting', { exact: true }))
          .toBeInTheDocument()
      }
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

  it('restores the featured meeting with bounded authorized enrichment and contains access loss', async () => {
    const scheduled = {
      ...meeting,
      title: 'Next planning meeting',
      status: 'SCHEDULED',
      startedAt: null,
      scheduledStartAt: '2026-11-24T10:00:00Z',
      scheduledEndAt: '2026-11-24T11:00:00Z',
    }
    const options: FixtureOptions = {
      dashboard: {
        ...dashboard,
        meetingCountsByState: { SCHEDULED: 1 },
        upcomingMeetings: [scheduled],
      },
      meetingDetail: scheduled,
    }
    const { getWithMetaAndEtag } = installCoreFixtures(options)
    const { queryClient, screen } = await renderGeneratedRoute('/')
    await expect
      .element(screen.getByRole('heading', { name: scheduled.title }))
      .toBeVisible()
    await expect
      .element(screen.getByText('1 active participants'))
      .toBeVisible()
    await expect.element(screen.getByText('No room assigned')).toBeVisible()
    await expect
      .element(screen.getByRole('link', { name: 'Open meeting workspace' }))
      .toHaveAttribute('href', '/meetings/' + meetingId)
    const time = (value: string) =>
      new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: preferences.timezone,
      }).format(new Date(value))
    await expect
      .element(
        screen.getByText(
          time(scheduled.scheduledStartAt) +
            ' – ' +
            time(scheduled.scheduledEndAt),
          { exact: true }
        )
      )
      .toBeVisible()
    expect(
      getWithMetaAndEtag.mock.calls.filter(([url]) =>
        url.startsWith('/meetings/')
      )
    ).toHaveLength(1)

    options.meetingDetailError = apiError(403)
    await queryClient.invalidateQueries({
      queryKey: ['meetings', 'detail', meetingId],
    })
    await expect
      .element(
        screen.getByText('You do not have permission to access this resource.')
      )
      .toBeVisible()
    await expect
      .element(screen.getByText(scheduled.title, { exact: true }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('link', { name: 'Open meeting workspace' }))
      .not.toBeInTheDocument()
  })

  it.each(['OPEN', 'IN_PROGRESS'] as const)(
    'contains a failed %s query and recovers the bounded assigned-work preview',
    async (failedStatus) => {
      const successfulStatus = failedStatus === 'OPEN' ? 'IN_PROGRESS' : 'OPEN'
      const assigned = assignedWork(successfulStatus)
      const successPage = {
        data: [assigned],
        meta: {
          pagination: {
            ...pagination,
            size: 5,
            totalElements: 1,
            totalPages: 1,
          },
        },
      }
      const options: FixtureOptions = {
        actionItemsError: apiError(503, 'Work unavailable'),
        actionItemsFailureStatus: failedStatus,
        actionItemsOpen: successfulStatus === 'OPEN' ? successPage : undefined,
        actionItemsInProgress:
          successfulStatus === 'IN_PROGRESS' ? successPage : undefined,
      }
      const { getWithMeta } = installCoreFixtures(options)
      const { screen } = await renderGeneratedRoute('/')
      await expect.element(screen.getByText('Work unavailable')).toBeVisible()
      await expect
        .element(screen.getByText('Pending action items'))
        .toBeVisible()
      await expect
        .element(screen.getByText('No pending assigned work'))
        .not.toBeInTheDocument()
      await expect
        .element(screen.getByText(assigned.title))
        .not.toBeInTheDocument()
      for (const status of ['OPEN', 'IN_PROGRESS']) {
        expect(getWithMeta).toHaveBeenCalledWith(
          '/action-items',
          expect.objectContaining({
            params: expect.objectContaining({ status, size: '5' }),
          })
        )
      }
      options.actionItemsError = undefined
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await expect.element(screen.getByText(assigned.title)).toBeVisible()
      await expect
        .element(screen.getByText('Work unavailable'))
        .not.toBeInTheDocument()
    }
  )

  it('keeps restricted assigned work visible without linking protected meeting context', async () => {
    const assigned = assignedWork('OPEN')
    const { getWithMeta } = installCoreFixtures({
      actionItemsOpen: {
        data: [assigned],
        meta: {
          pagination: {
            ...pagination,
            size: 5,
            totalElements: 1,
            totalPages: 1,
          },
        },
      },
    })
    const { screen } = await renderGeneratedRoute('/')
    await expect.element(screen.getByText(assigned.title)).toBeVisible()
    await expect.element(screen.getByText('Due 2026-11-24')).toBeVisible()
    await expect
      .element(screen.getByText('Overdue', { exact: true }))
      .toBeVisible()
    await expect.element(screen.getByText('Restricted meeting')).toBeVisible()
    await expect
      .element(screen.getByRole('link', { name: 'Restricted meeting' }))
      .not.toBeInTheDocument()
    for (const status of ['OPEN', 'IN_PROGRESS']) {
      expect(getWithMeta).toHaveBeenCalledWith(
        '/action-items',
        expect.objectContaining({
          params: expect.objectContaining({
            status,
            assignee: 'me',
            official: 'true',
            size: '5',
            sort: 'dueDate,asc',
          }),
        })
      )
    }
  })

  it.each(['EMPLOYEE', 'ADMINISTRATOR', 'DEPARTMENT_MANAGER'] as const)(
    'does not request management reports without a managed-unit grant (%s)',
    async (role) => {
      const { get } = installCoreFixtures({
        identity: {
          ...identity,
          globalRole: role,
          directoryManagementScope: {
            allUnits: role === 'ADMINISTRATOR',
            unitIds: [],
          },
        },
      })
      const { screen } = await renderGeneratedRoute('/')
      await expect
        .element(screen.getByText('Pending action items'))
        .toBeVisible()
      if (role === 'DEPARTMENT_MANAGER') {
        await expect
          .element(
            screen.getByText(
              'No active organizational management scope is available.'
            )
          )
          .toBeVisible()
      }
      expect(
        get.mock.calls.some(([url]) => url === '/dashboard/management')
      ).toBe(false)
    }
  )

  it('reconciles a revoked featured meeting membership with the canonical overview', async () => {
    const scheduled = {
      ...meeting,
      title: 'Revoked planning meeting',
      status: 'SCHEDULED',
      startedAt: null,
      scheduledStartAt: '2026-11-24T10:00:00Z',
      scheduledEndAt: '2026-11-24T11:00:00Z',
    }
    const options: FixtureOptions = {
      dashboard: {
        ...dashboard,
        meetingCountsByState: { SCHEDULED: 1 },
        upcomingMeetings: [scheduled],
      },
      meetingDetail: scheduled,
    }
    const { get } = installCoreFixtures(options)
    const { queryClient, screen } = await renderGeneratedRoute('/')
    await expect
      .element(screen.getByText('1 active participants'))
      .toBeVisible()
    options.meetingParticipantsError = apiError(403)
    options.dashboard = {
      ...dashboard,
      upcomingMeetings: [],
      meetingCountsByState: {},
    }
    await queryClient.invalidateQueries({
      queryKey: ['meetings', 'participants', meetingId],
    })
    await expect.element(screen.getByText('No upcoming meetings')).toBeVisible()
    await expect
      .element(screen.getByText(scheduled.title, { exact: true }))
      .not.toBeInTheDocument()
    expect(
      get.mock.calls.filter(([url]) => url === '/dashboard/me').length
    ).toBe(2)
  })

  it('automatically revalidates a revoked management grant', async () => {
    const unitId = '11111111-2222-4333-8444-555555555555'
    const manager = {
      ...identity,
      globalRole: 'DEPARTMENT_MANAGER',
      directoryManagementScope: { allUnits: false, unitIds: [unitId] },
    }
    const options: FixtureOptions = {
      identity: manager,
      managementUnitIds: [unitId],
    }
    const { get } = installCoreFixtures(options)
    const { queryClient, router, screen } = await renderGeneratedRoute('/')
    const dispose = configureSessionRevalidation({
      queryClient,
      onContainment: () => containProtectedState(queryClient),
      onChanged: (preserve) => {
        if (!preserve) void router.invalidate()
      },
    })
    try {
      await expect.element(screen.getByText('Official actions')).toBeVisible()
      const verificationCount = get.mock.calls.filter(
        ([url]) => url === '/auth/me'
      ).length
      options.identity = {
        ...manager,
        directoryManagementScope: { allUnits: false, unitIds: [] },
      }
      options.managementError = apiError(403)
      await queryClient.invalidateQueries({
        queryKey: ['dashboard', 'management'],
      })
      await expect
        .element(
          screen.getByText(
            'No active organizational management scope is available.'
          )
        )
        .toBeVisible()
      await expect
        .element(screen.getByText('Official actions'))
        .not.toBeInTheDocument()
      expect(
        get.mock.calls.filter(([url]) => url === '/auth/me').length
      ).toBeGreaterThan(verificationCount)
    } finally {
      dispose()
    }
  })

  it('applies scoped management filters without changing personal metrics', async () => {
    const unitId = '11111111-2222-4333-8444-555555555555'
    const { get } = installCoreFixtures({
      identity: {
        ...identity,
        globalRole: 'DEPARTMENT_MANAGER',
        directoryManagementScope: { allUnits: false, unitIds: [unitId] },
      },
      managementUnitIds: [unitId],
    })
    const { screen } = await renderGeneratedRoute('/', 390, 844)
    await expect.element(screen.getByText('Official actions')).toBeVisible()
    await expect
      .element(screen.getByText('Reporting limitations'))
      .toBeVisible()
    await expect.element(screen.getByText('Pending action items')).toBeVisible()
    const requests = () =>
      get.mock.calls.filter(([url]) => url === '/dashboard/management')
    expect(requests()).toHaveLength(1)
    await userEvent.selectOptions(
      screen.getByLabelText('Reporting period'),
      '7'
    )
    await userEvent.selectOptions(
      screen.getByLabelText('Organizational scope'),
      unitId
    )
    expect(requests()).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
    await expect.poll(() => requests().length).toBe(2)
    await expect.element(screen.getByText('Scope: Unit 1 (1)')).toBeVisible()
    const params = requests()[1][1]?.params
    expect(params?.orgUnitId).toBe(unitId)
    expect(Date.parse(params?.to) - Date.parse(params?.from)).toBe(7 * 86400000)
  })

  it('reconciles visible personal, managed and Minutes projections after completing official work', async () => {
    const unitId = '11111111-2222-4333-8444-555555555555'
    const assigned = assignedWork('OPEN')
    const item = {
      ...assigned,
      capabilities: { ...assigned.capabilities, canAccessMeeting: true },
      meeting: { id: meetingId, label: meeting.title, restricted: false },
      evidence: {
        ...assigned.evidence,
        availability: 'NOT_APPLICABLE' as const,
        freshness: 'NOT_APPLICABLE' as const,
      },
    }
    const completed = {
      ...item,
      status: 'DONE' as const,
      version: 2,
      overdue: false,
      completedByUserId: userId,
      completedAt: dashboardAsOf,
      capabilities: {
        ...item.capabilities,
        canStart: false,
        canComplete: false,
      },
    }
    const transcriptId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const snapshot = {
      schemaVersion: 1,
      assembledAt: dashboardAsOf,
      sourceFingerprint: 'a'.repeat(64),
      completeness: 'COMPLETE',
      proposalsIncluded: false,
      warnings: [],
      meeting: { ...meeting, status: 'ENDED', endedAt: dashboardAsOf },
      summary: {
        availability: 'AVAILABLE',
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        versionNumber: 1,
        content: 'Canonical Vietnamese meeting summary',
        sourceType: 'HUMAN_EDIT',
        qualityStatus: 'READY',
        transcriptId,
        contentRevision: 1,
        selectionEpoch: 1,
        isStale: false,
        aiWarnings: [],
      },
      confirmedDecisions: [],
      officialActionItems: [item],
      transcript: {
        availability: 'AVAILABLE',
        id: transcriptId,
        versionNumber: 1,
        processingJobId: null,
        languageCode: 'vi',
        status: 'READY',
        contentRevision: 1,
        durationMs: 1000,
        suspiciousSegments: 0,
        unresolvedSegments: 0,
        unresolvedCoverageRegions: 0,
      },
    }
    const options: FixtureOptions = {
      identity: {
        ...identity,
        globalRole: 'DEPARTMENT_MANAGER',
        directoryManagementScope: { allUnits: false, unitIds: [unitId] },
      },
      managementUnitIds: [unitId],
      dashboard: {
        ...dashboard,
        assignedActionItems: { open: 1, inProgress: 0, done: 2, overdue: 1 },
      },
      actionItemsOpen: {
        data: [item],
        meta: {
          pagination: {
            ...pagination,
            size: 5,
            totalElements: 1,
            totalPages: 1,
          },
        },
      },
      minutes: snapshot,
    }
    const { get, getWithMeta, getWithMetaAndEtag } =
      installCoreFixtures(options)
    getWithMetaAndEtag.mockImplementation(async (url) => {
      if (url !== '/action-items/' + item.id)
        throw new Error('Unexpected detail request ' + url)
      return { data: item, meta: {}, etag: '"reviewed"' } as never
    })
    const post = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockImplementation(async (url) => {
        if (url !== '/action-items/' + item.id + '/complete')
          throw new Error('Unexpected mutation ' + url)
        // The mock Core API changes its canonical observations only after
        // the actual reviewed command is submitted. No cache is patched.
        options.dashboard = {
          ...dashboard,
          assignedActionItems: { open: 0, inProgress: 0, done: 3, overdue: 0 },
        }
        options.managementActionItems = {
          open: 2,
          inProgress: 4,
          done: 6,
          cancelled: 1,
          overdue: 1,
          totalOfficial: 13,
        }
        options.actionItemsOpen = emptyActionItemList
        options.minutes = {
          ...snapshot,
          sourceFingerprint: 'b'.repeat(64),
          officialActionItems: [completed],
        }
        return { data: completed, meta: {}, etag: '"completed"' } as never
      })
    const { screen } = await renderGeneratedRoute(
      '/',
      1280,
      800,
      <>
        <ActionCommands item={item} />
        <section aria-label='Canonical Minutes regression'>
          <MinutesPanel meetingId={meetingId} onOpenActions={() => {}} />
        </section>
      </>
    )
    const minutes = screen.getByRole('region', {
      name: 'Canonical Minutes regression',
    })
    const metric = (label: string) =>
      Array.from(document.querySelectorAll('[data-slot="card-content"]'))
        .find((card) => card.querySelector('p')?.textContent === label)
        ?.querySelector('.tabular-nums')?.textContent
    const metrics = () => [
      metric('Pending action items'),
      metric('Completed action items'),
      metric('Pending'),
      metric('Completed'),
    ]
    await expect.poll(metrics).toEqual(['1', '2', '7', '5'])
    await expect.element(minutes.getByText(item.title)).toBeVisible()
    await expect
      .element(minutes.getByText('Open', { exact: true }))
      .toBeVisible()
    const preview = () =>
      screen
        .getByText('My action items', { exact: true })
        .element()
        .closest('[data-slot="card"]')?.textContent
    await expect.poll(preview).toContain(item.title)
    const reads = () => [
      get.mock.calls.filter(([url]) => url === '/dashboard/me').length,
      get.mock.calls.filter(([url]) => url === '/dashboard/management')
        .length,
      get.mock.calls.filter(([url]) => url.endsWith('/minutes')).length,
      getWithMeta.mock.calls.filter(([url]) => url === '/action-items').length,
    ]
    const initialReads = reads()
    await userEvent.click(screen.getByRole('button', { name: 'Complete' }))
    await userEvent.click(
      screen.getByRole('alertdialog').getByRole('button', { name: 'Complete' })
    )
    await expect.poll(metrics).toEqual(['0', '3', '6', '6'])
    await expect
      .element(screen.getByText('No pending assigned work'))
      .toBeVisible()
    await expect.poll(preview).not.toContain(item.title)
    await expect
      .element(minutes.getByText('Done', { exact: true }))
      .toBeVisible()
    await expect
      .element(minutes.getByText('Open', { exact: true }))
      .not.toBeInTheDocument()
    expect(post).toHaveBeenCalledExactlyOnceWith(
      '/action-items/' + item.id + '/complete',
      undefined,
      { headers: { 'If-Match': '"reviewed"' } }
    )
    expect(reads().every((count, index) => count > initialReads[index])).toBe(
      true
    )
  })

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
      .element(screen.getByRole('tab', { name: 'Overview' }))
      .toBeInTheDocument()

    await router.navigate({
      to: '/meetings/$meetingId/live',
      params: { meetingId },
    })
    await expect.element(screen.getByText('Live route')).toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: 'Overview' }))
      .not.toBeInTheDocument()

    router.history.back()
    await expect
      .element(screen.getByRole('tab', { name: 'Overview' }))
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
      .element(screen.getByRole('tab', { name: 'Overview' }))
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
