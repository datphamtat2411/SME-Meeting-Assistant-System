import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { currentUserQueryKey } from '@/features/auth/session/current-user'
import type { MeetingView } from './data/detail-api'
import { MeetingWorkspacePage } from './meeting-workspace'

const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccess,
  },
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
    displayName: 'Active participant',
  },
  {
    id: 'membership-2',
    meetingId: 'meeting-1',
    userId: 'user-2',
    addedByUserId: 'organizer-1',
    addedAt: '2026-09-01T00:30:00Z',
    removedAt: '2026-09-01T08:00:00Z',
    removedByUserId: 'organizer-1',
    displayName: 'Historical participant',
  },
]

const editableMeeting = {
  ...detail,
  organizerUserId: 'current-user',
  createdByUserId: 'current-user',
  status: 'DRAFT' as const,
  startedAt: null,
  endedAt: null,
}

const activeOrganizerAndParticipants = [
  {
    ...participants[0],
    userId: 'current-user',
  },
  {
    ...participants[0],
    id: 'membership-3',
    userId: 'user-3',
  },
  {
    ...participants[0],
    id: 'membership-4',
    userId: 'user-4',
  },
  participants[1],
]

const availabilityPagination = {
  page: 0,
  size: 20,
  totalElements: 0,
  totalPages: 0,
  hasNext: false,
  hasPrevious: false,
}

const scheduledEditableMeeting = {
  ...editableMeeting,
  status: 'SCHEDULED' as const,
}

const unscheduledDraftMeeting = {
  ...editableMeeting,
  roomId: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
}

async function renderEditableWorkspace(
  meeting: MeetingView = editableMeeting,
  participantData:
    | typeof activeOrganizerAndParticipants
    | undefined = activeOrganizerAndParticipants,
  participantError?: unknown,
  detailResponses: Array<{
    data: MeetingView
    etag: string
  }> = [{ data: meeting, etag: 'etag-current' }]
) {
  let detailResponseIndex = 0
  vi.spyOn(coreApi, 'getWithMetaAndEtag').mockImplementation(async () => {
    const response =
      detailResponses[
        Math.min(detailResponseIndex++, detailResponses.length - 1)
      ]!
    return { data: response.data, meta: {}, etag: response.etag }
  })
  vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, _config) => {
    if (url === '/meetings/meeting-1/participants') {
      if (participantError) throw participantError
      return { data: participantData ?? [], meta: {} }
    }
    if (url === '/rooms/availability') {
      return {
        data: [],
        meta: { pagination: availabilityPagination },
      }
    }
    if (url === '/rooms/room-1') {
      return {
        data: { id: 'room-1', name: 'Boardroom', location: 'HQ' },
        meta: {},
      }
    }
    return { data: { id: 'current-user', name: 'Current User' }, meta: {} }
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
  return { queryClient, screen }
}

