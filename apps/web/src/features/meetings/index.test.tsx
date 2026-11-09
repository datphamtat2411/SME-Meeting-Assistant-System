import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  currentUserQueryKey,
  type AuthContext,
} from '@/features/auth/session/current-user'
import { dateInputToOffsetDateTime, dateInputValue } from './data/date-filters'
import { MeetingsPage } from './index'

type RouterSearchMock = {
  page: number
  pageSize: number
  q: string
  sort: string
  organizerId?: string
}

const routerMock = vi.hoisted(() => ({
  search: {
    page: 2,
    pageSize: 10,
    q: 'roadmap',
    sort: 'createdAt,desc',
  } as RouterSearchMock,
  navigate: vi.fn(),
}))

const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccess,
  },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    getRouteApi: () => ({
      useSearch: () => routerMock.search,
      useNavigate: () => routerMock.navigate,
    }),
    Link: ({
      children,
      to,
      params,
      ...rest
    }: {
      children?: React.ReactNode
      to: string
      params?: { meetingId?: string }
    }) => (
      <a
        href={
          params?.meetingId ? to.replace('$meetingId', params.meetingId) : to
        }
        {...rest}
      >
        {children}
      </a>
    ),
  }
})

vi.mock('@/components/layout/header', () => ({
  Header: ({ children }: { children?: React.ReactNode }) => (
    <header>{children}</header>
  ),
}))
vi.mock('@/components/layout/header-actions', () => ({
  HeaderActions: () => null,
}))
vi.mock('@/components/layout/main', () => ({
  Main: ({ children, ...props }: React.ComponentProps<'main'>) => (
    <main {...props}>{children}</main>
  ),
}))

