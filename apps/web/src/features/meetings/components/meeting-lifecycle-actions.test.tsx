import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import type { MeetingView } from '../data/detail-api'
import type { MeetingListResponse } from '../data/list-api'
import { affectsRoomAvailability } from '../data/meeting-cache'
import {
  MeetingLifecycleActions,
  getMeetingLifecycleActions,
} from './meeting-lifecycle-actions'

const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { success: toastSuccess },
}))

function createMeeting(
  status: MeetingView['status'],
  overrides: Partial<MeetingView> = {}
): MeetingView {
  return {
    id: 'meeting-1',
    title: 'Roadmap',
    description: null,
    organizerUserId: 'organizer-1',
    roomId: 'room-1',
    scheduledStartAt: '2026-09-01T02:00:00.000Z',
    scheduledEndAt: '2026-09-01T03:00:00.000Z',
    status,
    startedAt:
      status === 'IN_PROGRESS' || status === 'ENDED'
        ? '2026-09-01T02:01:00.000Z'
        : null,
    endedAt: status === 'ENDED' ? '2026-09-01T03:01:00.000Z' : null,
    cancelledAt: status === 'CANCELLED' ? '2026-09-01T01:00:00.000Z' : null,
    cancellationReason: status === 'CANCELLED' ? 'No longer needed' : null,
    createdByUserId: 'organizer-1',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T03:01:00Z',
    ...overrides,
  }
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

async function renderActions(
  meeting: MeetingView,
  options: { currentUserId?: string; etag?: string } = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <MeetingLifecycleActions
        meeting={meeting}
        etag={options.etag ?? 'etag-current'}
        currentUserId={options.currentUserId ?? 'organizer-1'}
      />
    </QueryClientProvider>
  )
  return { queryClient, screen }
}

