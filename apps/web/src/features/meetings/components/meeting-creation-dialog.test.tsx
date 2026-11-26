import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { RegionalPresentationProvider } from '@/context/regional-presentation'
import {
  currentUserQueryKey,
  type AuthContext,
} from '@/features/auth/session/current-user'
import { preferencesQueryKey } from '@/features/settings/preferences-api'
import { canonicalizeLocalDateTime } from '../data/meeting-creation-api'
import { MeetingCreationDialog } from './meeting-creation-dialog'

const currentUser = {
  userId: 'user-1',
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
} as AuthContext

const pagination = {
  page: 0,
  size: 20,
  totalElements: 1,
  totalPages: 1,
  hasNext: false,
  hasPrevious: false,
}

const candidate = {
  id: 'user-2',
  displayName: 'Candidate User',
  email: 'candidate@example.com',
  organizationalUnitName: 'Product',
}

const secondCandidate = {
  id: 'user-3',
  displayName: 'Second Candidate',
  email: 'second@example.com',
  organizationalUnitName: null,
}

const draftMeeting = {
  id: 'meeting-1',
  title: 'Draft meeting',
  description: null,
  organizerUserId: 'user-1',
  roomId: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
  status: 'DRAFT' as const,
  startedAt: null,
  endedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: 'user-1',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}

const scheduledDraft = {
  ...draftMeeting,
  roomId: 'room-1',
  scheduledStartAt: '2026-09-01T09:00:00.000Z',
  scheduledEndAt: '2026-09-01T10:00:00.000Z',
}

const scheduledMeeting = { ...scheduledDraft, status: 'SCHEDULED' as const }

