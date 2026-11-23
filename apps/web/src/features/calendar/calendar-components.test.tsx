import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import type { MeetingListItem } from '@/features/meetings/data/list-api'
import type { CalendarDaySegment } from './calendar-api'
import type { CalendarDataPresentation } from './calendar-presentation'
import { CalendarToolbar } from './calendar-toolbar'
import { CalendarAgendaView, CalendarMonthView } from './calendar-views'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({
      children,
      to,
      params,
      ...props
    }: {
      children?: React.ReactNode
      to: string
      params?: { meetingId?: string }
    }) => (
      <a
        href={
          params?.meetingId ? to.replace('$meetingId', params.meetingId) : to
        }
        {...props}
      >
        {children}
      </a>
    ),
  }
})

const scheduledMeeting = (
  id: string,
  title: string,
  start: string,
  end: string,
  overrides: Partial<MeetingListItem> = {}
): MeetingListItem => ({
  id,
  title,
  description: null,
  organizerUserId: 'organizer-1',
  roomId: 'room-1',
  scheduledStartAt: start,
  scheduledEndAt: end,
  status: 'SCHEDULED',
  startedAt: null,
  endedAt: null,
  cancelledAt: null,
  createdAt: null,
  updatedAt: null,
  display: {
    organizerName: 'Lan Nguyen',
    roomName: 'Boardroom',
    roomLocation: 'Floor 2',
    participantCount: 2,
    participantPreview: [
      { userId: 'participant-1', displayName: 'Minh Tran' },
      { userId: 'participant-2', displayName: 'Mai Do' },
    ],
  },
  ...overrides,
})

const readyState = (
  overrides: Partial<Extract<CalendarDataPresentation, { kind: 'ready' }>> = {}
): CalendarDataPresentation => ({
  kind: 'ready',
  loadedCount: 1,
  totalCount: 1,
  complete: true,
  canLoadMore: false,
  isRefreshing: false,
  isLoadingMore: false,
  filterActive: false,
  ...overrides,
})

const localInstant = (year: number, month: number, day: number, hour: number) =>
  new Date(year, month - 1, day, hour).toISOString()

const segment = (
  meeting: MeetingListItem,
  dayKey: string,
  startAt: string,
  endAt: string,
  continuesFromPreviousDay = false,
  continuesIntoNextDay = false
): CalendarDaySegment => ({
  dayKey,
  meeting,
  originalStartAt: meeting.scheduledStartAt!,
  originalEndAt: meeting.scheduledEndAt!,
  segmentStartAt: startAt,
  segmentEndAt: endAt,
  continuesFromPreviousDay,
  continuesIntoNextDay,
})

describe('Calendar toolbar', () => {
  const baseProps = {
    month: new Date(2026, 11, 1),
    view: 'month' as const,
    filters: { relationship: 'all' as const },
    rooms: [],
    onNavigateMonth: vi.fn(),
    onToday: vi.fn(),
    onViewChange: vi.fn(),
    onFiltersChange: vi.fn(),
  }

  it('emits year-boundary navigation, Today, and view changes', async () => {
    const props = {
      ...baseProps,
      onNavigateMonth: vi.fn(),
      onToday: vi.fn(),
      onViewChange: vi.fn(),
    }
    const screen = await render(<CalendarToolbar {...props} />)

    await expect.element(screen.getByRole('heading')).toHaveTextContent(
      new Date(2026, 11, 1).toLocaleDateString(undefined, {
        month: 'long',
        year: 'numeric',
      })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }))
    await userEvent.click(screen.getByRole('button', { name: 'Today' }))
    await userEvent.click(screen.getByRole('tab', { name: 'Agenda' }))

    expect(props.onNavigateMonth).toHaveBeenCalledWith(1)
    expect(props.onToday).toHaveBeenCalledOnce()
    expect(props.onViewChange).toHaveBeenCalledWith('agenda')
  })

  it('emits relationship, status, room, and reset filter changes', async () => {
    const props = {
      ...baseProps,
      filters: {
        relationship: 'organizer' as const,
        status: 'CANCELLED' as const,
        roomId: 'room-legacy',
      },
      rooms: [
        { id: 'room-legacy', name: 'Archived Room', location: 'Floor 1' },
      ],
      onFiltersChange: vi.fn(),
    }
    const screen = await render(<CalendarToolbar {...props} />)

    await userEvent.click(screen.getByRole('combobox', { name: 'Room' }))
    await expect
      .element(screen.getByRole('option', { name: 'Archived Room' }))
      .toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Relationship' })
    )
    await userEvent.click(screen.getByRole('option', { name: 'Participating' }))
    expect(props.onFiltersChange).toHaveBeenCalledWith({
      relationship: 'participant',
    })

    await userEvent.click(screen.getByRole('button', { name: 'Reset filters' }))
    expect(props.onFiltersChange).toHaveBeenCalledWith({
      relationship: 'all',
      status: undefined,
      roomId: undefined,
      q: undefined,
    })
  })

  it('commits keyword search after a short debounce and uses lifecycle statuses', async () => {
    const props = {
      ...baseProps,
      onFiltersChange: vi.fn(),
    }
    const screen = await render(<CalendarToolbar {...props} />)

    await userEvent.click(screen.getByRole('combobox', { name: 'Status' }))
    await userEvent.click(screen.getByRole('option', { name: 'Cancelled' }))
    expect(props.onFiltersChange).toHaveBeenCalledWith({
      status: 'CANCELLED',
    })

    await userEvent.fill(
      screen.getByRole('searchbox', { name: 'Search meetings' }),
      ' roadmap '
    )
    await vi.waitFor(() => {
      expect(props.onFiltersChange).toHaveBeenCalledWith(
        { q: 'roadmap' },
        { replace: true }
      )
    })
  })
})

