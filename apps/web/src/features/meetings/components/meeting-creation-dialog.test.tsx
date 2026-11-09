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
    await userEvent.fill(screen.getByLabelText('Date'), '2026-09-01')
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
    await userEvent.fill(screen.getByLabelText('Date'), '2026-09-01')
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
})
