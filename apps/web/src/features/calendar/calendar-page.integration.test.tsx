import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { routeTree } from '@/routeTree.gen'
import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { CoreApiError, coreApi, resetCsrfToken } from '@/lib/core-api'
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

const populatedMeetingIds = {
  roadmap: '44444444-4444-4444-8444-444444444441',
  standup: '44444444-4444-4444-8444-444444444442',
  launch: '44444444-4444-4444-8444-444444444443',
  unassigned: '44444444-4444-4444-8444-444444444444',
  draft: '44444444-4444-4444-8444-444444444445',
  retrospective: '44444444-4444-4444-8444-444444444446',
  release: '44444444-4444-4444-8444-444444444447',
} as const

function populatedMeeting(
  id: string,
  title: string,
  scheduledStartAt: string,
  scheduledEndAt: string,
  status: MeetingListItem['status'],
  roomId: string | null = selectedRoomId
): MeetingListItem {
  const item = meetingListItem(scheduledStartAt, scheduledEndAt, status, title)
  return {
    ...item,
    id,
    organizerUserId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    roomId,
    startedAt: status === 'IN_PROGRESS' ? scheduledStartAt : null,
    endedAt: status === 'ENDED' ? scheduledEndAt : null,
    cancelledAt: status === 'CANCELLED' ? scheduledStartAt : null,
    display: {
      organizerName: 'Morgan Rivera',
      roomName: roomId ? 'Boardroom' : null,
      roomLocation: roomId ? 'Floor 2' : null,
      participantCount: 2,
      participantPreview: [
        { userId: user.userId, displayName: 'Jordan Lee' },
        {
          userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          displayName: 'Casey Park',
        },
      ],
    },
  }
}