describe('MeetingWorkspacePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    toastSuccess.mockReset()
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
        return {
          data: { id: 'room-1', name: 'Boardroom', location: 'HQ' },
          meta: {},
        }
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
      .element(
        screen.getByRole('heading', { name: 'Authorized roadmap review' })
      )
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
    await expect
      .element(screen.getByText('Active participant').first())
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Removed membership history'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Historical participant').first())
      .toBeInTheDocument()
    await expect.element(screen.getByText('user-1')).not.toBeInTheDocument()
    await expect.element(screen.getByText('user-2')).not.toBeInTheDocument()
    await expect
      .element(
        screen.getByText(
          /AI Summary|Ask AI|Export Minutes|Vietnamese Transcript/
        )
      )
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
    await expect
      .element(screen.getByRole('button', { name: 'Retry' }))
      .toBeInTheDocument()
    expect(participantSpy).not.toHaveBeenCalled()
  })

  it('shows the edit action only when the current user is the organizer of an editable meeting', async () => {
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: {
        ...detail,
        organizerUserId: 'current-user',
        createdByUserId: 'current-user',
        roomId: null,
        status: 'DRAFT',
      },
      meta: {},
      etag: 'draft-etag',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
      data: [],
      meta: {},
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
      .element(screen.getByRole('button', { name: 'Edit meeting' }))
      .toBeInTheDocument()
  })

  it('does not show edit actions to a non-organizer even for a DRAFT meeting', async () => {
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: {
        ...detail,
        organizerUserId: 'organizer-1',
        roomId: null,
        status: 'DRAFT',
      },
      meta: {},
      etag: 'draft-etag',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/meetings/meeting-1/participants') {
        return { data: [], meta: {} }
      }
      return { data: { id: 'organizer-1', name: 'Organizer' }, meta: {} }
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
      .element(screen.getByRole('button', { name: 'Edit meeting' }))
      .not.toBeInTheDocument()
  })

  it('passes the canonical active membership count to room availability', async () => {
    const availabilityRequests: Array<Record<string, string>> = []
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: editableMeeting,
      meta: {},
      etag: 'draft-etag',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, config) => {
      if (url === '/meetings/meeting-1/participants') {
        return { data: activeOrganizerAndParticipants, meta: {} }
      }
      if (url === '/rooms/availability') {
        availabilityRequests.push(config?.params as Record<string, string>)
        return {
          data: [],
          meta: { pagination: availabilityPagination },
        }
      }
      if (url === '/rooms/room-1') {
        return {
          data: { id: 'room-1', name: 'Boardroom', location: 'HQ' },
          meta: {},
        }
      }
      return { data: { id: 'current-user', name: 'Current User' }, meta: {} }
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

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await expect
      .element(screen.getByRole('heading', { name: 'Edit meeting' }))
      .toBeInTheDocument()
    await expect.poll(() => availabilityRequests.length).toBe(1)
    expect(availabilityRequests[0]).toMatchObject({ participantCount: '3' })
  })

  it('uses a count of one for an organizer-only meeting', async () => {
    const availabilityRequests: Array<Record<string, string>> = []
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: editableMeeting,
      meta: {},
      etag: 'draft-etag',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, config) => {
      if (url === '/meetings/meeting-1/participants') {
        return { data: [activeOrganizerAndParticipants[0]], meta: {} }
      }
      if (url === '/rooms/availability') {
        availabilityRequests.push(config?.params as Record<string, string>)
        return {
          data: [],
          meta: { pagination: availabilityPagination },
        }
      }
      if (url === '/rooms/room-1') {
        return {
          data: { id: 'room-1', name: 'Boardroom', location: 'HQ' },
          meta: {},
        }
      }
      return { data: { id: 'current-user', name: 'Current User' }, meta: {} }
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

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await expect.poll(() => availabilityRequests.length).toBe(1)
    expect(availabilityRequests[0]).toMatchObject({ participantCount: '1' })
  })

  it('omits participant count when the participant lookup fails', async () => {
    const availabilityRequests: Array<Record<string, string>> = []
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: editableMeeting,
      meta: {},
      etag: 'draft-etag',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, config) => {
      if (url === '/meetings/meeting-1/participants') {
        throw new CoreApiError({
          message: 'Participant lookup failed',
          kind: 'network',
        })
      }
      if (url === '/rooms/availability') {
        availabilityRequests.push(config?.params as Record<string, string>)
        return {
          data: [],
          meta: { pagination: availabilityPagination },
        }
      }
      if (url === '/rooms/room-1') {
        return {
          data: { id: 'room-1', name: 'Boardroom', location: 'HQ' },
          meta: {},
        }
      }
      return { data: { id: 'current-user', name: 'Current User' }, meta: {} }
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

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await expect.poll(() => availabilityRequests.length).toBe(1)
    expect(availabilityRequests[0]).not.toHaveProperty('participantCount')
  })

  it('shows confirmed DRAFT metadata success after the edit dialog closes', async () => {
    const updatedMeeting = { ...editableMeeting, title: 'Updated draft' }
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: updatedMeeting, meta: {}, etag: 'etag-next' })
    const { screen } = await renderEditableWorkspace()

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Updated draft'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect
      .element(screen.getByRole('button', { name: 'Edit meeting' }))
      .toBeInTheDocument()
    await expect.poll(() => toastSuccess.mock.calls.length).toBe(1)
    expect(toastSuccess).toHaveBeenCalledWith(
      'Meeting changes saved',
      expect.objectContaining({
        description: 'The meeting changes were saved.',
      })
    )
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('shows Meeting scheduled only after the DRAFT schedule endpoint confirms', async () => {
    const scheduledMeeting = {
      ...unscheduledDraftMeeting,
      scheduledStartAt: '2026-09-01T02:00:00.000Z',
      scheduledEndAt: '2026-09-01T03:00:00.000Z',
      status: 'SCHEDULED' as const,
    }
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({
        data: {
          ...unscheduledDraftMeeting,
          scheduledStartAt: '2026-09-01T02:00:00.000Z',
          scheduledEndAt: '2026-09-01T03:00:00.000Z',
        },
        meta: {},
        etag: 'etag-after-patch',
      })
    const scheduleSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValue({
        data: scheduledMeeting,
        meta: {},
        etag: 'etag-next',
      })
    const { screen } = await renderEditableWorkspace(unscheduledDraftMeeting)

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Date', exact: true }),
      '2026-09-01'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Start time' }),
      '09:00'
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'End time' }),
      '10:00'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Save & Schedule' })
    )

    await expect.poll(() => toastSuccess.mock.calls.length).toBe(1)
    expect(toastSuccess).toHaveBeenCalledWith(
      'Meeting scheduled',
      expect.objectContaining({
        description: 'The meeting was successfully scheduled.',
      })
    )
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(scheduleSpy).toHaveBeenCalledTimes(1)
  })

  it('shows Meeting changes saved for a confirmed SCHEDULED metadata edit', async () => {
    const updatedMeeting = {
      ...scheduledEditableMeeting,
      title: 'Updated scheduled',
    }
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: updatedMeeting, meta: {}, etag: 'etag-next' })
    const { screen } = await renderEditableWorkspace(scheduledEditableMeeting)

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Updated scheduled'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect.poll(() => toastSuccess.mock.calls.length).toBe(1)
    expect(toastSuccess).toHaveBeenCalledWith(
      'Meeting changes saved',
      expect.anything()
    )
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('shows Meeting rescheduled for a confirmed SCHEDULED interval edit', async () => {
    const updatedMeeting = {
      ...scheduledEditableMeeting,
      scheduledStartAt: '2026-09-02T02:00:00.000Z',
      scheduledEndAt: '2026-09-02T03:00:00.000Z',
    }
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: updatedMeeting, meta: {}, etag: 'etag-next' })
    const { screen } = await renderEditableWorkspace(scheduledEditableMeeting)

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Date', exact: true }),
      '2026-09-02'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect.poll(() => toastSuccess.mock.calls.length).toBe(1)
    expect(toastSuccess).toHaveBeenCalledWith(
      'Meeting rescheduled',
      expect.objectContaining({
        description: 'The meeting schedule was updated.',
      })
    )
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not show success for a definitive patch failure', async () => {
    const failedPatch = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({ status: 409, message: 'Conflict', kind: 'http' })
      )
    const { screen } = await renderEditableWorkspace()

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Rejected edit'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await expect
      .element(screen.getByText('Meeting operation did not complete'))
      .toBeInTheDocument()
    expect(failedPatch).toHaveBeenCalledTimes(1)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('does not show success after a 412 stale-version recovery', async () => {
    const stalePatch = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({ status: 412, message: 'Stale', kind: 'http' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: editableMeeting,
      meta: {},
      etag: 'etag-server',
    })
    const { screen } = await renderEditableWorkspace()

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Stale edit'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await expect
      .element(screen.getByText('The meeting changed on the server.'))
      .toBeInTheDocument()
    expect(stalePatch).toHaveBeenCalledTimes(1)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('does not show success after an uncertain network outcome', async () => {
    vi.spyOn(coreApi, 'patchWithMetaAndEtag').mockRejectedValueOnce(
      new CoreApiError({ message: 'Connection lost', kind: 'network' })
    )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: editableMeeting,
      meta: {},
      etag: 'etag-server',
    })
    const { screen } = await renderEditableWorkspace()

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Uncertain edit'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await expect
      .element(
        screen.getByText(
          'The operation outcome could not be confirmed. The latest meeting data is available for review; your local edits were preserved.'
        )
      )
      .toBeInTheDocument()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('notifies once for confirmed reconciliation and ignores repeated invalidation', async () => {
    const reconciledMeeting = { ...editableMeeting, title: 'Reconciled title' }
    vi.spyOn(coreApi, 'patchWithMetaAndEtag').mockRejectedValueOnce(
      new CoreApiError({ message: 'Connection lost', kind: 'network' })
    )
    const { screen, queryClient } = await renderEditableWorkspace(
      editableMeeting,
      activeOrganizerAndParticipants,
      undefined,
      [
        { data: editableMeeting, etag: 'etag-current' },
        { data: reconciledMeeting, etag: 'etag-reconciled' },
      ]
    )

    await userEvent.click(screen.getByRole('button', { name: 'Edit meeting' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Title' }),
      'Reconciled title'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await expect.poll(() => toastSuccess.mock.calls.length).toBe(1)
    await queryClient.invalidateQueries({ queryKey: ['meetings', 'detail'] })
    await queryClient.invalidateQueries({ queryKey: ['meetings', 'list'] })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith(
      'Meeting changes saved',
      expect.anything()
    )
  })
})