describe('Calendar month view', () => {
  it('renders a Monday-first month grid, selected-day interaction, and accessible overflow', async () => {
    const date = new Date(2026, 10, 1)
    const meetings = Array.from({ length: 5 }, (_, index) =>
      (() => {
        const startHour = String(9 + index).padStart(2, '0')
        const endHour = String(10 + index).padStart(2, '0')
        return scheduledMeeting(
          `meeting-${index}`,
          `November event ${index}`,
          `2026-11-02T${startHour}:00:00.000Z`,
          `2026-11-02T${endHour}:00:00.000Z`
        )
      })()
    )
    const segments = meetings.map((item) =>
      segment(item, '2026-11-02', item.scheduledStartAt!, item.scheduledEndAt!)
    )
    const onDaySelect = vi.fn()
    const screen = await render(
      <CalendarMonthView
        month={date}
        segments={segments}
        state={readyState({
          loadedCount: 5,
          totalCount: 7,
          complete: false,
        })}
        today={new Date(2026, 10, 23)}
        onDaySelect={onDaySelect}
      />
    )

    await expect.element(screen.getByRole('table')).toBeInTheDocument()
    await expect
      .element(screen.getByRole('columnheader', { name: 'Monday' }))
      .toBeInTheDocument()
    await expect
      .element(
        screen.getByText('Showing 5 of 7 meetings. The calendar is incomplete.')
      )
      .toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', {
        name: 'Monday, November 2, 2026, 5 meetings',
      })
    )
    expect(onDaySelect).toHaveBeenCalledWith('2026-11-02')
    await userEvent.click(
      screen.getByRole('button', {
        name: /Show 2 more meetings on Monday, November 2, 2026/,
      })
    )
    await expect
      .element(
        screen.getByRole('link', { name: /Open November event 4/ }).first()
      )
      .toBeInTheDocument()
  })

  it('marks adjacent-month dates as not loaded rather than empty scheduling days', async () => {
    const screen = await render(
      <CalendarMonthView
        month={new Date(2026, 10, 1)}
        segments={[]}
        state={readyState()}
      />
    )

    expect(
      screen.getByText('Outside month · schedule not loaded').all()
    ).toHaveLength(12)
  })
})

describe('Calendar agenda view', () => {
  it('groups by occupied local day and preserves original multi-day scheduling', async () => {
    const multiDay = scheduledMeeting(
      'meeting-multi',
      'Multi-day planning',
      localInstant(2026, 11, 1, 22),
      localInstant(2026, 11, 3, 1),
      {
        status: 'DRAFT',
        roomId: null,
        display: {
          organizerName: 'Lan Nguyen',
          roomName: null,
          roomLocation: null,
          participantCount: 2,
          participantPreview: [
            { userId: 'participant-1', displayName: 'Minh Tran' },
            { userId: 'participant-2', displayName: 'Mai Do' },
          ],
        },
      }
    )
    const segments = [
      segment(
        multiDay,
        '2026-11-01',
        localInstant(2026, 11, 1, 22),
        localInstant(2026, 11, 2, 0),
        false,
        true
      ),
      segment(
        multiDay,
        '2026-11-02',
        localInstant(2026, 11, 2, 0),
        localInstant(2026, 11, 3, 0),
        true,
        true
      ),
      segment(
        multiDay,
        '2026-11-03',
        localInstant(2026, 11, 3, 0),
        localInstant(2026, 11, 3, 1),
        true,
        false
      ),
    ]
    const screen = await render(
      <CalendarAgendaView
        month={new Date(2026, 10, 1)}
        segments={segments}
        state={readyState({ loadedCount: 1, totalCount: 1 })}
      />
    )
    const scheduleFormat = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    const expectedOriginalSchedule = `Full meeting schedule: ${scheduleFormat.format(
      new Date(multiDay.scheduledStartAt!)
    )} – ${scheduleFormat.format(new Date(multiDay.scheduledEndAt!))}`

    await expect
      .element(
        screen.getByRole('heading', { name: 'Sunday, November 1, 2026' })
      )
      .toBeInTheDocument()
    expect(
      screen.getByText(expectedOriginalSchedule, { exact: true }).all()
    ).toHaveLength(3)
    await expect
      .element(
        screen.getByText(expectedOriginalSchedule, { exact: true }).first()
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Continues into next day').first())
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Continues from previous day').first())
      .toBeInTheDocument()
    await expect.element(screen.getByText('Draft').first()).toBeInTheDocument()
    await expect
      .element(screen.getByText('Tentative — no room reservation').first())
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Lan Nguyen').first())
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('2 participants').first())
      .toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /Open Multi-day planning/ }).all()
    ).toHaveLength(3)
  })

  it('does not show an empty state for failed or incomplete requests', async () => {
    const failed = await render(
      <CalendarAgendaView
        month={new Date(2026, 10, 1)}
        segments={[]}
        state={{
          kind: 'error',
          error: new Error('offline'),
          onRetry: vi.fn(),
        }}
      />
    )
    await expect.element(failed.getByRole('alert')).toBeInTheDocument()
    await expect
      .element(failed.getByText('No meetings scheduled this month'))
      .not.toBeInTheDocument()
  })
})