function populatedCalendarMeetings() {
  return [
    populatedMeeting(
      populatedMeetingIds.roadmap,
      'Roadmap review',
      localInstant(2027, 11, 5, 9),
      localInstant(2027, 11, 5, 10),
      'CANCELLED'
    ),
    populatedMeeting(
      populatedMeetingIds.standup,
      'Team stand-up',
      localInstant(2027, 11, 5, 10),
      localInstant(2027, 11, 5, 11),
      'SCHEDULED'
    ),
    populatedMeeting(
      populatedMeetingIds.launch,
      'Customer launch',
      localInstant(2027, 11, 5, 11),
      localInstant(2027, 11, 5, 12),
      'IN_PROGRESS'
    ),
    populatedMeeting(
      populatedMeetingIds.unassigned,
      'Department update',
      localInstant(2027, 11, 5, 12),
      localInstant(2027, 11, 5, 13),
      'SCHEDULED',
      null
    ),
    populatedMeeting(
      populatedMeetingIds.draft,
      'Draft preparation',
      localInstant(2027, 11, 5, 13),
      localInstant(2027, 11, 5, 14),
      'DRAFT',
      null
    ),
    populatedMeeting(
      populatedMeetingIds.retrospective,
      'Sprint retrospective',
      localInstant(2027, 11, 5, 14),
      localInstant(2027, 11, 5, 15),
      'ENDED'
    ),
    populatedMeeting(
      populatedMeetingIds.release,
      'Release readiness',
      localInstant(2027, 11, 8, 22),
      localInstant(2027, 11, 10, 1),
      'SCHEDULED'
    ),
  ]
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

async function tabUntil(
  predicate: () => boolean,
  description: string,
  maximumTabs = 180
) {
  for (let index = 0; index < maximumTabs && !predicate(); index += 1) {
    await userEvent.tab()
  }
  expect(predicate(), description).toBe(true)
}

beforeEach(async () => {
  vi.restoreAllMocks()
  resetCsrfToken()
  resetAuthLifecycleAfterSignIn()
  await page.viewport(1440, 900)
})

describe('integrated Calendar route', () => {
  it('restores URL state, preserves filters through navigation, and opens contextual creation', async () => {
    const listCalls: Array<Record<string, string>> = []
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url === '/auth/me') return user
      if (url === '/me/preferences') return { timezone: null, locale: null, meetingEmailEnabled: true, actionItemEmailEnabled: true }
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

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const timeZoneDisclosure = screen.getByRole('note', {
      name: 'Calendar time zone',
    })
    await expect
      .element(timeZoneDisclosure)
      .toHaveTextContent(`Times shown in ${timeZone}`)
    await expect
      .element(timeZoneDisclosure)
      .toHaveTextContent(/UTC[+-]\d{2}:\d{2} today/)

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
      if (url === '/me/preferences') return { timezone: null, locale: null, meetingEmailEnabled: true, actionItemEmailEnabled: true }
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
      .element(
        screen.getByText(
          'No accessible meetings match these filters this month.'
        )
      )
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

  it.each([
    ['month', 'calendar-month-skeleton'],
    ['agenda', 'calendar-agenda-skeleton'],
  ] as const)(
    'shows the %s loading skeleton until the first Calendar page resolves',
    async (view, skeletonTestId) => {
      let resolveMeetings!: (
        response: ReturnType<typeof meetingListResponse>
      ) => void
      const pendingMeetings = new Promise<
        ReturnType<typeof meetingListResponse>
      >((resolve) => {
        resolveMeetings = resolve
      })
      vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
        if (url === '/auth/me') return user
      if (url === '/me/preferences') return { timezone: null, locale: null, meetingEmailEnabled: true, actionItemEmailEnabled: true }
        throw new Error(`Unexpected Core API read ${url}`)
      })
      vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
        if (url === '/meetings') return pendingMeetings
        throw new Error(`Unexpected Core API metadata read ${url}`)
      })

      const { screen } = await renderCalendar(
        `/calendar?month=2027-11&view=${view}`
      )

      await expect
        .element(screen.getByRole('status'))
        .toHaveTextContent('Loading Calendar meetings')
      await expect.element(screen.getByTestId(skeletonTestId)).toBeVisible()

      resolveMeetings(meetingListResponse([]))
      await expect
        .element(screen.getByText('No accessible meetings overlap this month.'))
        .toBeVisible()
    }
  )

  it('shows the session-specific Calendar state after a 401 response', async () => {
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url === '/auth/me') return user
      if (url === '/me/preferences') return { timezone: null, locale: null, meetingEmailEnabled: true, actionItemEmailEnabled: true }
      throw new Error(`Unexpected Core API read ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMeta').mockRejectedValue(
      new CoreApiError({
        message: 'Authentication required',
        status: 401,
        code: 'AUTH_REQUIRED',
        kind: 'http',
      })
    )

    const { screen } = await renderCalendar('/calendar?month=2027-11')

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent(
        'Your session is not authorized to load Calendar meetings.'
      )
    await expect
      .element(screen.getByRole('heading', { name: 'Calendar' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('No accessible meetings overlap this month.'))
      .not.toBeInTheDocument()
  })

  it.each([
    [1440, 900],
    [768, 1024],
    [390, 844],
  ])(
    'renders populated Month and Agenda views without overflow at %sx%s',
    async (width, height) => {
      await page.viewport(width, height)
      const meetings = populatedCalendarMeetings()
      const listCalls: Array<Record<string, string>> = []
      vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
        if (url === '/auth/me') return user
      if (url === '/me/preferences') return { timezone: null, locale: null, meetingEmailEnabled: true, actionItemEmailEnabled: true }
        throw new Error(`Unexpected Core API read ${url}`)
      })
      vi.spyOn(coreApi, 'getWithMeta').mockImplementation(
        async (url, config) => {
          if (url !== '/meetings') {
            throw new Error(`Unexpected Core API metadata read ${url}`)
          }
          listCalls.push(config?.params as Record<string, string>)
          return meetingListResponse(meetings)
        }
      )

      const { router, screen } = await renderCalendar(
        '/calendar?month=2027-11&relationship=participant'
      )
      const assertNoHorizontalOverflow = () => {
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          window.innerWidth
        )
        const grid = document.querySelector(
          'table[aria-label="November 2027 calendar"]'
        )
        if (grid) {
          expect(grid.getBoundingClientRect().width).toBeLessThanOrEqual(
            window.innerWidth
          )
        }
      }

      await expect.element(screen.getByRole('table')).toBeInTheDocument()
      expect(screen.getByRole('columnheader').all()).toHaveLength(7)
      assertNoHorizontalOverflow()
      expect(listCalls[0]).toMatchObject({
        relationship: 'PARTICIPANT',
        size: '100',
      })

      if (width === 390) {
        await expect
          .element(screen.getByText('Fri', { exact: true }))
          .toBeVisible()
        await expect
          .element(screen.getByText('Friday', { exact: true }))
          .not.toBeVisible()
      }

      const denseDayLabel = 'Friday, November 5, 2027, 6 meetings'
      const denseDay = screen.getByRole('button', { name: denseDayLabel })
      await userEvent.click(denseDay)
      await expect.element(denseDay).toHaveAttribute('aria-pressed', 'true')

      if (width === 390) {
        const selectedDay = screen.getByRole('region', {
          name: 'Selected day meetings',
        })
        await expect.element(selectedDay).toBeVisible()
        await expect
          .element(
            screen.getByRole('heading', {
              name: 'Friday, November 5, 2027',
            })
          )
          .toBeVisible()
        for (const title of [
          'Roadmap review',
          'Team stand-up',
          'Customer launch',
          'Department update',
          'Draft preparation',
          'Sprint retrospective',
        ]) {
          await expect
            .element(screen.getByRole('link', { name: new RegExp(title) }))
            .toBeVisible()
        }
      } else {
        const overflow = screen.getByRole('button', {
          name: 'Show 3 more meetings on Friday, November 5, 2027',
        })
        await expect.element(overflow).toHaveAttribute('aria-expanded', 'false')
        await userEvent.click(overflow)
        await expect.element(overflow).toHaveAttribute('aria-expanded', 'true')
        await expect
          .element(
            screen.getByRole('link', { name: /Open Sprint retrospective/ })
          )
          .toBeVisible()
        await expect
          .element(screen.getByRole('link', { name: /Open Draft preparation/ }))
          .toBeVisible()
      }
      assertNoHorizontalOverflow()

      await userEvent.click(screen.getByRole('tab', { name: 'Agenda' }))
      await expect
        .element(screen.getByRole('tab', { name: 'Agenda' }))
        .toHaveAttribute('aria-selected', 'true')
      for (const status of [
        'Cancelled',
        'Upcoming',
        'Live',
        'Draft',
        'Completed',
      ]) {
        await expect
          .element(screen.getByText(status, { exact: true }).first())
          .toBeVisible()
      }
      await expect
        .element(screen.getByText('Room not assigned', { exact: true }).first())
        .toBeVisible()
      await expect
        .element(screen.getByText('Morgan Rivera').first())
        .toBeVisible()
      await expect
        .element(
          screen.getByText(/2 participants · Jordan Lee, Casey Park/).first()
        )
        .toBeVisible()
      await expect
        .element(screen.getByText('Continues into next day').first())
        .toBeVisible()
      await expect
        .element(screen.getByText('Continues from previous day').first())
        .toBeVisible()
      await expect
        .element(screen.getByText(/Full meeting schedule:/).first())
        .toBeVisible()
      expect(
        screen
          .getByRole('link', { name: 'Open Release readiness workspace' })
          .all()
      ).toHaveLength(3)
      await expect
        .element(
          screen.getByRole('link', { name: 'Open Roadmap review workspace' })
        )
        .toHaveAttribute('href', `/meetings/${populatedMeetingIds.roadmap}`)
      assertNoHorizontalOverflow()

      await userEvent.click(screen.getByRole('tab', { name: 'Month' }))
      await expect
        .poll(() => router.state.location.search)
        .toEqual({ month: '2027-11', relationship: 'participant' })
      await userEvent.click(screen.getByRole('tab', { name: 'Agenda' }))
      await expect
        .poll(() => router.state.location.search)
        .toEqual({
          month: '2027-11',
          relationship: 'participant',
          view: 'agenda',
        })
      assertNoHorizontalOverflow()
    }
  )

  it('selects a populated day, expands overflow, and opens its meeting by keyboard', async () => {
    const meetings = populatedCalendarMeetings()
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url === '/auth/me') return user
      if (url === '/me/preferences') return { timezone: null, locale: null, meetingEmailEnabled: true, actionItemEmailEnabled: true }
      throw new Error(`Unexpected Core API read ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/meetings') return meetingListResponse(meetings)
      if (
        url === `/meetings/${populatedMeetingIds.retrospective}/participants`
      ) {
        return { data: [], meta: {} }
      }
      if (url === `/rooms/${selectedRoomId}`) {
        return {
          data: { id: selectedRoomId, name: 'Boardroom', location: 'Floor 2' },
          meta: {},
        }
      }
      throw new Error(`Unexpected Core API metadata read ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: {
        ...meetingView(
          'SCHEDULED',
          localInstant(2027, 11, 5, 14),
          localInstant(2027, 11, 5, 15)
        ),
        id: populatedMeetingIds.retrospective,
        title: 'Sprint retrospective',
        status: 'ENDED',
        roomId: selectedRoomId,
      },
      meta: {},
      etag: 'keyboard-workspace-etag',
    })

    const { router, screen } = await renderCalendar('/calendar?month=2027-11')
    await expect.element(screen.getByRole('table')).toBeInTheDocument()

    const dayLabel = 'Friday, November 5, 2027, 6 meetings'
    await tabUntil(
      () => document.activeElement?.getAttribute('aria-label') === dayLabel,
      'Calendar day should be reachable using Tab'
    )
    await userEvent.keyboard('{Enter}')
    const dayButton = screen.getByRole('button', { name: dayLabel })
    await expect.element(dayButton).toHaveAttribute('aria-pressed', 'true')

    const overflow = screen.getByRole('button', {
      name: 'Show 3 more meetings on Friday, November 5, 2027',
    })
    await tabUntil(
      () =>
        document.activeElement?.getAttribute('aria-label') ===
        'Show 3 more meetings on Friday, November 5, 2027',
      'Dense-day overflow should be reachable using Tab'
    )
    await expect.element(overflow).toHaveAttribute('aria-expanded', 'false')
    expect(
      document.getElementById('calendar-overflow-2027-11-05')?.hidden
    ).toBe(true)

    await userEvent.keyboard('{Enter}')
    await expect.element(overflow).toHaveAttribute('aria-expanded', 'true')
    expect(
      document.getElementById('calendar-overflow-2027-11-05')?.hidden
    ).toBe(false)
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
    expect(document.activeElement?.getAttribute('href')).toBe(
      `/meetings/${populatedMeetingIds.retrospective}`
    )
    await userEvent.keyboard('{Enter}')
    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/meetings/${populatedMeetingIds.retrospective}`)
  })

  it('opens New Meeting and navigates and closes its shared dialog by keyboard', async () => {
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url === '/auth/me') return user
      if (url === '/me/preferences') return { timezone: null, locale: null, meetingEmailEnabled: true, actionItemEmailEnabled: true }
      throw new Error(`Unexpected Core API read ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue(meetingListResponse([]))

    const { screen } = await renderCalendar('/calendar?month=2027-11')
    const newMeeting = screen.getByRole('button', { name: 'New Meeting' })
    await tabUntil(
      () =>
        document.activeElement?.tagName === 'BUTTON' &&
        document.activeElement.textContent?.trim() === 'New Meeting',
      'New Meeting should be reachable using Tab'
    )
    await expect.element(newMeeting).toHaveFocus()
    await userEvent.keyboard('{Enter}')

    await expect
      .element(screen.getByRole('dialog', { name: 'New Meeting' }))
      .toBeVisible()
    await expect
      .element(screen.getByRole('textbox', { name: 'Title' }))
      .toHaveFocus()

    await userEvent.tab()
    expect(document.activeElement?.getAttribute('name')).toBe('description')
    await userEvent.tab()
    expect(document.activeElement?.getAttribute('type')).toBe('date')
    expect(document.activeElement?.getAttribute('name')).toBe('date')
    await tabUntil(
      () => document.activeElement?.getAttribute('name') === 'endDate',
      'End date should be reachable using Tab from the date control',
      8
    )
    await tabUntil(
      () => document.activeElement?.getAttribute('name') === 'startTime',
      'Start time should be reachable using Tab from the end date',
      8
    )

    await userEvent.keyboard('{Escape}')
    await expect
      .element(screen.getByRole('dialog', { name: 'New Meeting' }))
      .not.toBeInTheDocument()
    await expect.element(newMeeting).toHaveFocus()
  })

  it('supports Calendar month and view navigation using the keyboard alone', async () => {
    await page.viewport(1440, 900)
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url === '/auth/me') return user
      if (url === '/me/preferences') return { timezone: null, locale: null, meetingEmailEnabled: true, actionItemEmailEnabled: true }
      throw new Error(`Unexpected Core API read ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue(meetingListResponse([]))
    const { router, screen } = await renderCalendar(
      '/calendar?month=2027-11&relationship=participant&status=CANCELLED&q=roadmap'
    )

    await expect.element(screen.getByRole('table')).toBeInTheDocument()

    for (let index = 0; index < 40; index += 1) {
      if (
        document.activeElement?.getAttribute('aria-label') === 'Previous month'
      ) {
        break
      }
      await userEvent.tab()
    }
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Previous month'
    )
    await userEvent.keyboard('{Enter}')
    await expect
      .poll(() => router.state.location.search)
      .toMatchObject({
        month: '2027-10',
        relationship: 'participant',
        status: 'CANCELLED',
        q: 'roadmap',
      })

    for (let index = 0; index < 40; index += 1) {
      if (
        document.activeElement?.getAttribute('role') === 'tab' &&
        document.activeElement.textContent?.trim() === 'Month'
      ) {
        break
      }
      await userEvent.tab()
    }
    expect(document.activeElement?.textContent?.trim()).toBe('Month')
    await userEvent.keyboard('{ArrowRight}')
    await expect
      .element(screen.getByRole('tab', { name: 'Agenda' }))
      .toHaveAttribute('aria-selected', 'true')
    await expect
      .poll(() => router.state.location.search)
      .toMatchObject({
        month: '2027-10',
        view: 'agenda',
        relationship: 'participant',
        status: 'CANCELLED',
        q: 'roadmap',
      })
  })

  it('restores URL-owned Calendar state after a fresh application mount', async () => {
    const path =
      '/calendar?month=2027-11&view=agenda&relationship=participant&status=CANCELLED&q=roadmap'
    const listCalls: Array<Record<string, string>> = []
    vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
      if (url === '/auth/me') return user
      if (url === '/me/preferences') return { timezone: null, locale: null, meetingEmailEnabled: true, actionItemEmailEnabled: true }
      throw new Error(`Unexpected Core API read ${url}`)
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(
      async (_url, config) => {
        listCalls.push(config?.params as Record<string, string>)
        return meetingListResponse([])
      }
    )

    const firstMount = await renderCalendar(path)
    await expect
      .element(firstMount.screen.getByRole('tab', { name: 'Agenda' }))
      .toHaveAttribute('aria-selected', 'true')
    await expect
      .element(
        firstMount.screen.getByText(
          'No accessible meetings match these filters this month.'
        )
      )
      .toBeInTheDocument()
    await firstMount.screen.unmount()

    const refreshedMount = await renderCalendar(path)
    await expect
      .element(refreshedMount.screen.getByRole('tab', { name: 'Agenda' }))
      .toHaveAttribute('aria-selected', 'true')
    await expect
      .element(
        refreshedMount.screen.getByText(
          'No accessible meetings match these filters this month.'
        )
      )
      .toBeInTheDocument()
    expect(listCalls).toHaveLength(2)
    expect(listCalls[1]).toMatchObject({
      from: listCalls[0]!.from,
      to: listCalls[0]!.to,
      relationship: 'PARTICIPANT',
      status: 'CANCELLED',
      q: 'roadmap',
    })
  })
})