describe('MeetingLifecycleActions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    toastSuccess.mockReset()
  })

  it('invalidates room availability for reservation changes without a status change', () => {
    const scheduled = createMeeting('SCHEDULED')
    expect(
      affectsRoomAvailability(scheduled, {
        ...scheduled,
        roomId: 'room-2',
      })
    ).toBe(true)
    expect(
      affectsRoomAvailability(scheduled, {
        ...scheduled,
        scheduledEndAt: '2026-09-01T04:00:00.000Z',
      })
    ).toBe(true)
    expect(
      affectsRoomAvailability(scheduled, {
        ...scheduled,
        title: 'Metadata only',
      })
    ).toBe(false)
    expect(
      affectsRoomAvailability(scheduled, {
        ...scheduled,
        scheduledStartAt: '2026-09-01T09:00:00+07:00',
        scheduledEndAt: '2026-09-01T10:00:00+07:00',
      })
    ).toBe(false)
  })

  it('gates every lifecycle transition by canonical status and organizer ownership', async () => {
    expect(getMeetingLifecycleActions('DRAFT')).toEqual(['cancel'])
    expect(getMeetingLifecycleActions('SCHEDULED')).toEqual(['start', 'cancel'])
    expect(getMeetingLifecycleActions('IN_PROGRESS')).toEqual(['end'])
    expect(getMeetingLifecycleActions('ENDED')).toEqual([])
    expect(getMeetingLifecycleActions('CANCELLED')).toEqual([])

    const { screen } = await renderActions(createMeeting('SCHEDULED'), {
      currentUserId: 'viewer-1',
    })
    await expect
      .element(screen.getByRole('button', { name: 'Start meeting' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Cancel meeting' }))
      .not.toBeInTheDocument()
  })

  it('starts directly and synchronizes the confirmed detail and dependent caches', async () => {
    const started = createMeeting('IN_PROGRESS', {
      startedAt: '2026-09-01T02:02:00.000Z',
      updatedAt: '2026-09-01T02:02:00.000Z',
    })
    const startSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValue({
        data: started,
        meta: {},
        etag: 'etag-started',
      })
    const { queryClient, screen } = await renderActions(
      createMeeting('SCHEDULED')
    )
    queryClient.setQueryData(
      ['meetings', 'list', { page: 1 }],
      createMeetingListResponse(createMeeting('SCHEDULED'))
    )
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await userEvent.click(screen.getByRole('button', { name: 'Start meeting' }))

    await expect
      .element(screen.getByText('Meeting started', { exact: true }))
      .toBeInTheDocument()
    expect(startSpy).toHaveBeenCalledWith(
      '/meetings/meeting-1/start',
      undefined,
      { headers: { 'If-Match': 'etag-current' } }
    )
    expect(
      queryClient.getQueryData(['meetings', 'detail', 'meeting-1'])
    ).toEqual({ meeting: started, etag: 'etag-started' })
    expect(
      queryClient.getQueryData<MeetingListResponse>([
        'meetings',
        'list',
        { page: 1 },
      ])?.meetings[0]?.status
    ).toBe('IN_PROGRESS')
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['meetings', 'detail', 'meeting-1'],
      refetchType: 'none',
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['meetings', 'list'],
    })
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ['rooms', 'availability'],
    })
    expect(toastSuccess).toHaveBeenCalledWith(
      'Meeting started',
      expect.anything()
    )
  })

  it('requires confirmation for End and prevents duplicate submissions while pending', async () => {
    let resolveEnd: ((value: unknown) => void) | undefined
    const endSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEnd = resolve
        }) as never
    )
    const { screen } = await renderActions(createMeeting('IN_PROGRESS'))

    await userEvent.click(screen.getByRole('button', { name: 'End meeting' }))
    await expect.element(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(endSpy).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByRole('alertdialog').getByRole('button', {
        name: 'End meeting',
      })
    )
    await expect.poll(() => endSpy.mock.calls.length).toBe(1)
    await expect
      .element(screen.getByRole('button', { name: 'Ending meeting...' }))
      .toBeDisabled()
    expect(endSpy).toHaveBeenCalledTimes(1)

    resolveEnd?.({
      data: createMeeting('ENDED'),
      meta: {},
      etag: 'etag-ended',
    })
  })

  it('rebuilds a cancelled retry from a refreshed DRAFT to SCHEDULED snapshot', async () => {
    const draftMeeting = createMeeting('DRAFT')
    const scheduledMeeting = createMeeting('SCHEDULED')
    const cancelledMeeting = createMeeting('CANCELLED', {
      cancellationReason: 'Room unavailable',
    })
    const cancelSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({ status: 412, message: 'stale', kind: 'http' })
      )
      .mockResolvedValueOnce({
        data: cancelledMeeting,
        meta: {},
        etag: 'etag-cancelled',
      })
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({
        data: scheduledMeeting,
        meta: {},
        etag: 'etag-refreshed',
      })
    const { queryClient, screen } = await renderActions(draftMeeting)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    queryClient.setQueryData(
      ['meetings', 'list', { page: 1 }],
      createMeetingListResponse(draftMeeting)
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel meeting' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Cancellation reason' }),
      '  Room unavailable  '
    )
    await userEvent.click(
      screen.getByRole('alertdialog').getByRole('button', {
        name: 'Cancel meeting',
      })
    )

    await expect.poll(() => cancelSpy.mock.calls.length).toBe(1)
    await expect.poll(() => detailSpy.mock.calls.length).toBe(1)
    await expect
      .element(screen.getByText(/meeting changed on the server/i))
      .toBeInTheDocument()
    expect(toastSuccess).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByRole('button', { name: 'Retry cancel meeting' })
    )
    await expect
      .element(screen.getByRole('textbox', { name: 'Cancellation reason' }))
      .toHaveValue('  Room unavailable  ')
    await userEvent.click(
      screen.getByRole('alertdialog').getByRole('button', {
        name: 'Cancel meeting',
      })
    )

    await expect.poll(() => cancelSpy.mock.calls.length).toBe(2)
    expect(cancelSpy).toHaveBeenNthCalledWith(
      2,
      '/meetings/meeting-1/cancel',
      { reason: 'Room unavailable' },
      { headers: { 'If-Match': 'etag-refreshed' } }
    )
    expect(
      queryClient.getQueryData(['meetings', 'detail', 'meeting-1'])
    ).toEqual({ meeting: cancelledMeeting, etag: 'etag-cancelled' })
    expect(
      queryClient.getQueryData<MeetingListResponse>([
        'meetings',
        'list',
        { page: 1 },
      ])?.meetings[0]?.status
    ).toBe('CANCELLED')
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['rooms', 'availability'],
    })
    await expect
      .element(screen.getByText('Meeting cancelled', { exact: true }))
      .toBeInTheDocument()
  })

  it('synchronizes an ambiguous Start recovery without claiming confirmation', async () => {
    const scheduledMeeting = createMeeting('SCHEDULED')
    const startedMeeting = createMeeting('IN_PROGRESS', {
      startedAt: '2026-09-01T02:02:00.000Z',
      updatedAt: '2026-09-01T02:02:00.000Z',
    })
    const mutationSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({ data: startedMeeting, meta: {}, etag: 'etag-v2' })
    const { queryClient, screen } = await renderActions(scheduledMeeting)
    queryClient.setQueryData(
      ['meetings', 'list', { page: 1 }],
      createMeetingListResponse(scheduledMeeting)
    )

    await userEvent.click(screen.getByRole('button', { name: 'Start meeting' }))

    await expect
      .element(screen.getByText(/no longer available/i))
      .toBeInTheDocument()
    expect(mutationSpy).toHaveBeenCalledTimes(1)
    expect(detailSpy).toHaveBeenCalledTimes(1)
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(
      queryClient.getQueryData(['meetings', 'detail', 'meeting-1'])
    ).toEqual({ meeting: startedMeeting, etag: 'etag-v2' })
    expect(
      queryClient.getQueryData<MeetingListResponse>([
        'meetings',
        'list',
        { page: 1 },
      ])?.meetings[0]?.status
    ).toBe('IN_PROGRESS')
  })

  it('synchronizes an ambiguous End recovery and invalidates room availability', async () => {
    const inProgressMeeting = createMeeting('IN_PROGRESS')
    const endedMeeting = createMeeting('ENDED')
    const mutationSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: endedMeeting,
      meta: {},
      etag: 'etag-ended',
    })
    const { queryClient, screen } = await renderActions(inProgressMeeting)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
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

    await expect
      .element(screen.getByText(/no longer available/i))
      .toBeInTheDocument()
    expect(mutationSpy).toHaveBeenCalledTimes(1)
    expect(
      queryClient.getQueryData<MeetingListResponse>([
        'meetings',
        'list',
        { page: 1 },
      ])?.meetings[0]?.status
    ).toBe('ENDED')
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['rooms', 'availability'],
    })
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('synchronizes an ambiguous Cancel recovery and preserves neutral feedback', async () => {
    const scheduledMeeting = createMeeting('SCHEDULED')
    const cancelledMeeting = createMeeting('CANCELLED', {
      cancellationReason: 'Room unavailable',
    })
    const mutationSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: cancelledMeeting,
      meta: {},
      etag: 'etag-cancelled',
    })
    const { queryClient, screen } = await renderActions(scheduledMeeting)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    queryClient.setQueryData(
      ['meetings', 'list', { page: 1 }],
      createMeetingListResponse(scheduledMeeting)
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel meeting' })
    )
    await userEvent.click(
      screen.getByRole('alertdialog').getByRole('button', {
        name: 'Cancel meeting',
      })
    )

    await expect
      .element(screen.getByText(/no longer available/i))
      .toBeInTheDocument()
    expect(mutationSpy).toHaveBeenCalledTimes(1)
    expect(
      queryClient.getQueryData<MeetingListResponse>([
        'meetings',
        'list',
        { page: 1 },
      ])?.meetings[0]?.status
    ).toBe('CANCELLED')
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['rooms', 'availability'],
    })
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('reconciles uncertain network failures without claiming success or replaying the mutation', async () => {
    const mutationSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({
        data: createMeeting('IN_PROGRESS'),
        meta: {},
        etag: 'etag-observed',
      })
    const { screen } = await renderActions(createMeeting('IN_PROGRESS'))

    await userEvent.click(screen.getByRole('button', { name: 'End meeting' }))
    await userEvent.click(
      screen.getByRole('alertdialog').getByRole('button', {
        name: 'End meeting',
      })
    )

    await expect.poll(() => mutationSpy.mock.calls.length).toBe(1)
    await expect.poll(() => detailSpy.mock.calls.length).toBe(1)
    await expect
      .element(screen.getByText(/outcome could not be confirmed/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Meeting ended', { exact: true }))
      .not.toBeInTheDocument()
    expect(mutationSpy).toHaveBeenCalledTimes(1)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('retries only detail reconciliation when the first refresh fails', async () => {
    const mutationSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({ message: 'Refresh failed', kind: 'network' })
      )
      .mockResolvedValue({
        data: createMeeting('IN_PROGRESS'),
        meta: {},
        etag: 'etag-after-refresh',
      })
    const { screen } = await renderActions(createMeeting('IN_PROGRESS'))

    await userEvent.click(screen.getByRole('button', { name: 'End meeting' }))
    await userEvent.click(
      screen.getByRole('alertdialog').getByRole('button', {
        name: 'End meeting',
      })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Retry refresh' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'End meeting' }))
      .toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Retry refresh' }))
    await expect.poll(() => detailSpy.mock.calls.length).toBe(2)
    expect(mutationSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['ENDED', 'IN_PROGRESS', 'End meeting', 'end'] as const,
    ['CANCELLED', 'SCHEDULED', 'Cancel meeting', 'cancel'] as const,
  ])(
    'does not offer a retry after reconciliation reaches terminal %s state',
    async (status, initialStatus, actionLabel, action) => {
      const mutationSpy = vi
        .spyOn(coreApi, 'postWithMetaAndEtag')
        .mockRejectedValueOnce(
          new CoreApiError({ status: 412, message: 'stale', kind: 'http' })
        )
      vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
        data: createMeeting(status),
        meta: {},
        etag: 'etag-terminal',
      })
      const { screen } = await renderActions(createMeeting(initialStatus))

      await userEvent.click(screen.getByRole('button', { name: actionLabel }))
      await userEvent.click(
        screen.getByRole('alertdialog').getByRole('button', {
          name: actionLabel,
        })
      )

      await expect
        .element(screen.getByText(/no longer available/i))
        .toBeInTheDocument()
      await expect
        .element(
          screen.getByRole('button', { name: `Retry ${action} meeting` })
        )
        .not.toBeInTheDocument()
      expect(mutationSpy).toHaveBeenCalledTimes(1)
    }
  )

  it('removes retry access when reconciliation reports a different organizer', async () => {
    const mutationSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({ status: 412, message: 'stale', kind: 'http' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: createMeeting('SCHEDULED', { organizerUserId: 'other-user' }),
      meta: {},
      etag: 'etag-other-owner',
    })
    const { screen } = await renderActions(createMeeting('SCHEDULED'))

    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel meeting' })
    )
    await userEvent.click(
      screen.getByRole('alertdialog').getByRole('button', {
        name: 'Cancel meeting',
      })
    )

    await expect
      .element(screen.getByText(/no longer the organizer/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Retry cancel meeting' }))
      .not.toBeInTheDocument()
    expect(mutationSpy).toHaveBeenCalledTimes(1)
  })

  it('does not retry a stale Start intent after the meeting is already live', async () => {
    const mutationSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({ status: 412, message: 'stale', kind: 'http' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: createMeeting('IN_PROGRESS'),
      meta: {},
      etag: 'etag-live',
    })
    const { screen } = await renderActions(createMeeting('SCHEDULED'))

    await userEvent.click(screen.getByRole('button', { name: 'Start meeting' }))

    await expect
      .element(screen.getByText(/no longer available/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Retry start meeting' }))
      .not.toBeInTheDocument()
    expect(mutationSpy).toHaveBeenCalledTimes(1)
  })

  it('does not retry a stale End intent after the meeting is already ended', async () => {
    const mutationSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({ status: 412, message: 'stale', kind: 'http' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: createMeeting('ENDED'),
      meta: {},
      etag: 'etag-ended',
    })
    const { screen } = await renderActions(createMeeting('IN_PROGRESS'))

    await userEvent.click(screen.getByRole('button', { name: 'End meeting' }))
    await userEvent.click(
      screen.getByRole('alertdialog').getByRole('button', {
        name: 'End meeting',
      })
    )

    await expect
      .element(screen.getByText(/no longer available/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Retry end meeting' }))
      .not.toBeInTheDocument()
    expect(mutationSpy).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 404] as const)(
    'does not refresh or retry after an authorization-related %s failure',
    async (status) => {
      const mutationSpy = vi
        .spyOn(coreApi, 'postWithMetaAndEtag')
        .mockRejectedValue(
          new CoreApiError({ status, message: 'denied', kind: 'http' })
        )
      const detailSpy = vi.spyOn(coreApi, 'getWithMetaAndEtag')
      const { screen } = await renderActions(createMeeting('IN_PROGRESS'))

      await userEvent.click(screen.getByRole('button', { name: 'End meeting' }))
      await userEvent.click(
        screen.getByRole('alertdialog').getByRole('button', {
          name: 'End meeting',
        })
      )

      await expect
        .element(
          screen.getByText(
            /no local success was recorded|could not be found|session is no longer authenticated/i
          )
        )
        .toBeInTheDocument()
      expect(mutationSpy).toHaveBeenCalledTimes(1)
      expect(detailSpy).not.toHaveBeenCalled()
      await expect
        .element(screen.getByRole('button', { name: 'End meeting' }))
        .not.toBeInTheDocument()
    }
  )
})
