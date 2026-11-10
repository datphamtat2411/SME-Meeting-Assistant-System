import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import type { MeetingView } from './data/detail-api'
import type { MeetingListResponse } from './data/list-api'
import { LiveMeetingPage } from './live-meeting'

const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { success: toastSuccess },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
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

const inProgressMeeting = {
  id: 'meeting-1',
  title: 'Authorized roadmap review',
  description: 'A server-backed meeting description.',
  organizerUserId: 'organizer-1',
  roomId: 'room-1',
  scheduledStartAt: '2026-09-01T09:00:00+07:00',
  scheduledEndAt: '2026-09-01T10:00:00+07:00',
  status: 'IN_PROGRESS' as const,
  startedAt: '2026-09-01T09:01:00+07:00',
  endedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: 'organizer-1',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T09:01:00Z',
}

function createMeetingListResponse(meeting: MeetingView): MeetingListResponse {
  return {
    meetings: [
      {
        id: meeting.id,
        title: meeting.title,
        description: meeting.description,
        organizerUserId: meeting.organizerUserId,
        roomId: meeting.roomId,
        scheduledStartAt: meeting.scheduledStartAt,
        scheduledEndAt: meeting.scheduledEndAt,
        status: meeting.status,
        startedAt: meeting.startedAt,
        endedAt: meeting.endedAt,
        cancelledAt: meeting.cancelledAt,
        createdAt: meeting.createdAt,
        updatedAt: meeting.updatedAt,
        display: {
          organizerName: 'Organizer',
          roomName: 'Room',
          roomLocation: 'HQ',
          participantCount: 0,
          participantPreview: [],
        },
      },
    ],
    pagination: {
      page: 0,
      size: 10,
      totalElements: 1,
      totalPages: 1,
      hasNext: false,
      hasPrevious: false,
    },
  }
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

async function renderLive(
  meeting: MeetingView = inProgressMeeting,
  etag = 'etag-current',
  refreshedMeeting?: MeetingView
) {
  let detailCall = 0
  vi.spyOn(coreApi, 'getWithMetaAndEtag').mockImplementation(async () => {
    detailCall += 1
    return {
      data: detailCall === 1 ? meeting : (refreshedMeeting ?? meeting),
      meta: {},
      etag,
    }
  })
  const queryClient = createQueryClient()
  queryClient.setQueryData(currentUserQueryKey, {
    userId: 'organizer-1',
    displayName: 'Organizer',
  })
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <LiveMeetingPage meetingId='meeting-1' />
    </QueryClientProvider>
  )
  return { queryClient, screen }
}

describe('LiveMeetingPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    toastSuccess.mockReset()
  })

  it('loads canonical detail data and exposes only lifecycle navigation and End', async () => {
    const { screen } = await renderLive()

    await expect
      .element(
        screen.getByRole('heading', { name: 'Authorized roadmap review' })
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Live', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'End meeting' }))
      .toBeInTheDocument()
    await expect
      .element(
        screen.getByText(
          /Frontend simulation|Live Transcript|Upload Recording|Elapsed time/i
        )
      )
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('link', { name: 'Back to Meetings' }))
      .toHaveAttribute('href', '/meetings')
    await expect
      .element(screen.getByRole('link', { name: 'View meeting workspace' }))
      .toHaveAttribute('href', '/meetings/meeting-1')
  })

  it('ends the canonical live meeting and renders its terminal state after confirmation', async () => {
    const endedMeeting = {
      ...inProgressMeeting,
      status: 'ENDED' as const,
      endedAt: '2026-09-01T10:01:00+07:00',
      updatedAt: '2026-09-01T10:01:00+07:00',
    }
    const endSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockResolvedValue({
      data: endedMeeting,
      meta: {},
      etag: 'etag-ended',
    })
    const { queryClient, screen } = await renderLive(
      inProgressMeeting,
      'etag-current',
      endedMeeting
    )
    queryClient.setQueryData(
      ['meetings', 'list', { page: 1 }],
      createMeetingListResponse(inProgressMeeting)
    )

    await userEvent.click(screen.getByRole('button', { name: 'End meeting' }))
    await userEvent.click(
      screen.getByRole('alertdialog').getByRole('button', {
        name: 'End meeting',
      })
    )

    await expect.poll(() => endSpy.mock.calls.length).toBe(1)
    await expect
      .element(screen.getByText('Completed', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('heading', { name: 'Meeting has ended' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'End meeting' }))
      .not.toBeInTheDocument()
    expect(
      queryClient.getQueryData<MeetingListResponse>([
        'meetings',
        'list',
        { page: 1 },
      ])?.meetings[0]?.status
    ).toBe('ENDED')
    expect(endSpy).toHaveBeenCalledWith('/meetings/meeting-1/end', undefined, {
      headers: { 'If-Match': 'etag-current' },
    })
  })

  it('does not offer a simulated start flow for a scheduled meeting', async () => {
    const scheduled = {
      ...inProgressMeeting,
      status: 'SCHEDULED' as const,
      startedAt: null,
    }
    const { screen } = await renderLive(scheduled)

    await expect
      .element(screen.getByText('Upcoming', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Start meeting' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'End meeting' }))
      .not.toBeInTheDocument()
    await expect
      .element(
        screen.getByRole('link', { name: 'Return to the meeting workspace' })
      )
      .toBeInTheDocument()
  })

  it('keeps inaccessible detail errors truthful and retryable', async () => {
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({ status: 404, message: 'missing', kind: 'http' })
    )
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <LiveMeetingPage meetingId='secret-meeting' />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('Meeting not found or unavailable'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Retry' }))
      .toBeInTheDocument()
  })
})
