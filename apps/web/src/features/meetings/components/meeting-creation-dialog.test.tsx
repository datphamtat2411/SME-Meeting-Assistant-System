import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  currentUserQueryKey,
  type AuthContext,
} from '@/features/auth/session/current-user'
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

function createQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  queryClient.setQueryData(currentUserQueryKey, currentUser)
  return queryClient
}

function mockRoomQueries() {
  vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, config) => {
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
        <MeetingCreationDialog
          open
          onOpenChange={onOpenChange}
          onCommitted={onCommitted}
        />
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

  it('selects returned candidates, preserves them across searches, and submits their IDs', async () => {
    mockRoomQueries()
    const createSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValue({ data: draftMeeting, meta: {}, etag: 'draft-etag' })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingCreationDialog open onOpenChange={vi.fn()} />
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
        <MeetingCreationDialog
          open
          onOpenChange={onOpenChange}
          onCommitted={onCommitted}
        />
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
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingCreationDialog open onOpenChange={vi.fn()} />
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
    expect(
      postSpy.mock.calls.filter(([url]) => url === '/meetings')
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
        <ControlledMeetingDialog />
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
        <MeetingCreationDialog open onOpenChange={vi.fn()} />
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
        <MeetingCreationDialog open onOpenChange={vi.fn()} />
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
        <MeetingCreationDialog open onOpenChange={vi.fn()} />
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
        <MeetingCreationDialog open onOpenChange={vi.fn()} />
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
        <MeetingCreationDialog open onOpenChange={vi.fn()} />
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
        <MeetingCreationDialog open onOpenChange={vi.fn()} />
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
        <MeetingCreationDialog open onOpenChange={vi.fn()} />
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
    vi.spyOn(coreApi, 'post').mockResolvedValue({
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
        <MeetingCreationDialog open onOpenChange={vi.fn()} />
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
        <MeetingCreationDialog open onOpenChange={vi.fn()} />
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

    await expect
      .element(screen.getByText('Meeting scheduled'))
      .toBeInTheDocument()
    expect(postSpy).toHaveBeenCalledTimes(2)
  })
})
