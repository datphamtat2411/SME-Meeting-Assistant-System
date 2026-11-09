import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { MeetingEditDialog } from './meeting-edit-dialog'

const pagination = {
  page: 0,
  size: 20,
  totalElements: 0,
  totalPages: 0,
  hasNext: false,
  hasPrevious: false,
}

const draftMeeting = {
  id: 'meeting-1',
  title: 'Draft meeting',
  description: null,
  organizerUserId: 'organizer-1',
  roomId: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
  status: 'DRAFT' as const,
  startedAt: null,
  endedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: 'organizer-1',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}

const scheduledMeeting = {
  ...draftMeeting,
  roomId: 'room-1',
  scheduledStartAt: '2026-09-01T09:00:00.000Z',
  scheduledEndAt: '2026-09-01T10:00:00.000Z',
  status: 'SCHEDULED' as const,
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function mockRoomQueries() {
  vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
    if (url === '/rooms/availability') {
      return { data: [], meta: { pagination } }
    }
    return {
      data: { id: 'room-1', name: 'Boardroom', location: 'HQ' },
      meta: {},
    }
  })
}

describe('MeetingEditDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('saves DRAFT metadata with PATCH and preserves the returned ETag', async () => {
    const updatedMeeting = { ...draftMeeting, title: 'Updated draft' }
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: updatedMeeting, meta: {}, etag: 'etag-next' })
    const onOpenChange = vi.fn()
    const queryClient = createQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingEditDialog
          open
          onOpenChange={onOpenChange}
          meeting={draftMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Updated draft'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('Meeting changes saved'))
      .toBeInTheDocument()
    expect(patchSpy).toHaveBeenCalledWith(
      '/meetings/meeting-1',
      { title: 'Updated draft' },
      { headers: { 'If-Match': 'etag-current' } }
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['meetings', 'detail', 'meeting-1'],
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['meetings', 'list'],
    })
    expect(
      invalidateSpy.mock.calls.some(
        ([options]) =>
          options?.queryKey?.[0] === 'rooms' &&
          options?.queryKey?.[1] === 'availability'
      )
    ).toBe(false)
  })

  it('PATCHes a DRAFT before scheduling and uses the refreshed ETag', async () => {
    mockRoomQueries()
    const scheduled = {
      ...draftMeeting,
      title: 'Scheduled draft',
      scheduledStartAt: '2026-09-01T02:00:00.000Z',
      scheduledEndAt: '2026-09-01T03:00:00.000Z',
      status: 'SCHEDULED' as const,
    }
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: { ...scheduled, status: 'DRAFT' as const },
        meta: {},
        etag: 'etag-after-patch',
      })
    const scheduleSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: scheduled,
        meta: {},
        etag: 'etag-scheduled',
      })
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={draftMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Scheduled draft'
    )
    await userEvent.fill(screen.getByLabelText('Date'), '2026-09-01')
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Save & Schedule' })
    )

    await expect
      .element(screen.getByText('Meeting scheduled'))
      .toBeInTheDocument()
    expect(patchSpy).toHaveBeenNthCalledWith(
      1,
      '/meetings/meeting-1',
      expect.objectContaining({
        title: 'Scheduled draft',
        scheduledStartAt: expect.any(String),
        scheduledEndAt: expect.any(String),
      }),
      { headers: { 'If-Match': 'etag-current' } }
    )
    expect(scheduleSpy).toHaveBeenCalledWith(
      '/meetings/meeting-1/schedule',
      {
        scheduledStartAt: expect.any(String),
        scheduledEndAt: expect.any(String),
      },
      { headers: { 'If-Match': 'etag-after-patch' } }
    )
  })

  it('reschedules SCHEDULED meetings through PATCH without calling /schedule', async () => {
    mockRoomQueries()
    const updatedMeeting = {
      ...scheduledMeeting,
      scheduledStartAt: '2026-09-02T09:00:00.000Z',
      scheduledEndAt: '2026-09-02T10:00:00.000Z',
    }
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: updatedMeeting, meta: {}, etag: 'etag-next' })
    const postSpy = vi.spyOn(coreApi, 'post')
    postSpy.mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={scheduledMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(screen.getByLabelText('Date'), '2026-09-02')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('Meeting changes saved'))
      .toBeInTheDocument()
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy.mock.calls[0]?.[0]).toBe('/meetings/meeting-1')
    expect(patchSpy.mock.calls[0]?.[2]).toEqual({
      headers: { 'If-Match': 'etag-current' },
    })
    expect(postSpy).toHaveBeenCalledWith(
      '/meeting-schedule-checks',
      expect.objectContaining({ meetingId: 'meeting-1' }),
      undefined
    )
    expect(patchSpy.mock.calls.some(([url]) => url.includes('/schedule'))).toBe(
      false
    )
  })

  it('requires explicit warning confirmation before a scheduling mutation', async () => {
    mockRoomQueries()
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({
        data: { ...scheduledMeeting, title: 'Warning update' },
        meta: {},
        etag: 'etag-next',
      })
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [{ code: 'PARTICIPANT_OVERLAP', userId: 'user-2' }],
    })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={scheduledMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Warning update'
    )
    await userEvent.fill(screen.getByLabelText('Date'), '2026-09-02')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('Participant schedule overlap warning.'))
      .toBeInTheDocument()
    expect(patchSpy).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Schedule anyway' })
    )
    await expect
      .element(screen.getByText('Meeting changes saved'))
      .toBeInTheDocument()
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps stale form values and offers explicit reload after a 412', async () => {
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({
          status: 412,
          code: 'ETAG_MISMATCH',
          message: 'The meeting changed.',
          kind: 'http',
        })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: { ...draftMeeting, title: 'Server title' },
      meta: {},
      etag: 'etag-server',
    })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={draftMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Local unsaved title'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('The meeting changed on the server.'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('textbox', { name: 'Title' }))
      .toHaveValue('Local unsaved title')
    expect(patchSpy).toHaveBeenCalledTimes(1)
    await expect
      .element(screen.getByRole('button', { name: 'Reload latest data' }))
      .toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Reload latest data' }).first()
    )
    await expect
      .element(
        screen.getByRole('heading', {
          name: 'Reload the latest meeting data?',
        })
      )
      .toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Reload latest data' }).last()
    )
    await expect
      .element(screen.getByRole('textbox', { name: 'Title' }))
      .toHaveValue('Server title')
  })

  it('blocks an authoritative room conflict before PATCH or scheduling', async () => {
    mockRoomQueries()
    const patchSpy = vi.spyOn(coreApi, 'patchWithMetaAndEtag')
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: false,
      roomConflict: true,
      room: null,
      warnings: [],
    })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={draftMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(screen.getByLabelText('Date'), '2026-09-01')
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Save & Schedule' })
    )

    await expect
      .element(
        screen.getByText(
          'The selected room is no longer available for this interval. No meeting changes were committed.'
        )
      )
      .toBeInTheDocument()
    expect(patchSpy).not.toHaveBeenCalled()
  })

  it('reconciles a network failure without retrying and preserves local values', async () => {
    vi.spyOn(coreApi, 'patchWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({
        message: 'Connection lost',
        code: 'NETWORK_ERROR',
        kind: 'network',
      })
    )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: draftMeeting,
      meta: {},
      etag: 'etag-server',
    })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={draftMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Local title'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(
        screen.getByText(
          'The operation outcome could not be confirmed. The latest meeting data is available for review; your local edits were preserved.'
        )
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('textbox', { name: 'Title' }))
      .toHaveValue('Local title')
  })

  it('reports a lifecycle conflict without discarding the edited values', async () => {
    vi.spyOn(coreApi, 'patchWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({
        status: 409,
        code: 'MEETING_LIFECYCLE_CONFLICT',
        message: 'The meeting is no longer editable.',
        kind: 'http',
      })
    )
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={draftMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Local lifecycle edit'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(
        screen.getByText(
          'This meeting lifecycle no longer permits editing or scheduling.'
        )
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('textbox', { name: 'Title' }))
      .toHaveValue('Local lifecycle edit')
  })

  it('prevents duplicate PATCH submissions while the first request is pending', async () => {
    let resolvePatch: (value: {
      data: typeof draftMeeting
      meta: Record<string, never>
      etag: string
    }) => void = () => undefined
    const pending = new Promise<{
      data: typeof draftMeeting
      meta: Record<string, never>
      etag: string
    }>((resolve) => {
      resolvePatch = resolve
    })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockReturnValueOnce(pending)
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={draftMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'One request'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await expect
      .element(screen.getByRole('button', { name: 'Saving...' }))
      .toBeDisabled()
    expect(patchSpy).toHaveBeenCalledTimes(1)

    resolvePatch({ data: draftMeeting, meta: {}, etag: 'etag-next' })
    await expect
      .element(screen.getByText('Meeting changes saved'))
      .toBeInTheDocument()
  })
})
