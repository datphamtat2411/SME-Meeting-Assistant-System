import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CDPSession } from '@vitest/browser-playwright'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { cdp, userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { canonicalizeLocalDateTime } from '../data/meeting-creation-api'
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

const overnightMeeting = {
  ...scheduledMeeting,
  scheduledStartAt: '2026-11-10T16:00:37.123Z',
  scheduledEndAt: '2026-11-10T18:00:42.456Z',
}

const utcOvernightMeeting = {
  ...scheduledMeeting,
  scheduledStartAt: '2026-11-10T23:00:00Z',
  scheduledEndAt: '2026-11-11T01:00:00Z',
}

const utcTimeZone = 'UTC'
const vietnamTimeZone = 'Asia/Ho_Chi_Minh'

async function setBrowserTimeZone(timeZone: string) {
  await (cdp() as unknown as CDPSession).send('Emulation.setTimezoneOverride', {
    timezoneId: timeZone,
  })
}

function localDateInTimeZone(timeZone: string, value: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(value))
      .map(({ type, value: part }) => [type, part])
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function mockRoomQueries() {
  vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
    if (url === '/rooms/availability') {
      return { data: [], meta: { pagination } }
    }
    if (url === '/rooms') {
      return {
        data: [
          { id: 'room-1', name: 'Boardroom', location: 'HQ' },
          { id: 'room-2', name: 'Studio', location: 'HQ' },
        ],
        meta: { pagination },
      }
    }
    if (url === '/rooms/room-2') {
      return {
        data: { id: 'room-2', name: 'Studio', location: 'HQ' },
        meta: {},
      }
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

  it('prefills a same-day meeting with the same start and end date', async () => {
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

    await expect
      .element(screen.getByLabelText('Date', { exact: true }))
      .toHaveValue('2026-09-01')
    await expect
      .element(screen.getByLabelText('End date'))
      .toHaveValue('2026-09-01')
  })

  it('prefills an overnight meeting with different local dates', async () => {
    await setBrowserTimeZone(vietnamTimeZone)
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={overnightMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByLabelText('Date', { exact: true }))
      .toHaveValue(
        localDateInTimeZone(vietnamTimeZone, overnightMeeting.scheduledStartAt)
      )
    await expect
      .element(screen.getByLabelText('End date'))
      .toHaveValue(
        localDateInTimeZone(vietnamTimeZone, overnightMeeting.scheduledEndAt)
      )
  })

  it('prefills an overnight meeting with different UTC dates', async () => {
    await setBrowserTimeZone(utcTimeZone)
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={utcOvernightMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByLabelText('Date', { exact: true }))
      .toHaveValue(
        localDateInTimeZone(utcTimeZone, utcOvernightMeeting.scheduledStartAt)
      )
    await expect
      .element(screen.getByLabelText('End date'))
      .toHaveValue(
        localDateInTimeZone(utcTimeZone, utcOvernightMeeting.scheduledEndAt)
      )
  })

  it('prefills a multi-day meeting with its authoritative end date', async () => {
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={{
            ...scheduledMeeting,
            scheduledStartAt: '2026-09-01T09:00:00.000Z',
            scheduledEndAt: '2026-09-03T10:00:00.000Z',
          }}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByLabelText('Date', { exact: true }))
      .toHaveValue('2026-09-01')
    await expect
      .element(screen.getByLabelText('End date'))
      .toHaveValue('2026-09-03')
  })

  it('preserves an overnight schedule and its timestamp precision for metadata-only PATCH', async () => {
    await setBrowserTimeZone(vietnamTimeZone)
    mockRoomQueries()
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({
        data: { ...overnightMeeting, title: 'Updated overnight meeting' },
        meta: {},
        etag: 'etag-next',
      })
    const queryClient = createQueryClient()
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={overnightMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Updated overnight meeting'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('Meeting changes saved'))
      .toBeInTheDocument()
    expect(patchSpy).toHaveBeenCalledWith(
      '/meetings/meeting-1',
      { title: 'Updated overnight meeting' },
      { headers: { 'If-Match': 'etag-current' } }
    )
    expect(patchSpy.mock.calls[0]?.[1]).not.toHaveProperty('scheduledStartAt')
    expect(patchSpy.mock.calls[0]?.[1]).not.toHaveProperty('scheduledEndAt')
    const detail = queryClient.getQueryData<{
      meeting: typeof overnightMeeting
      etag: string
    }>(['meetings', 'detail', 'meeting-1'])
    expect(detail?.meeting.scheduledStartAt).toBe(
      overnightMeeting.scheduledStartAt
    )
    expect(detail?.meeting.scheduledEndAt).toBe(overnightMeeting.scheduledEndAt)
  })

  it('serializes an explicitly entered overnight interval as two absolute timestamps', async () => {
    mockRoomQueries()
    const start = canonicalizeLocalDateTime('2026-11-10', '23:00')
    const end = canonicalizeLocalDateTime('2026-11-11', '01:00')
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({
        data: {
          ...scheduledMeeting,
          scheduledStartAt: start,
          scheduledEndAt: end,
        },
        meta: {},
        etag: 'etag-next',
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
          meeting={scheduledMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-11-10'
    )
    await userEvent.fill(screen.getByLabelText('End date'), '2026-11-11')
    await userEvent.fill(screen.getByLabelText('Start time'), '23:00')
    await userEvent.fill(screen.getByLabelText('End time'), '01:00')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('Meeting changes saved'))
      .toBeInTheDocument()
    expect(patchSpy).toHaveBeenCalledWith(
      '/meetings/meeting-1',
      { scheduledStartAt: start, scheduledEndAt: end },
      { headers: { 'If-Match': 'etag-current' } }
    )
  })

  it('blocks an end-before-start interval without sending a mutation', async () => {
    mockRoomQueries()
    const patchSpy = vi.spyOn(coreApi, 'patchWithMetaAndEtag')
    const previewSpy = vi.spyOn(coreApi, 'post')
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
      screen.getByLabelText('Date', { exact: true }),
      '2026-11-10'
    )
    await userEvent.fill(screen.getByLabelText('End date'), '2026-11-10')
    await userEvent.fill(screen.getByLabelText('Start time'), '23:00')
    await userEvent.fill(screen.getByLabelText('End time'), '01:00')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(
        screen.getByText(
          'End time must be after start time and use a valid interval.'
        )
      )
      .toBeInTheDocument()
    expect(patchSpy).not.toHaveBeenCalled()
    expect(previewSpy).not.toHaveBeenCalled()
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
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-01'
    )
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

    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-02'
    )
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

  it('includes the authoritative room when rescheduling without changing rooms', async () => {
    await setBrowserTimeZone(utcTimeZone)
    mockRoomQueries()
    const start = canonicalizeLocalDateTime('2026-09-02', '09:00')
    const end = canonicalizeLocalDateTime('2026-09-02', '10:00')
    const updatedMeeting = {
      ...scheduledMeeting,
      scheduledStartAt: start,
      scheduledEndAt: end,
    }
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: updatedMeeting, meta: {}, etag: 'etag-next' })
    const previewSpy = vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const queryClient = createQueryClient()
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={scheduledMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-02'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('Meeting changes saved'))
      .toBeInTheDocument()
    expect(previewSpy).toHaveBeenCalledWith(
      '/meeting-schedule-checks',
      {
        meetingId: 'meeting-1',
        start,
        end,
        roomId: 'room-1',
      },
      undefined
    )
    expect(patchSpy).toHaveBeenCalledWith(
      '/meetings/meeting-1',
      { scheduledStartAt: start, scheduledEndAt: end },
      { headers: { 'If-Match': 'etag-current' } }
    )
    expect(patchSpy.mock.calls[0]?.[1]).not.toHaveProperty('roomId')
    expect(
      queryClient.getQueryData<{ meeting: typeof updatedMeeting }>([
        'meetings',
        'detail',
        'meeting-1',
      ])?.meeting.roomId
    ).toBe('room-1')
  })

  it('uses the newly selected room for the scheduling preview and PATCH', async () => {
    await setBrowserTimeZone(utcTimeZone)
    mockRoomQueries()
    const start = canonicalizeLocalDateTime('2026-09-02', '09:00')
    const end = canonicalizeLocalDateTime('2026-09-02', '10:00')
    const updatedMeeting = {
      ...scheduledMeeting,
      roomId: 'room-2',
      scheduledStartAt: start,
      scheduledEndAt: end,
    }
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: updatedMeeting, meta: {}, etag: 'etag-next' })
    const previewSpy = vi.spyOn(coreApi, 'post').mockResolvedValue({
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

    await userEvent.click(
      screen.getByRole('combobox', { name: 'Meeting room' })
    )
    await userEvent.click(screen.getByRole('option', { name: /Studio/ }))
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-02'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('Meeting changes saved'))
      .toBeInTheDocument()
    expect(previewSpy).toHaveBeenCalledWith(
      '/meeting-schedule-checks',
      {
        meetingId: 'meeting-1',
        start,
        end,
        roomId: 'room-2',
      },
      undefined
    )
    expect(previewSpy.mock.calls[0]?.[1]).not.toHaveProperty('roomId', 'room-1')
    expect(patchSpy).toHaveBeenCalledWith(
      '/meetings/meeting-1',
      { scheduledStartAt: start, scheduledEndAt: end, roomId: 'room-2' },
      { headers: { 'If-Match': 'etag-current' } }
    )
  })

  it('omits the room from preview when the organizer explicitly clears it', async () => {
    await setBrowserTimeZone(utcTimeZone)
    mockRoomQueries()
    const start = canonicalizeLocalDateTime('2026-09-02', '09:00')
    const end = canonicalizeLocalDateTime('2026-09-02', '10:00')
    const updatedMeeting = {
      ...scheduledMeeting,
      roomId: null,
      scheduledStartAt: start,
      scheduledEndAt: end,
    }
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: updatedMeeting, meta: {}, etag: 'etag-next' })
    const previewSpy = vi.spyOn(coreApi, 'post').mockResolvedValue({
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

    await userEvent.click(
      screen.getByRole('combobox', { name: 'Meeting room' })
    )
    await userEvent.click(
      screen.getByRole('option', { name: 'Clear room selection' })
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-02'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('Meeting changes saved'))
      .toBeInTheDocument()
    expect(previewSpy.mock.calls[0]?.[1]).not.toHaveProperty('roomId')
    expect(patchSpy).toHaveBeenCalledWith(
      '/meetings/meeting-1',
      { scheduledStartAt: start, scheduledEndAt: end, roomId: null },
      { headers: { 'If-Match': 'etag-current' } }
    )
  })

  it('does not invent a room when a roomless meeting is rescheduled', async () => {
    await setBrowserTimeZone(utcTimeZone)
    mockRoomQueries()
    const roomlessMeeting = { ...scheduledMeeting, roomId: null }
    const start = canonicalizeLocalDateTime('2026-09-02', '09:00')
    const end = canonicalizeLocalDateTime('2026-09-02', '10:00')
    const updatedMeeting = {
      ...roomlessMeeting,
      scheduledStartAt: start,
      scheduledEndAt: end,
    }
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: updatedMeeting, meta: {}, etag: 'etag-next' })
    const previewSpy = vi.spyOn(coreApi, 'post').mockResolvedValue({
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
          meeting={roomlessMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-02'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('Meeting changes saved'))
      .toBeInTheDocument()
    expect(previewSpy.mock.calls[0]?.[1]).not.toHaveProperty('roomId')
    expect(patchSpy).toHaveBeenCalledWith(
      '/meetings/meeting-1',
      { scheduledStartAt: start, scheduledEndAt: end },
      { headers: { 'If-Match': 'etag-current' } }
    )
    expect(patchSpy.mock.calls[0]?.[1]).not.toHaveProperty('roomId')
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
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-02'
    )
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

  it('preserves an overnight form across 412 recovery until explicit reload', async () => {
    await setBrowserTimeZone(vietnamTimeZone)
    mockRoomQueries()
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({
          status: 412,
          code: 'ETAG_MISMATCH',
          message: 'The meeting changed.',
          kind: 'http',
        })
      )
      .mockResolvedValueOnce({
        data: { ...overnightMeeting, title: 'Reloaded overnight title' },
        meta: {},
        etag: 'etag-after-reload',
      })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: { ...overnightMeeting, title: 'Server overnight title' },
      meta: {},
      etag: 'etag-server',
    })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={overnightMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Local overnight title'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('The meeting changed on the server.'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByLabelText('Date', { exact: true }))
      .toHaveValue(
        localDateInTimeZone(vietnamTimeZone, overnightMeeting.scheduledStartAt)
      )
    await expect
      .element(screen.getByLabelText('End date'))
      .toHaveValue(
        localDateInTimeZone(vietnamTimeZone, overnightMeeting.scheduledEndAt)
      )
    expect(patchSpy).toHaveBeenCalledTimes(1)

    await userEvent.click(
      screen.getByRole('button', { name: 'Reload latest data' }).first()
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Reload latest data' }).last()
    )

    await expect
      .element(screen.getByRole('textbox', { name: 'Title' }))
      .toHaveValue('Server overnight title')
    await expect
      .element(screen.getByLabelText('Date', { exact: true }))
      .toHaveValue(
        localDateInTimeZone(vietnamTimeZone, overnightMeeting.scheduledStartAt)
      )
    await expect
      .element(screen.getByLabelText('End date'))
      .toHaveValue(
        localDateInTimeZone(vietnamTimeZone, overnightMeeting.scheduledEndAt)
      )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Reloaded overnight title'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('Meeting changes saved'))
      .toBeInTheDocument()
    expect(patchSpy).toHaveBeenNthCalledWith(
      2,
      '/meetings/meeting-1',
      { title: 'Reloaded overnight title' },
      { headers: { 'If-Match': 'etag-server' } }
    )
  })

  it('blocks an authoritative room conflict before PATCH or scheduling', async () => {
    await setBrowserTimeZone(utcTimeZone)
    mockRoomQueries()
    const patchSpy = vi.spyOn(coreApi, 'patchWithMetaAndEtag')
    const scheduleSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    const previewSpy = vi.spyOn(coreApi, 'post').mockResolvedValue({
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
          meeting={scheduledMeeting}
          etag='etag-current'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-02'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(
        screen.getByText(
          'The selected room is no longer available for this interval. No meeting changes were committed.'
        )
      )
      .toBeInTheDocument()
    expect(previewSpy).toHaveBeenCalledWith(
      '/meeting-schedule-checks',
      expect.objectContaining({ meetingId: 'meeting-1', roomId: 'room-1' }),
      undefined
    )
    expect(patchSpy).not.toHaveBeenCalled()
    expect(scheduleSpy).not.toHaveBeenCalled()
  })

  it('uses the refreshed room and ETag after reconciliation before rescheduling', async () => {
    await setBrowserTimeZone(utcTimeZone)
    mockRoomQueries()
    const firstStart = canonicalizeLocalDateTime('2026-09-02', '09:00')
    const firstEnd = canonicalizeLocalDateTime('2026-09-02', '10:00')
    const secondStart = canonicalizeLocalDateTime('2026-09-03', '09:00')
    const secondEnd = canonicalizeLocalDateTime('2026-09-03', '10:00')
    const latestMeeting = {
      ...scheduledMeeting,
      roomId: 'room-2',
    }
    const updatedMeeting = {
      ...latestMeeting,
      scheduledStartAt: secondStart,
      scheduledEndAt: secondEnd,
    }
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({
          status: 412,
          code: 'ETAG_MISMATCH',
          message: 'The meeting changed.',
          kind: 'http',
        })
      )
      .mockResolvedValueOnce({
        data: updatedMeeting,
        meta: {},
        etag: 'etag-refreshed-mutation',
      })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: latestMeeting,
      meta: {},
      etag: 'etag-server',
    })
    const previewSpy = vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const scheduleSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
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
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-02'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('The meeting changed on the server.'))
      .toBeInTheDocument()
    expect(previewSpy.mock.calls[0]?.[1]).toMatchObject({
      meetingId: 'meeting-1',
      start: firstStart,
      end: firstEnd,
      roomId: 'room-1',
    })
    expect(patchSpy).toHaveBeenNthCalledWith(
      1,
      '/meetings/meeting-1',
      { scheduledStartAt: firstStart, scheduledEndAt: firstEnd },
      { headers: { 'If-Match': 'etag-current' } }
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Reload latest data' }).first()
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Reload latest data' }).last()
    )
    await expect
      .element(screen.getByRole('combobox', { name: 'Meeting room' }))
      .toHaveTextContent('Studio')

    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-03'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText('Meeting changes saved'))
      .toBeInTheDocument()
    expect(previewSpy).toHaveBeenCalledTimes(2)
    expect(previewSpy.mock.calls[1]?.[1]).toMatchObject({
      meetingId: 'meeting-1',
      start: secondStart,
      end: secondEnd,
      roomId: 'room-2',
    })
    expect(previewSpy.mock.calls[1]?.[1]).not.toHaveProperty('roomId', 'room-1')
    expect(patchSpy).toHaveBeenNthCalledWith(
      2,
      '/meetings/meeting-1',
      { scheduledStartAt: secondStart, scheduledEndAt: secondEnd },
      { headers: { 'If-Match': 'etag-server' } }
    )
    expect(patchSpy.mock.calls[1]?.[1]).not.toHaveProperty('roomId', 'room-1')
    expect(scheduleSpy).not.toHaveBeenCalled()
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

  it('keeps Save changes locked when a 412 refresh fails and retries only GET', async () => {
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
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ message: 'Refresh failed', kind: 'network' })
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
      'Local title'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByRole('button', { name: 'Retry refresh' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Save changes' }))
      .toBeDisabled()
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(detailSpy).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: 'Retry refresh' }))
    await expect.poll(() => detailSpy.mock.calls.length).toBe(2)
    expect(patchSpy).toHaveBeenCalledTimes(1)
    await expect
      .element(screen.getByRole('button', { name: 'Save changes' }))
      .toBeDisabled()
  })

  it('retries a failed reconciliation with GET only and adopts its verified ETag', async () => {
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockRejectedValueOnce(new Error('Refresh failed'))
      .mockResolvedValue({
        data: { ...draftMeeting, title: 'Server title' },
        meta: {},
        etag: 'etag-after-retry',
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
    await userEvent.click(screen.getByRole('button', { name: 'Retry refresh' }))

    await expect
      .element(
        screen.getByText('The operation outcome could not be confirmed.')
      )
      .toBeInTheDocument()
    expect(detailSpy).toHaveBeenCalledTimes(2)
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('disables editing when reconciliation observes a non-editable lifecycle', async () => {
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: { ...draftMeeting, status: 'IN_PROGRESS' as const },
      meta: {},
      etag: 'etag-live',
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
      .element(screen.getByText(/editing is disabled/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Save changes' }))
      .toBeDisabled()
    await expect
      .element(screen.getByRole('button', { name: 'Save & Schedule' }))
      .not.toBeInTheDocument()
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('disables editing when reconciliation observes a different organizer', async () => {
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: { ...draftMeeting, organizerUserId: 'other-organizer' },
      meta: {},
      etag: 'etag-other-organizer',
    })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={draftMeeting}
          etag='etag-current'
          currentUserId='organizer-1'
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Local title'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText(/no longer the organizer/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Save changes' }))
      .toBeDisabled()
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('treats a malformed PATCH response as ambiguous and never reports confirmed success', async () => {
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: draftMeeting, meta: {} } as never)
    const reconciledMeeting = { ...draftMeeting, title: 'Observed title' }
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: reconciledMeeting,
      meta: {},
      etag: 'etag-observed',
    })
    const onCommitted = vi.fn()
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={draftMeeting}
          etag='etag-current'
          onCommitted={onCommitted}
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Observed title'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText(/could not be independently confirmed/i))
      .toBeInTheDocument()
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(onCommitted).not.toHaveBeenCalled()
  })

  it('reconciles an ambiguous matching PATCH without reporting confirmed success', async () => {
    const reconciledMeeting = { ...draftMeeting, title: 'Requested title' }
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: reconciledMeeting,
      meta: {},
      etag: 'etag-reconciled',
    })
    const onCommitted = vi.fn()
    const queryClient = createQueryClient()
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingEditDialog
          open
          onOpenChange={vi.fn()}
          meeting={draftMeeting}
          etag='etag-current'
          onCommitted={onCommitted}
        />
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Requested title'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByText(/matches your requested changes/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Meeting changes saved'))
      .not.toBeInTheDocument()
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(onCommitted).not.toHaveBeenCalled()
    expect(
      queryClient.getQueryData(['meetings', 'detail', 'meeting-1'])
    ).toEqual({ meeting: reconciledMeeting, etag: 'etag-reconciled' })
  })

  it('preserves local title, description, schedule, and room through ambiguous refresh', async () => {
    mockRoomQueries()
    const serverMeeting = {
      ...scheduledMeeting,
      title: 'Server title',
      roomId: 'room-1',
      scheduledStartAt: '2026-11-12T09:00:00.000Z',
      scheduledEndAt: '2026-11-12T10:00:00.000Z',
    }
    vi.spyOn(coreApi, 'patchWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({ message: 'Connection lost', kind: 'network' })
    )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: serverMeeting,
      meta: {},
      etag: 'etag-server',
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
      'Local title'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Description' }),
      'Local description'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-11-10'
    )
    await userEvent.fill(screen.getByLabelText('End date'), '2026-11-11')
    await userEvent.fill(screen.getByLabelText('Start time'), '23:00')
    await userEvent.fill(screen.getByLabelText('End time'), '01:00')
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Meeting room' })
    )
    await userEvent.click(screen.getByRole('option', { name: /Studio/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByRole('textbox', { name: 'Title' }))
      .toHaveValue('Local title')
    await expect
      .element(screen.getByRole('textbox', { name: 'Description' }))
      .toHaveValue('Local description')
    await expect
      .element(screen.getByLabelText('End date'))
      .toHaveValue('2026-11-11')
    await expect
      .element(screen.getByRole('combobox', { name: 'Meeting room' }))
      .toHaveTextContent('Studio')
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