describe('MeetingsPage', () => {
  beforeEach(() => {
    routerMock.search = {
      page: 1,
      pageSize: 10,
      q: '',
      sort: 'createdAt,desc',
    }
    routerMock.navigate.mockReset()
    toastSuccess.mockReset()
  })

  it('renders API projection fields, unscheduled drafts, canonical status, and links', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/rooms') {
        return {
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
      }

      return {
        data: [
          {
            id: 'meeting-1',
            title: 'Roadmap',
            description: null,
            organizerUserId: 'organizer-1',
            roomId: 'room-1',
            scheduledStartAt: '2026-09-01T09:00:00+07:00',
            scheduledEndAt: '2026-09-01T10:00:00+07:00',
            status: 'IN_PROGRESS',
            createdAt: '2026-09-01T00:00:00Z',
            display: {
              organizerName: 'Lan Nguyen',
              roomName: 'Hoa Sen',
              roomLocation: 'Building A',
              participantCount: 3,
              participantPreview: [
                { userId: 'user-1', displayName: 'Lan Nguyen' },
                { userId: 'user-2', displayName: 'Minh Tran' },
              ],
            },
          },
          {
            id: 'meeting-2',
            title: 'Unscheduled draft',
            description: null,
            organizerUserId: 'organizer-2',
            roomId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            status: 'DRAFT',
            createdAt: '2026-09-01T00:00:00Z',
            display: {
              organizerName: null,
              roomName: null,
              roomLocation: null,
              participantCount: 0,
              participantPreview: [],
            },
          },
          {
            id: 'meeting-3',
            title: 'Unavailable room',
            description: null,
            organizerUserId: 'organizer-3',
            roomId: 'room-missing',
            scheduledStartAt: null,
            scheduledEndAt: null,
            status: 'DRAFT',
            createdAt: '2026-09-01T00:00:00Z',
            display: {
              organizerName: 'Organizer 2',
              roomName: null,
              roomLocation: null,
              participantCount: 0,
              participantPreview: [],
            },
          },
        ],
        meta: {
          pagination: {
            page: 1,
            size: 10,
            totalElements: 3,
            totalPages: 1,
            hasNext: false,
            hasPrevious: true,
          },
        },
      }
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingsPage />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('Organized by Lan Nguyen'))
      .toBeInTheDocument()
    await expect.element(screen.getByText('Hoa Sen')).toBeInTheDocument()
    await expect.element(screen.getByText('Building A')).toBeInTheDocument()
    await expect.element(screen.getByText('3 participants')).toBeInTheDocument()
    await expect
      .element(screen.getByText('Lan Nguyen, Minh Tran +1 more'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('cell', { name: 'Live', exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Unscheduled', { exact: true }).first())
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Unknown organizer'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Room unassigned', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('No room location', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Room unavailable', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Location unavailable', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('link', { name: 'Live' }))
      .toHaveAttribute('href', '/meetings/meeting-1/live')
    await expect
      .element(screen.getByRole('link', { name: 'View Roadmap' }))
      .toHaveAttribute('href', '/meetings/meeting-1')
    await expect
      .element(screen.getByRole('link', { name: 'View Unscheduled draft' }))
      .toHaveAttribute('href', '/meetings/meeting-2')
  })

  it('resets URL-driven discovery state without creating a local meeting', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
      data: [],
      meta: {
        pagination: {
          page: 0,
          size: 10,
          totalElements: 0,
          totalPages: 0,
          hasNext: false,
          hasPrevious: false,
        },
      },
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingsPage />
      </QueryClientProvider>
    )

    await userEvent.click(screen.getByRole('button', { name: 'Reset filters' }))

    expect(routerMock.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: {} })
    )
  })

  it('restores the New Meeting entry point and invalidates the API list after a committed draft', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/rooms') {
        return {
          data: [],
          meta: {
            pagination: {
              page: 0,
              size: 20,
              totalElements: 0,
              totalPages: 0,
              hasNext: false,
              hasPrevious: false,
            },
          },
        }
      }
      return {
        data: [],
        meta: {
          pagination: {
            page: 0,
            size: 10,
            totalElements: 0,
            totalPages: 0,
            hasNext: false,
            hasPrevious: false,
          },
        },
      }
    })
    vi.spyOn(coreApi, 'postWithMetaAndEtag').mockResolvedValue({
      data: {
        id: 'meeting-draft',
        title: 'New draft',
        description: null,
        organizerUserId: 'organizer-1',
        roomId: null,
        scheduledStartAt: null,
        scheduledEndAt: null,
        status: 'DRAFT',
        startedAt: null,
        endedAt: null,
        cancelledAt: null,
        cancellationReason: null,
        createdByUserId: 'organizer-1',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      },
      meta: {},
      etag: 'draft-etag',
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'organizer-1',
      email: 'organizer@example.com',
      displayName: 'Authorized Organizer',
      globalRole: 'EMPLOYEE',
      accountStatus: 'ACTIVE',
      primaryOrgUnitId: null,
      directoryManagementScope: { allUnits: false, unitIds: [] },
      session: {
        id: 'session-1',
        clientType: 'WEB',
        createdAt: '2026-09-01T00:00:00Z',
        lastSeenAt: null,
        absoluteExpiresAt: '2026-09-02T00:00:00Z',
      },
    } as AuthContext)
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingsPage />
      </QueryClientProvider>
    )

    await userEvent.click(screen.getByRole('button', { name: 'New Meeting' }))
    await expect
      .element(screen.getByRole('heading', { name: 'New Meeting' }))
      .toBeInTheDocument()
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'New draft'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save Draft' }))

    await expect
      .element(screen.getByRole('button', { name: 'New Meeting' }))
      .toBeInTheDocument()
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['meetings', 'list'],
    })
    expect(toastSuccess).toHaveBeenCalledWith(
      'Meeting saved as draft',
      expect.objectContaining({
        description:
          'The meeting was saved as DRAFT and has not been scheduled.',
      })
    )
  })

  it('shows durable scheduled success after the creation dialog closes', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/rooms/availability') {
        return {
          data: [],
          meta: {
            pagination: {
              page: 0,
              size: 20,
              totalElements: 0,
              totalPages: 0,
              hasNext: false,
              hasPrevious: false,
            },
          },
        }
      }
      return {
        data: [],
        meta: {
          pagination: {
            page: 0,
            size: 10,
            totalElements: 0,
            totalPages: 0,
            hasNext: false,
            hasPrevious: false,
          },
        },
      }
    })
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    postSpy
      .mockResolvedValueOnce({
        data: {
          id: 'meeting-scheduled',
          title: 'Scheduled from page',
          description: null,
          organizerUserId: 'organizer-1',
          roomId: null,
          scheduledStartAt: '2026-09-01T09:00:00.000Z',
          scheduledEndAt: '2026-09-01T10:00:00.000Z',
          status: 'DRAFT',
          startedAt: null,
          endedAt: null,
          cancelledAt: null,
          cancellationReason: null,
          createdByUserId: 'organizer-1',
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-01T00:00:00Z',
        },
        meta: {},
        etag: 'draft-etag',
      })
      .mockResolvedValueOnce({
        data: {
          id: 'meeting-scheduled',
          title: 'Scheduled from page',
          description: null,
          organizerUserId: 'organizer-1',
          roomId: null,
          scheduledStartAt: '2026-09-01T09:00:00.000Z',
          scheduledEndAt: '2026-09-01T10:00:00.000Z',
          status: 'SCHEDULED',
          startedAt: null,
          endedAt: null,
          cancelledAt: null,
          cancellationReason: null,
          createdByUserId: 'organizer-1',
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-01T00:00:00Z',
        },
        meta: {},
        etag: 'scheduled-etag',
      })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'organizer-1',
      email: 'organizer@example.com',
      displayName: 'Authorized Organizer',
      globalRole: 'EMPLOYEE',
      accountStatus: 'ACTIVE',
      primaryOrgUnitId: null,
      directoryManagementScope: { allUnits: false, unitIds: [] },
      session: {
        id: 'session-1',
        clientType: 'WEB',
        createdAt: '2026-09-01T00:00:00Z',
        lastSeenAt: null,
        absoluteExpiresAt: '2026-09-02T00:00:00Z',
      },
    } as AuthContext)
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingsPage />
      </QueryClientProvider>
    )

    await userEvent.click(screen.getByRole('button', { name: 'New Meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Scheduled from page'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Date', exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Start time', exact: true }),
      '09:00'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'End time', exact: true }),
      '10:00'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )

    await expect
      .element(screen.getByRole('button', { name: 'New Meeting' }))
      .toBeInTheDocument()
    expect(toastSuccess).toHaveBeenCalledWith(
      'Meeting scheduled',
      expect.objectContaining({
        description: 'The meeting was successfully scheduled.',
      })
    )
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['rooms', 'availability'],
    })
  })

  it('does not show scheduled success when page scheduling fails after draft creation', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/rooms/availability') {
        return {
          data: [],
          meta: {
            pagination: {
              page: 0,
              size: 20,
              totalElements: 0,
              totalPages: 0,
              hasNext: false,
              hasPrevious: false,
            },
          },
        }
      }
      return {
        data: [],
        meta: {
          pagination: {
            page: 0,
            size: 10,
            totalElements: 0,
            totalPages: 0,
            hasNext: false,
            hasPrevious: false,
          },
        },
      }
    })
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    vi.spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: {
          id: 'meeting-partial',
          title: 'Partial page meeting',
          description: null,
          organizerUserId: 'organizer-1',
          roomId: null,
          scheduledStartAt: '2026-09-01T09:00:00.000Z',
          scheduledEndAt: '2026-09-01T10:00:00.000Z',
          status: 'DRAFT',
          startedAt: null,
          endedAt: null,
          cancelledAt: null,
          createdByUserId: 'organizer-1',
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-01T00:00:00Z',
        },
        meta: {},
        etag: 'draft-etag',
      })
      .mockRejectedValueOnce(
        new CoreApiError({
          status: 409,
          code: 'ROOM_CONFLICT',
          message: 'The room became unavailable while scheduling.',
          kind: 'http',
        })
      )
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'organizer-1',
      email: 'organizer@example.com',
      displayName: 'Authorized Organizer',
      globalRole: 'EMPLOYEE',
      accountStatus: 'ACTIVE',
      primaryOrgUnitId: null,
      directoryManagementScope: { allUnits: false, unitIds: [] },
      session: {
        id: 'session-1',
        clientType: 'WEB',
        createdAt: '2026-09-01T00:00:00Z',
        lastSeenAt: null,
        absoluteExpiresAt: '2026-09-02T00:00:00Z',
      },
    } as AuthContext)
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingsPage />
      </QueryClientProvider>
    )

    await userEvent.click(screen.getByRole('button', { name: 'New Meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Partial page meeting'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Date', exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Start time', exact: true }),
      '09:00'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'End time', exact: true }),
      '10:00'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )

    await expect
      .element(screen.getByText('Meeting operation did not complete'))
      .toBeInTheDocument()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('keeps inclusive date inputs across month and year boundaries', () => {
    const januaryEnd = dateInputToOffsetDateTime('2026-01-31', true)
    const decemberEnd = dateInputToOffsetDateTime('2026-12-31', true)

    expect(januaryEnd).toContain('2026-02-01T00:00:00')
    expect(decemberEnd).toContain('2027-01-01T00:00:00')
    expect(dateInputValue(januaryEnd, true)).toBe('2026-01-31')
    expect(dateInputValue(decemberEnd, true)).toBe('2026-12-31')
  })

  it('searches organizers through the paginated API and binds selection to URL state', async () => {
    const requests: Array<{ url: string; params?: Record<string, string> }> = []
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, config) => {
      requests.push({
        url,
        params: config?.params as Record<string, string> | undefined,
      })
      if (url === '/meeting-organizers') {
        return {
          data: [{ id: 'organizer-1', name: 'Lan Nguyen' }],
          meta: {
            pagination: {
              page: 0,
              size: 20,
              totalElements: 1,
              totalPages: 1,
              hasNext: false,
              hasPrevious: false,
            },
          },
        }
      }
      return {
        data: [],
        meta: {
          pagination: {
            page: 0,
            size: 10,
            totalElements: 0,
            totalPages: 0,
            hasNext: false,
            hasPrevious: false,
          },
        },
      }
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingsPage />
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('combobox', {
        name: 'Filter meetings by organizer',
      })
    )
    await expect.element(screen.getByText('Lan Nguyen')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: 'Lan Nguyen' }))

    const navigation = routerMock.navigate.mock.calls[
      routerMock.navigate.mock.calls.length - 1
    ]?.[0] as {
      search: (previous: typeof routerMock.search) => typeof routerMock.search
    }
    expect(navigation.search(routerMock.search)).toMatchObject({
      organizerId: 'organizer-1',
      page: undefined,
    })
    expect(requests).toContainEqual({
      url: '/meeting-organizers',
      params: { page: '0', size: '20' },
    })
    expect(requests.some(({ url }) => url.includes('/users'))).toBe(false)
  })

  it('loads room filter options through bounded server pagination', async () => {
    const requests: Array<{ url: string; params?: Record<string, string> }> = []
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, config) => {
      requests.push({
        url,
        params: config?.params as Record<string, string> | undefined,
      })
      if (url === '/rooms') {
        return {
          data: [{ id: 'room-1', name: 'Boardroom', location: 'HQ' }],
          meta: {
            pagination: {
              page: 0,
              size: 20,
              totalElements: 101,
              totalPages: 6,
              hasNext: true,
              hasPrevious: false,
            },
          },
        }
      }
      return {
        data: [],
        meta: {
          pagination: {
            page: 0,
            size: 10,
            totalElements: 0,
            totalPages: 0,
            hasNext: false,
            hasPrevious: false,
          },
        },
      }
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingsPage />
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('combobox', { name: 'Filter meetings by room' })
    )
    await expect.element(screen.getByText('Boardroom - HQ')).toBeInTheDocument()
    expect(requests).toContainEqual({
      url: '/rooms',
      params: { page: '0', size: '20', sort: 'name,asc' },
    })
  })

  it('restores a deep-linked organizer label through the authorized ID lookup', async () => {
    routerMock.search = {
      page: 1,
      pageSize: 10,
      q: '',
      sort: 'createdAt,desc',
      organizerId: 'organizer-deep-link',
    }
    const requests: string[] = []
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      requests.push(url)
      if (url === '/meeting-organizers/organizer-deep-link') {
        return {
          data: { id: 'organizer-deep-link', name: 'Historical Organizer' },
          meta: {},
        }
      }
      return {
        data: [],
        meta: {
          pagination: {
            page: 0,
            size: 10,
            totalElements: 0,
            totalPages: 0,
            hasNext: false,
            hasPrevious: false,
          },
        },
      }
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingsPage />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('Historical Organizer'))
      .toBeInTheDocument()
    expect(requests).toContain('/meeting-organizers/organizer-deep-link')
  })

  it('shows a retryable failure for organizer lookup options', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/meeting-organizers') {
        throw new Error('organizer lookup failed')
      }
      return {
        data: [],
        meta: {
          pagination: {
            page: 0,
            size: 10,
            totalElements: 0,
            totalPages: 0,
            hasNext: false,
            hasPrevious: false,
          },
        },
      }
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingsPage />
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('combobox', {
        name: 'Filter meetings by organizer',
      })
    )
    await expect
      .element(screen.getByText('Could not load organizer options.'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Try again' }))
      .toBeInTheDocument()
  })
})
