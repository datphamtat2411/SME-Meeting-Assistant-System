import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { routeTree } from '@/routeTree.gen'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { coreApi, resetCsrfToken } from '@/lib/core-api'
import { DirectionProvider } from '@/context/direction-provider'
import { FontProvider } from '@/context/font-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { resetAuthLifecycleAfterSignIn } from '@/features/auth/session/auth-lifecycle'
import type { MeetingListItem } from '@/features/meetings/data/list-api'

vi.mock('react-top-loading-bar', () => ({
  default: () => null,
}))

const user = {
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'calendar-operator@example.test',
  displayName: 'Calendar Operator',
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

const meetingId = '33333333-3333-4333-8333-333333333333'
const selectedRoomId = '11111111-1111-4111-8111-111111111111'

function localInstant(year: number, month: number, day: number, hour: number) {
  return new Date(year, month - 1, day, hour).toISOString()
}

function meetingListItem(
  scheduledStartAt: string,
  scheduledEndAt: string,
  status: MeetingListItem['status'] = 'SCHEDULED',
  title = 'Calendar integration meeting'
): MeetingListItem {
  return {
    id: meetingId,
    title,
    description: null,
    organizerUserId: user.userId,
    roomId: selectedRoomId,
    scheduledStartAt,
    scheduledEndAt,
    status,
    startedAt: null,
    endedAt: null,
    cancelledAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    display: {
      organizerName: 'Calendar Operator',
      roomName: 'Boardroom',
      roomLocation: 'Floor 2',
      participantCount: 1,
      participantPreview: [
        {
          userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          displayName: 'Guest',
        },
      ],
    },
  }
}

function meetingView(
  status: 'DRAFT' | 'SCHEDULED',
  scheduledStartAt: string,
  scheduledEndAt: string
) {
  return {
    id: meetingId,
    title: 'Created from Calendar',
    description: null,
    organizerUserId: user.userId,
    roomId: null,
    scheduledStartAt,
    scheduledEndAt,
    status,
    startedAt: null,
    endedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    createdByUserId: user.userId,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  }
}

function meetingListResponse(meetings: MeetingListItem[]) {
  return {
    data: meetings,
    meta: {
      pagination: {
        page: 0,
        size: 100,
        totalElements: meetings.length,
        totalPages: meetings.length ? 1 : 0,
        hasNext: false,
        hasPrevious: false,
      },
    },
  }
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

async function renderCalendar(initialPath: string) {
  const queryClient = createQueryClient()
  const history = createMemoryHistory({ initialEntries: [initialPath] })
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history,
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
  return { router, history, queryClient, screen }
}

beforeEach(() => {
  vi.restoreAllMocks()
  resetCsrfToken()
  resetAuthLifecycleAfterSignIn()
})

describe('integrated Calendar route', () => {
  it('restores URL state, preserves filters through navigation, and opens contextual creation', async () => {
    const listCalls: Array<Record<string, string>> = []
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url === '/auth/me') return user
      throw new Error(`Unexpected Core API read ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, config) => {
      if (url === '/meetings') {
        listCalls.push(config?.params as Record<string, string>)
        return meetingListResponse([
          meetingListItem(
            localInstant(2027, 11, 5, 10),
            localInstant(2027, 11, 5, 11),
            'CANCELLED',
            'Roadmap Calendar meeting'
          ),
        ])
      }
      if (url === `/meetings/${meetingId}/participants`) {
        return { data: [], meta: {} }
      }
      if (url === `/rooms/${selectedRoomId}`) {
        return {
          data: {
            id: selectedRoomId,
            name: 'Boardroom',
            location: 'Floor 2',
          },
          meta: {},
        }
      }
      throw new Error(`Unexpected Core API metadata read ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: {
        ...meetingView(
          'SCHEDULED',
          localInstant(2027, 11, 5, 10),
          localInstant(2027, 11, 5, 11)
        ),
        title: 'Roadmap Calendar meeting',
        roomId: selectedRoomId,
        status: 'CANCELLED',
      },
      meta: {},
      etag: 'workspace-etag',
    })

    const { router, history, screen } = await renderCalendar(
      `/calendar?month=2027-11&view=agenda&relationship=participant&status=CANCELLED&roomId=${selectedRoomId}&q=roadmap`
    )

    await expect
      .element(
        screen.getByRole('heading', {
          name: 'Roadmap Calendar meeting',
        })
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: 'Agenda' }))
      .toHaveAttribute('aria-selected', 'true')
    expect(listCalls[0]).toMatchObject({
      relationship: 'PARTICIPANT',
      status: 'CANCELLED',
      roomId: selectedRoomId,
      q: 'roadmap',
      size: '100',
    })
    const meetingLink = screen.getByRole('link', {
      name: /Open Roadmap Calendar meeting workspace/,
    })
    await expect
      .element(meetingLink)
      .toHaveAttribute('href', `/meetings/${meetingId}`)

    await userEvent.click(
      screen.getByRole('button', { name: 'Previous month' })
    )
    await expect
      .poll(() => router.state.location.search)
      .toEqual({
        month: '2027-10',
        view: 'agenda',
        relationship: 'participant',
        status: 'CANCELLED',
        roomId: selectedRoomId,
        q: 'roadmap',
      })
    history.back()
    await expect
      .poll(() => router.state.location.search)
      .toMatchObject({
        month: '2027-11',
        view: 'agenda',
        relationship: 'participant',
        status: 'CANCELLED',
        roomId: selectedRoomId,
        q: 'roadmap',
      })

    await userEvent.click(screen.getByRole('button', { name: /Select Friday/ }))
    await userEvent.click(screen.getByRole('button', { name: 'New Meeting' }))
    await expect
      .element(screen.getByLabelText('Date', { exact: true }))
      .toHaveValue('2027-11-05')
    await expect
      .element(screen.getByLabelText('End date'))
      .toHaveValue('2027-11-05')
    await expect.element(screen.getByLabelText('Start time')).toHaveValue('')
    await expect.element(screen.getByLabelText('End time')).toHaveValue('')

    await userEvent.click(screen.getByRole('button', { name: 'Close' }).first())
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }))
    await userEvent.click(screen.getByRole('button', { name: 'New Meeting' }))
    await expect
      .element(screen.getByLabelText('Date', { exact: true }))
      .toHaveValue('')
    await expect.element(screen.getByLabelText('End date')).toHaveValue('')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }).first())
    await userEvent.click(
      screen.getByRole('button', { name: 'Previous month' })
    )
    await userEvent.click(screen.getByRole('tab', { name: 'Month' }))
    await userEvent.click(
      screen.getByRole('button', { name: /outside selected month/ }).first()
    )
    await userEvent.click(screen.getByRole('button', { name: 'New Meeting' }))
    await expect
      .element(screen.getByLabelText('Date', { exact: true }))
      .toHaveValue('')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }).first())

    await userEvent.click(
      screen.getByRole('link', {
        name: /Open Roadmap Calendar meeting workspace/,
      })
    )
    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/meetings/${meetingId}`)
  })

  it('refreshes the current Calendar projection after a confirmed schedule mutation', async () => {
    let scheduled = false
    let committedSchedule: {
      scheduledStartAt: string
      scheduledEndAt: string
    } | null = null
    const listCalls: Array<Record<string, string>> = []
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url === '/auth/me') return user
      throw new Error(`Unexpected Core API read ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, config) => {
      if (url !== '/meetings') {
        throw new Error(`Unexpected Core API metadata read ${url}`)
      }
      listCalls.push(config?.params as Record<string, string>)
      return meetingListResponse(
        scheduled
          ? [
              meetingListItem(
                committedSchedule!.scheduledStartAt,
                committedSchedule!.scheduledEndAt,
                'SCHEDULED',
                'Created from Calendar'
              ),
            ]
          : []
      )
    })
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    vi.spyOn(coreApi, 'postWithMetaAndEtag').mockImplementation(
      async (url, payload) => {
        const schedule = payload as {
          scheduledStartAt?: string
          scheduledEndAt?: string
        }
        if (url === '/meetings') {
          return {
            data: meetingView(
              'DRAFT',
              schedule.scheduledStartAt!,
              schedule.scheduledEndAt!
            ),
            meta: {},
            etag: 'draft-etag',
          }
        }
        if (url === `/meetings/${meetingId}/schedule`) {
          committedSchedule = {
            scheduledStartAt: schedule.scheduledStartAt!,
            scheduledEndAt: schedule.scheduledEndAt!,
          }
          scheduled = true
          return {
            data: meetingView(
              'SCHEDULED',
              schedule.scheduledStartAt!,
              schedule.scheduledEndAt!
            ),
            meta: {},
            etag: 'scheduled-etag',
          }
        }
        throw new Error(`Unexpected Core API mutation ${url}`)
      }
    )

    const { router, screen } = await renderCalendar(
      '/calendar?month=2027-11&relationship=organizer'
    )
    await expect
      .element(screen.getByText('No meetings match these filters this month.'))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'New Meeting' }))
    await expect
      .element(screen.getByLabelText('Date', { exact: true }))
      .toHaveValue('')
    await expect.element(screen.getByLabelText('End date')).toHaveValue('')
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Created from Calendar'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2027-11-10'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )

    await expect
      .element(
        screen.getByRole('link', {
          name: /Open Created from Calendar workspace/,
        })
      )
      .toBeInTheDocument()
    expect(listCalls.length).toBeGreaterThanOrEqual(2)
    expect(router.state.location.search).toEqual({
      month: '2027-11',
      relationship: 'organizer',
    })
    expect(scheduled).toBe(true)
  })
})