function ControlledMeetingDialog() {
  const [open, setOpen] = useState(true)
  return (
    <>
      {!open && (
        <button type='button' onClick={() => setOpen(true)}>
          Reopen meeting dialog
        </button>
      )}
      <MeetingCreationDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

function ContextualMeetingDialog({
  initialScheduleDate = '2026-11-17',
  onCommitted,
}: {
  initialScheduleDate?: string
  onCommitted?: (meeting: {
    meetingId: string
    status: 'DRAFT' | 'SCHEDULED'
  }) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type='button' onClick={() => setOpen(true)}>
        Open contextual meeting
      </button>
      <MeetingCreationDialog
        open={open}
        onOpenChange={setOpen}
        initialScheduleDate={initialScheduleDate}
        onCommitted={onCommitted}
      />
    </>
  )
}

function createQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  queryClient.setQueryDefaults(preferencesQueryKey, { staleTime: Infinity })
  queryClient.setQueryData(preferencesQueryKey, {
    timezone: null,
    locale: null,
    meetingEmailEnabled: true,
    actionItemEmailEnabled: true,
  })
  queryClient.setQueryData(currentUserQueryKey, currentUser)
  return queryClient
}

function mockRoomQueries() {
  return vi
    .spyOn(coreApi, 'getWithMeta')
    .mockImplementation(async (url, config) => {
      if (url === '/rooms/availability') {
        return {
          data: [],
          meta: {
            pagination: { ...pagination, totalElements: 0, totalPages: 0 },
          },
        }
      }
      if (url === '/users/meeting-candidates') {
        const query = String(config?.params?.q ?? '')
        return {
          data: query.includes('second') ? [secondCandidate] : [candidate],
          meta: { pagination },
        }
      }
      return {
        data: [{ id: 'room-1', name: 'Boardroom', location: 'HQ' }],
        meta: { pagination },
      }
    })
}

describe('MeetingCreationDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('saves an authoritative DRAFT once with no organizer or fabricated participant IDs', async () => {
    mockRoomQueries()
    const createSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValue({ data: draftMeeting, meta: {}, etag: 'draft-etag' })
    const onOpenChange = vi.fn()
    const onCommitted = vi.fn()
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog
            open
            onOpenChange={onOpenChange}
            onCommitted={onCommitted}
          />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Draft meeting'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save Draft' }))

    await expect.element(screen.getByText('Draft created')).toBeInTheDocument()
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(createSpy).toHaveBeenCalledWith(
      '/meetings',
      { title: 'Draft meeting' },
      expect.anything()
    )
    expect(createSpy.mock.calls[0]?.[2]).toEqual({
      headers: { 'Idempotency-Key': expect.any(String) },
    })
    expect(JSON.stringify(createSpy.mock.calls[0]?.[0])).not.toContain(
      'organizer'
    )
    expect(onCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'DRAFT', meetingId: 'meeting-1' })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('prefills only local dates on a fresh contextual open and preserves edited dates', async () => {
    mockRoomQueries()
    const queryClient = createQueryClient()
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <RegionalPresentationProvider>
          <ContextualMeetingDialog />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Open contextual meeting' })
    )
    await expect
      .element(screen.getByLabelText('Date', { exact: true }))
      .toHaveValue('2026-11-17')
    await expect
      .element(screen.getByLabelText('End date'))
      .toHaveValue('2026-11-17')
    await expect.element(screen.getByLabelText('Start time')).toHaveValue('')
    await expect.element(screen.getByLabelText('End time')).toHaveValue('')

    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-11-19'
    )
    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <RegionalPresentationProvider>
          <ContextualMeetingDialog initialScheduleDate='2026-11-18' />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )
    await expect
      .element(screen.getByLabelText('Date', { exact: true }))
      .toHaveValue('2026-11-19')
  })

  it('keeps date-only prefill out of draft payloads and requires a full schedule interval', async () => {
    mockRoomQueries()
    const createSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValue({ data: draftMeeting, meta: {}, etag: 'draft-etag' })
    const postSpy = vi.spyOn(coreApi, 'post')
    const onCommitted = vi.fn()
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <ContextualMeetingDialog onCommitted={onCommitted} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Open contextual meeting' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Contextual draft'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save Draft' }))
    await expect
      .element(screen.getByRole('button', { name: 'Open contextual meeting' }))
      .toBeInTheDocument()
    expect(onCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'DRAFT', meetingId: 'meeting-1' })
    )
    expect(createSpy).toHaveBeenCalledWith(
      '/meetings',
      { title: 'Contextual draft' },
      expect.anything()
    )
    expect(createSpy.mock.calls[0]?.[1]).not.toHaveProperty('scheduledStartAt')
    expect(createSpy.mock.calls[0]?.[1]).not.toHaveProperty('scheduledEndAt')

    await userEvent.click(
      screen.getByRole('button', { name: 'Open contextual meeting' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Incomplete schedule'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )
    await expect
      .element(
        screen.getByText(
          'A complete date and time interval is required to schedule.'
        )
      )
      .toBeInTheDocument()
    expect(postSpy).not.toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores an invalid contextual local date and preserves ordinary dialog defaults', async () => {
    mockRoomQueries()
    function InvalidContextDialog() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type='button' onClick={() => setOpen(true)}>
            Open without a valid date
          </button>
          <MeetingCreationDialog
            open={open}
            onOpenChange={setOpen}
            initialScheduleDate='2026-02-30'
          />
        </>
      )
    }
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <InvalidContextDialog />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Open without a valid date' })
    )
    await expect
      .element(screen.getByLabelText('Date', { exact: true }))
      .toHaveValue('')
    await expect.element(screen.getByLabelText('End date')).toHaveValue('')
  })

  it('selects returned candidates, preserves them across searches, and submits their IDs', async () => {
    mockRoomQueries()
    const createSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValue({ data: draftMeeting, meta: {}, etag: 'draft-etag' })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Draft meeting'
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    const search = screen.getByPlaceholder('Search active participants...')
    await userEvent.fill(search, 'candidate')
    await expect
      .element(screen.getByRole('option', { name: /Candidate User/ }))
      .toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('option', { name: /Candidate User/ })
    )

    await expect
      .element(screen.getByText('1 participant selected'))
      .toBeInTheDocument()
    await userEvent.fill(search, 'second')
    await expect
      .element(screen.getByRole('option', { name: /Second Candidate/ }))
      .toBeInTheDocument()
    await expect.element(screen.getByText('Candidate User')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Save Draft' }))
    await expect.element(screen.getByText('Draft created')).toBeInTheDocument()
    expect(createSpy).toHaveBeenCalledWith(
      '/meetings',
      { title: 'Draft meeting', participantUserIds: ['user-2'] },
      expect.anything()
    )
  })

  it('previews the selected room and proposed participants without creating a meeting', async () => {
    const getSpy = mockRoomQueries()
    const checkSpy = vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: {
        roomId: 'room-1',
        active: true,
        available: true,
        capacity: 2,
        participantCount: 3,
        capacityExceeded: true,
      },
      warnings: [
        { code: 'CAPACITY_ADVISORY_EXCEEDED', userId: null },
        { code: 'PARTICIPANT_OVERLAP', userId: 'user-2' },
      ],
    })
    const createSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Meeting room' })
    )
    await userEvent.click(screen.getByRole('option', { name: /Boardroom/ }))
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'candidate'
    )
    await userEvent.click(
      screen.getByRole('option', { name: /Candidate User/ })
    )

    await expect
      .element(screen.getByText(/Boardroom appears available/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Room capacity advisory.'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Participant schedule overlap warning.'))
      .toBeInTheDocument()
    expect(checkSpy).toHaveBeenCalledWith(
      '/meeting-schedule-checks',
      expect.objectContaining({
        roomId: 'room-1',
        start: expect.any(String),
        end: expect.any(String),
        participantUserIds: ['user-2'],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(checkSpy.mock.calls[0]?.[1]).not.toHaveProperty('meetingId')
    expect(
      getSpy.mock.calls.some(([url]) => url === '/rooms/availability')
    ).toBe(false)
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('previews before one create, schedules with the returned ETag, and reports committed status', async () => {
    mockRoomQueries()
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    postSpy
      .mockResolvedValueOnce({
        data: scheduledDraft,
        meta: {},
        etag: 'draft-etag',
      })
      .mockResolvedValueOnce({
        data: scheduledMeeting,
        meta: {},
        etag: 'scheduled-etag',
      })
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const onOpenChange = vi.fn()
    const onCommitted = vi.fn()
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog
            open
            onOpenChange={onOpenChange}
            onCommitted={onCommitted}
          />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Scheduled meeting'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )

    await expect
      .element(screen.getByText('Meeting scheduled'))
      .toBeInTheDocument()
    expect(postSpy).toHaveBeenCalledTimes(2)
    expect(postSpy.mock.calls[0]?.[0]).toBe('/meetings')
    expect(postSpy.mock.calls[1]).toEqual([
      '/meetings/meeting-1/schedule',
      {
        scheduledStartAt: canonicalizeLocalDateTime('2026-09-01', '09:00'),
        scheduledEndAt: canonicalizeLocalDateTime('2026-09-01', '10:00'),
      },
      { headers: { 'If-Match': 'draft-etag' } },
    ])
    expect(onCommitted).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'SCHEDULED', meetingId: 'meeting-1' })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('pins the editor timezone and requires an explicit DST occurrence before scheduling', async () => {
    mockRoomQueries()
    const queryClient = createQueryClient()
    const preferences = {
      timezone: 'America/New_York',
      locale: 'en-US',
      meetingEmailEnabled: true,
      actionItemEmailEnabled: true,
    }
    queryClient.setQueryData(preferencesQueryKey, preferences)
    const start = '2026-11-01T06:30:00.000Z'
    const end = '2026-11-01T07:30:00.000Z'
    const draft = {
      ...draftMeeting,
      scheduledStartAt: start,
      scheduledEndAt: end,
    }
    const postSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValueOnce({ data: draft, meta: {}, etag: 'draft-etag' })
      .mockResolvedValueOnce({
        data: { ...draft, status: 'SCHEDULED' as const },
        meta: {},
        etag: 'scheduled-etag',
      })
    const previewSpy = vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'DST meeting'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-11-01'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '01:30')
    await userEvent.fill(screen.getByLabelText('End time'), '02:30')
    await expect
      .element(screen.getByLabelText('Start time UTC offset'))
      .toHaveValue('')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )
    expect(postSpy).not.toHaveBeenCalled()
    expect(previewSpy).not.toHaveBeenCalled()

    queryClient.setQueryData(preferencesQueryKey, {
      ...preferences,
      timezone: 'Asia/Tokyo',
    })
    await expect
      .element(screen.getByText(/This editor retains America\/New_York/))
      .toBeInTheDocument()
    await userEvent.selectOptions(
      screen.getByLabelText('Start time UTC offset'),
      '2026-11-01T06:30:00Z'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )
    await expect
      .element(screen.getByText('Meeting scheduled'))
      .toBeInTheDocument()

    expect(previewSpy).toHaveBeenCalledWith(
      '/meeting-schedule-checks',
      expect.objectContaining({ start, end }),
      undefined
    )
    expect(postSpy).toHaveBeenCalledTimes(2)
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({
      scheduledStartAt: start,
      scheduledEndAt: end,
    })
    expect(postSpy.mock.calls[1]?.[1]).toEqual({
      scheduledStartAt: start,
      scheduledEndAt: end,
    })
  })

  it('keeps the created draft and retries scheduling without a second create', async () => {
    mockRoomQueries()
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    postSpy
      .mockResolvedValueOnce({
        data: scheduledDraft,
        meta: {},
        etag: 'draft-etag',
      })
      .mockRejectedValueOnce(
        new CoreApiError({
          status: 409,
          code: 'ROOM_CONFLICT',
          message: 'Room is no longer available.',
          kind: 'http',
        })
      )
      .mockResolvedValueOnce({
        data: scheduledMeeting,
        meta: {},
        etag: 'scheduled-etag',
      })
    const previewSpy = vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Scheduled meeting'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )

    await expect
      .element(screen.getByText('Draft created, not scheduled'))
      .toBeInTheDocument()
    expect(
      postSpy.mock.calls.filter(([url]) => url === '/meetings')
    ).toHaveLength(1)

    await userEvent.click(
      screen.getByRole('button', { name: 'Retry schedule' })
    )
    await expect
      .element(screen.getByText('Meeting scheduled'))
      .toBeInTheDocument()
    expect(previewSpy).toHaveBeenCalledTimes(2)
    expect(previewSpy.mock.calls[1]?.[1]).not.toHaveProperty('meetingId')
    expect(
      postSpy.mock.calls.filter(([url]) => url === '/meetings')
    ).toHaveLength(1)
  })

  it('rechecks a recovered draft and blocks retry when the room has since conflicted', async () => {
    mockRoomQueries()
    const mutationSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    mutationSpy
      .mockResolvedValueOnce({
        data: scheduledDraft,
        meta: {},
        etag: 'draft-etag',
      })
      .mockRejectedValueOnce(
        new CoreApiError({
          status: 409,
          message: 'Room conflict',
          kind: 'http',
        })
      )
    const previewSpy = vi.spyOn(coreApi, 'post')
    previewSpy
      .mockResolvedValueOnce({
        previewOnly: true,
        canSchedule: true,
        roomConflict: false,
        room: null,
        warnings: [],
      })
      .mockResolvedValueOnce({
        previewOnly: true,
        canSchedule: false,
        roomConflict: true,
        room: null,
        warnings: [],
      })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Recovered conflict'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )
    await expect
      .element(screen.getByText('Draft created, not scheduled'))
      .toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Retry schedule' })
    )

    await expect
      .element(
        screen.getByText(
          'The selected room is no longer available for this interval. The existing draft was preserved.'
        )
      )
      .toBeInTheDocument()
    expect(previewSpy).toHaveBeenCalledTimes(2)
    expect(previewSpy.mock.calls[1]?.[1]).not.toHaveProperty('meetingId')
    expect(
      mutationSpy.mock.calls.filter(([url]) =>
        url.includes('/meetings/meeting-1/schedule')
      )
    ).toHaveLength(1)
  })

  it('replays the exact creation intent after a lost response and preserves it across close and reopen', async () => {
    mockRoomQueries()
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    postSpy
      .mockRejectedValueOnce(
        new CoreApiError({
          status: 502,
          message: 'Gateway timeout',
          kind: 'server',
        })
      )
      .mockResolvedValueOnce({
        data: draftMeeting,
        meta: {},
        etag: 'draft-etag',
      })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <ControlledMeetingDialog />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Frozen meeting'
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    const participantSearch = screen.getByPlaceholder(
      'Search active participants...'
    )
    await userEvent.fill(participantSearch, 'candidate')
    await expect
      .element(screen.getByRole('option', { name: /Candidate User/ }))
      .toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('option', { name: /Candidate User/ })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save Draft' }))
    await expect
      .element(screen.getByText('Creation outcome unknown'))
      .toBeInTheDocument()

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Changed after uncertainty'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Candidate User' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Close' }).first())
    await expect
      .element(screen.getByText('Creation outcome unknown'))
      .not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Reopen meeting dialog' })
    )
    await expect
      .element(screen.getByText('Creation outcome unknown'))
      .toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Retry creation' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Reopen meeting dialog' }))
      .toBeInTheDocument()
    expect(postSpy).toHaveBeenCalledTimes(2)
    expect(postSpy.mock.calls[0]).toEqual(postSpy.mock.calls[1])
    expect(postSpy.mock.calls[0]?.[1]).toEqual({
      title: 'Frozen meeting',
      participantUserIds: ['user-2'],
    })
  })

  it('pauses warning-bearing previews until the user explicitly schedules anyway', async () => {
    mockRoomQueries()
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    postSpy
      .mockResolvedValueOnce({
        data: scheduledDraft,
        meta: {},
        etag: 'draft-etag',
      })
      .mockResolvedValueOnce({
        data: scheduledMeeting,
        meta: {},
        etag: 'scheduled-etag',
      })
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [
        { code: 'PARTICIPANT_OVERLAP', userId: 'user-2' },
        { code: 'CAPACITY_ADVISORY_EXCEEDED', userId: null },
      ],
    })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Warning meeting'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )

    await expect
      .element(screen.getByText('Participant schedule overlap warning.'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Room capacity advisory.'))
      .toBeInTheDocument()
    expect(postSpy).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByRole('button', { name: 'Review details' })
    )
    expect(postSpy).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Schedule anyway' })
    )
    await expect
      .element(screen.getByText('Meeting scheduled'))
      .toBeInTheDocument()
    expect(postSpy).toHaveBeenCalledTimes(2)
  })

  it('treats malformed creation success as uncertain and retries the same intent', async () => {
    mockRoomQueries()
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    postSpy
      .mockResolvedValueOnce({ data: draftMeeting, meta: {} })
      .mockResolvedValueOnce({
        data: draftMeeting,
        meta: {},
        etag: 'draft-etag',
      })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Malformed response'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save Draft' }))
    await expect
      .element(screen.getByText('Creation outcome unknown'))
      .toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry creation' })
    )
    await expect.element(screen.getByText('Draft created')).toBeInTheDocument()
    expect(postSpy).toHaveBeenCalledTimes(2)
    expect(postSpy.mock.calls[0]).toEqual(postSpy.mock.calls[1])
  })

  it('reports an idempotency fingerprint conflict without offering a silent key replacement', async () => {
    mockRoomQueries()
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({
        status: 409,
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency-Key is already bound to a different intent.',
        kind: 'http',
      })
    )
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Conflicting intent'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save Draft' }))
    await expect
      .element(
        screen.getByText(
          'The Idempotency-Key is already bound to a different meeting creation intent. It was not replaced or retried as a room conflict.'
        )
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Retry creation' }))
      .not.toBeInTheDocument()
    expect(postSpy).toHaveBeenCalledTimes(1)
  })

  it('blocks creation for a room conflict and does not create on a failed preview', async () => {
    mockRoomQueries()
    const createSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: false,
      roomConflict: true,
      room: null,
      warnings: [],
    })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Room conflict'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )
    await expect
      .element(
        screen.getByText(
          'The selected room is no longer available for this interval. No meeting was created.'
        )
      )
      .toBeInTheDocument()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('does not create when the authoritative schedule preview fails', async () => {
    mockRoomQueries()
    const createSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    vi.spyOn(coreApi, 'post').mockRejectedValue(
      new Error('preview unavailable')
    )
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Preview failure'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )
    await expect
      .element(
        screen.getByText(
          'The Core API could not be reached while checking the meeting schedule.'
        )
      )
      .toBeInTheDocument()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('prevents duplicate create requests from concurrent clicks', async () => {
    mockRoomQueries()
    const response = { data: draftMeeting, meta: {}, etag: 'draft-etag' }
    let resolveCreate: (value: typeof response) => void = () => undefined
    const pending = new Promise<typeof response>((resolve) => {
      resolveCreate = resolve
    })
    const createSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockReturnValueOnce(pending)
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'One request'
    )
    const saveButton = screen.getByRole('button', { name: 'Save Draft' })
    await userEvent.click(saveButton)
    await expect
      .element(screen.getByRole('button', { name: 'Saving...' }))
      .toBeDisabled()
    expect(createSpy).toHaveBeenCalledTimes(1)
    resolveCreate(response)
    await expect.element(screen.getByText('Draft created')).toBeInTheDocument()
  })

  it('invalidates a warning review when schedule input changes', async () => {
    mockRoomQueries()
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    postSpy
      .mockResolvedValueOnce({
        data: scheduledDraft,
        meta: {},
        etag: 'draft-etag',
      })
      .mockResolvedValueOnce({
        data: scheduledMeeting,
        meta: {},
        etag: 'scheduled-etag',
      })
    const previewSpy = vi.spyOn(coreApi, 'post')
    previewSpy
      .mockResolvedValueOnce({
        previewOnly: true,
        canSchedule: true,
        roomConflict: false,
        room: null,
        warnings: [{ code: 'PARTICIPANT_OVERLAP', userId: 'user-2' }],
      })
      .mockResolvedValueOnce({
        previewOnly: true,
        canSchedule: true,
        roomConflict: false,
        room: null,
        warnings: [],
      })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Changed schedule'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )
    await expect
      .element(screen.getByText('Participant schedule overlap warning.'))
      .toBeInTheDocument()

    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-02'
    )
    await expect
      .element(screen.getByText('Participant schedule overlap warning.'))
      .not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )
    await expect
      .element(screen.getByText('Meeting scheduled'))
      .toBeInTheDocument()
    expect(previewSpy).toHaveBeenCalledTimes(2)
    expect(postSpy).toHaveBeenCalledTimes(2)
  })

  it('refreshes the ETag after an uncertain schedule and never creates another draft', async () => {
    mockRoomQueries()
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    postSpy
      .mockResolvedValueOnce({
        data: scheduledDraft,
        meta: {},
        etag: 'draft-etag',
      })
      .mockRejectedValueOnce(new Error('schedule response lost'))
      .mockResolvedValueOnce({
        data: scheduledMeeting,
        meta: {},
        etag: 'scheduled-etag',
      })
    const previewSpy = vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({ data: scheduledDraft, meta: {}, etag: 'fresh-etag' })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'ETag recovery'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )
    await expect
      .element(screen.getByText('Draft created, not scheduled'))
      .toBeInTheDocument()
    expect(detailSpy).toHaveBeenCalledWith('/meetings/meeting-1', {
      signal: undefined,
    })

    await userEvent.click(
      screen.getByRole('button', { name: 'Retry schedule' })
    )
    await expect
      .element(screen.getByText('Meeting scheduled'))
      .toBeInTheDocument()
    expect(previewSpy).toHaveBeenCalledTimes(2)
    expect(previewSpy.mock.calls[1]?.[1]).not.toHaveProperty('meetingId')
    expect(
      postSpy.mock.calls.filter(([url]) => url === '/meetings')
    ).toHaveLength(1)
    expect(postSpy.mock.calls[2]?.[2]).toEqual({
      headers: { 'If-Match': 'fresh-etag' },
    })
  })

  it('accepts an already scheduled reconciliation without resubmitting schedule', async () => {
    mockRoomQueries()
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    postSpy
      .mockResolvedValueOnce({
        data: scheduledDraft,
        meta: {},
        etag: 'draft-etag',
      })
      .mockRejectedValueOnce(new Error('schedule response lost'))
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: scheduledMeeting,
      meta: {},
      etag: 'scheduled-etag',
    })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Already scheduled'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )

    await expect.element(screen.getByText(/now scheduled/i)).toBeInTheDocument()
    expect(postSpy).toHaveBeenCalledTimes(2)
    expect(postSpy.mock.calls[0]?.[0]).toBe('/meetings')
    expect(postSpy.mock.calls[1]?.[0]).toBe('/meetings/meeting-1/schedule')
  })

  it('keeps an observed scheduled result neutral and does not notify confirmed success', async () => {
    mockRoomQueries()
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    postSpy
      .mockResolvedValueOnce({
        data: scheduledDraft,
        meta: {},
        etag: 'draft-etag',
      })
      .mockRejectedValueOnce(new Error('schedule response lost'))
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: scheduledMeeting,
      meta: {},
      etag: 'scheduled-etag',
    })
    const onCommitted = vi.fn()
    const queryClient = createQueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    queryClient.setQueryData(['meetings', 'list', { page: 1 }], {
      meetings: [
        {
          ...scheduledDraft,
          display: {
            organizerName: 'Organizer',
            roomName: 'Boardroom',
            roomLocation: 'HQ',
            participantCount: 0,
            participantPreview: [],
          },
        },
      ],
      pagination,
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog
            open
            onOpenChange={vi.fn()}
            onCommitted={onCommitted}
          />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Observed schedule'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )

    await expect.element(screen.getByText(/now scheduled/i)).toBeInTheDocument()
    await expect
      .element(screen.getByText('Meeting scheduled'))
      .not.toBeInTheDocument()
    expect(onCommitted).not.toHaveBeenCalled()
    expect(
      postSpy.mock.calls.filter(([url]) => url === '/meetings')
    ).toHaveLength(1)
    expect(
      postSpy.mock.calls.filter(
        ([url]) => url === '/meetings/meeting-1/schedule'
      )
    ).toHaveLength(1)
    expect(
      queryClient.getQueryData(['meetings', 'detail', 'meeting-1'])
    ).toEqual({ meeting: scheduledMeeting, etag: 'scheduled-etag' })
    expect(
      queryClient.getQueryData<{ meetings: Array<{ status: string }> }>([
        'meetings',
        'list',
        { page: 1 },
      ])?.meetings[0]?.status
    ).toBe('SCHEDULED')
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['rooms', 'availability'],
    })
  })

  it('preserves the created draft when ambiguous schedule reconciliation fails', async () => {
    mockRoomQueries()
    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    postSpy
      .mockResolvedValueOnce({
        data: scheduledDraft,
        meta: {},
        etag: 'draft-etag',
      })
      .mockRejectedValueOnce(new Error('schedule response lost'))
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockRejectedValue(new Error('detail unavailable'))
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <RegionalPresentationProvider>
          <MeetingCreationDialog open onOpenChange={vi.fn()} />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Uncertain schedule'
    )
    await userEvent.fill(
      screen.getByLabelText('Date', { exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(screen.getByLabelText('Start time'), '09:00')
    await userEvent.fill(screen.getByLabelText('End time'), '10:00')
    await userEvent.click(
      screen.getByRole('button', { name: 'Create & Schedule' })
    )

    await expect
      .element(screen.getByText('Schedule result unknown'))
      .toBeInTheDocument()
    expect(detailSpy).toHaveBeenCalledTimes(1)
    expect(
      postSpy.mock.calls.filter(([url]) => url === '/meetings')
    ).toHaveLength(1)
    expect(
      postSpy.mock.calls.filter(
        ([url]) => url === '/meetings/meeting-1/schedule'
      )
    ).toHaveLength(1)
  })
})
