import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import { MeetingWorkspacePage } from './meeting-workspace'

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
  Header: ({ children }: { children?: React.ReactNode }) => <header>{children}</header>,
}))
vi.mock('@/components/layout/header-actions', () => ({ HeaderActions: () => null }))
vi.mock('@/components/layout/main', () => ({
  Main: ({ children, ...props }: React.ComponentProps<'main'>) => (
    <main {...props}>{children}</main>
  ),
}))

const detail = {
  id: 'meeting-1',
  title: 'Authorized roadmap review',
  description: 'A server-backed meeting description.',
  organizerUserId: 'organizer-1',
  roomId: 'room-1',
  scheduledStartAt: '2026-09-01T09:00:00+07:00',
  scheduledEndAt: '2026-09-01T10:00:00+07:00',
  status: 'ENDED' as const,
  startedAt: '2026-09-01T09:01:00+07:00',
  endedAt: '2026-09-01T10:01:00+07:00',
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: 'organizer-1',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T10:01:00Z',
}

const participants = [
  {
    id: 'membership-1',
    meetingId: 'meeting-1',
    userId: 'user-1',
    addedByUserId: 'organizer-1',
    addedAt: '2026-09-01T00:00:00Z',
    removedAt: null,
    removedByUserId: null,
  },
  {
    id: 'membership-2',
    meetingId: 'meeting-1',
    userId: 'user-2',
    addedByUserId: 'organizer-1',
    addedAt: '2026-09-01T00:30:00Z',
    removedAt: '2026-09-01T08:00:00Z',
    removedByUserId: 'organizer-1',
  },
]

describe('MeetingWorkspacePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders authorized operational metadata without mock intelligence or fabricated participant names', async () => {
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: detail,
      meta: {},
      etag: '"m-meeting-1-7"',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/meetings/meeting-1/participants') {
        return { data: participants, meta: {} }
      }
      if (url === '/rooms/room-1') {
        return { data: { id: 'room-1', name: 'Boardroom', location: 'HQ' }, meta: {} }
      }
      return { data: { id: 'organizer-1', name: 'Lan Nguyen' }, meta: {} }
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(currentUserQueryKey, {
      userId: 'current-user',
      displayName: 'Current User',
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingWorkspacePage meetingId='meeting-1' />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByRole('heading', { name: 'Authorized roadmap review' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Boardroom', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Lan Nguyen', { exact: true }).first())
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Completed', { exact: true }).first())
      .toBeInTheDocument()
    await expect.element(screen.getByText('user-1')).toBeInTheDocument()
    await expect
      .element(screen.getByText('Name unavailable').first())
      .toBeInTheDocument()
    await expect.element(screen.getByText('Removed membership history')).toBeInTheDocument()
    await expect.element(screen.getByText('user-2')).toBeInTheDocument()
    await expect
      .element(screen.getByText(/AI Summary|Ask AI|Export Minutes|Vietnamese Transcript/))
      .not.toBeInTheDocument()
  })

  it('does not fetch participants or render list data when detail is inaccessible', async () => {
    const detailError = new CoreApiError({
      message: 'Meeting not found',
      status: 404,
      kind: 'http',
    })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockRejectedValue(detailError)
    const participantSpy = vi.spyOn(coreApi, 'getWithMeta')

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingWorkspacePage meetingId='secret-meeting' />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('Meeting not found or unavailable'))
      .toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(participantSpy).not.toHaveBeenCalled()
  })
})
