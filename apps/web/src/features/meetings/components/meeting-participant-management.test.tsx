import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import type { MeetingView, ParticipantView } from '../data/detail-api'
import type { MeetingParticipantRefresh } from '../data/participant-management-api'
import { MeetingParticipantManagement } from './meeting-participant-management'

const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { success: toastSuccess },
}))

const meeting: MeetingView = {
  id: 'meeting-1',
  title: 'Roadmap',
  description: null,
  organizerUserId: 'organizer-1',
  roomId: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
  status: 'DRAFT',
  startedAt: null,
  endedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: 'organizer-1',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}

const organizer: ParticipantView = {
  id: 'membership-organizer',
  meetingId: 'meeting-1',
  userId: 'organizer-1',
  addedByUserId: 'organizer-1',
  addedAt: '2026-09-01T00:00:00Z',
  removedAt: null,
  removedByUserId: null,
  displayName: 'Organizer',
}

const activeParticipant: ParticipantView = {
  id: 'membership-active',
  meetingId: 'meeting-1',
  userId: 'user-2',
  addedByUserId: 'organizer-1',
  addedAt: '2026-09-01T00:01:00Z',
  removedAt: null,
  removedByUserId: null,
  displayName: 'Active participant',
}

const historicalParticipant: ParticipantView = {
  id: 'membership-history',
  meetingId: 'meeting-1',
  userId: 'user-3',
  addedByUserId: 'organizer-1',
  addedAt: '2026-09-01T00:02:00Z',
  removedAt: '2026-09-01T00:03:00Z',
  removedByUserId: 'organizer-1',
  displayName: 'Historical participant',
}

const candidate = {
  id: 'user-4',
  displayName: 'New candidate',
  email: 'new@example.com',
  organizationalUnitName: 'Product',
}

const secondCandidate = {
  id: 'user-5',
  displayName: 'Second candidate',
  email: 'second@example.com',
  organizationalUnitName: 'Product',
}

const historicalCandidate = {
  id: 'user-3',
  displayName: 'Historical participant',
  email: 'history@example.com',
  organizationalUnitName: null,
}

const activeCandidate = {
  id: 'user-2',
  displayName: 'Active participant',
  email: 'active@example.com',
  organizationalUnitName: null,
}

const pagination = {
  page: 0,
  size: 20,
  totalElements: 3,
  totalPages: 1,
  hasNext: false,
  hasPrevious: false,
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function mockCandidates() {
  vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
    if (url === '/users/meeting-candidates') {
      return {
        data: [
          activeCandidate,
          historicalCandidate,
          candidate,
          secondCandidate,
        ],
        meta: { pagination },
      }
    }
    return { data: [], meta: {} }
  })
}

async function renderManagement(
  overrides: Partial<{
    meeting: MeetingView
    participants: ParticipantView[]
    currentUserId: string
    etag: string
  }> = {},
  onReconciled = vi.fn()
) {
  const screen = await render(
    <QueryClientProvider client={createQueryClient()}>
      <MeetingParticipantManagement
        meeting={overrides.meeting ?? meeting}
        etag={overrides.etag ?? 'etag-current'}
        currentUserId={overrides.currentUserId ?? 'organizer-1'}
        participants={
          overrides.participants ?? [
            organizer,
            activeParticipant,
            historicalParticipant,
          ]
        }
        onReconciled={onReconciled}
      />
    </QueryClientProvider>
  )
  return { screen, onReconciled }
}

function SynchronizedManagement({
  onReconciled = vi.fn(),
}: {
  onReconciled?: (
    refresh: MeetingParticipantRefresh,
    confirmed: boolean
  ) => void
}) {
  const [state, setState] = useState({
    meeting,
    participants: [organizer, activeParticipant, historicalParticipant],
    etag: 'etag-current',
  })

  return (
    <MeetingParticipantManagement
      meeting={state.meeting}
      etag={state.etag}
      currentUserId='organizer-1'
      participants={state.participants}
      onReconciled={(refresh, confirmed) => {
        setState({
          meeting: refresh.detail.meeting,
          participants: refresh.participants,
          etag: refresh.detail.etag,
        })
        onReconciled(refresh, confirmed)
      }}
    />
  )
}

function SessionChangingManagement() {
  const [currentUserId, setCurrentUserId] = useState('organizer-1')

  return (
    <>
      <button
        type='button'
        onClick={() =>
          setCurrentUserId((current) =>
            current === 'organizer-1' ? 'viewer-1' : 'organizer-1'
          )
        }
      >
        Switch session actor
      </button>
      <MeetingParticipantManagement
        meeting={meeting}
        etag='etag-current'
        currentUserId={currentUserId}
        participants={[organizer, activeParticipant, historicalParticipant]}
        onReconciled={vi.fn()}
      />
    </>
  )
}

describe('MeetingParticipantManagement', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    toastSuccess.mockReset()
  })

  it('renders projected identities, separates history, and protects the organizer row', async () => {
    mockCandidates()
    const { screen } = await renderManagement()

    await expect
      .element(screen.getByText('Organizer', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Active participant', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(
        screen.getByText('Historical participant', { exact: true }).first()
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Removed membership history'))
      .toBeInTheDocument()
    await expect
      .element(
        screen.getByRole('button', { name: 'Remove Active participant' })
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Remove Organizer' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByText('organizer-1'))
      .not.toBeInTheDocument()
    await expect.element(screen.getByText('user-2')).not.toBeInTheDocument()
  })

  it('shows controls only to the organizer in non-terminal lifecycle states', async () => {
    mockCandidates()
    const { screen: nonOrganizer } = await renderManagement({
      currentUserId: 'viewer-1',
    })
    await expect
      .element(nonOrganizer.getByRole('button', { name: 'Add participant' }))
      .not.toBeInTheDocument()

    const terminalMeeting = { ...meeting, status: 'ENDED' as const }
    const { screen: terminal } = await renderManagement({
      meeting: terminalMeeting,
    })
    await expect
      .element(terminal.getByRole('button', { name: 'Add participant' }))
      .not.toBeInTheDocument()
    await expect
      .element(
        terminal.getByRole('button', { name: 'Remove Active participant' })
      )
      .not.toBeInTheDocument()
  })

  it('excludes active memberships, permits historical re-addition, and confirms add after fresh reconciliation', async () => {
    mockCandidates()
    const addedParticipant = {
      ...candidate,
      id: 'user-4',
    }
    const addSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockResolvedValue({
      data: {
        ...candidate,
        id: 'membership-new',
        meetingId: meeting.id,
        userId: candidate.id,
        addedByUserId: meeting.organizerUserId,
        addedAt: '2026-09-01T00:04:00Z',
        removedAt: null,
        removedByUserId: null,
        displayName: candidate.displayName,
      },
      meta: {},
      etag: 'not-authoritative',
    })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: meeting,
      meta: {},
      etag: 'etag-after-add',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return {
          data: [activeCandidate, historicalCandidate, candidate],
          meta: { pagination },
        }
      }
      return {
        data: [
          organizer,
          activeParticipant,
          historicalParticipant,
          {
            ...addedParticipant,
            id: 'membership-new',
            meetingId: meeting.id,
            userId: candidate.id,
            addedByUserId: meeting.organizerUserId,
            addedAt: '2026-09-01T00:04:00Z',
            removedAt: null,
            removedByUserId: null,
            displayName: candidate.displayName,
          },
        ],
        meta: {},
      }
    })
    const onReconciled = vi.fn()
    const { screen } = await renderManagement({}, onReconciled)

    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    const search = screen.getByPlaceholder('Search active participants...')
    await userEvent.fill(search, 'participant')
    await expect
      .element(screen.getByRole('option', { name: /Historical participant/ }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('option', { name: /Active participant/ }))
      .not.toBeInTheDocument()

    await userEvent.fill(search, 'new')
    await userEvent.click(screen.getByRole('option', { name: /New candidate/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Add participant' })
    )

    await expect.poll(() => addSpy.mock.calls.length).toBe(1)
    expect(addSpy).toHaveBeenCalledWith(
      '/meetings/meeting-1/participants',
      { userId: 'user-4' },
      { headers: { 'If-Match': 'etag-current' } }
    )
    await expect.poll(() => onReconciled.mock.calls.length).toBe(1)
    expect(onReconciled.mock.calls[0]?.[1]).toBe(true)
    expect(toastSuccess).toHaveBeenCalledWith(
      'Participant added',
      expect.anything()
    )
  })

  it('requires confirmation before remove and preserves intent after a real stale-version recovery', async () => {
    mockCandidates()
    const deleteSpy = vi
      .spyOn(coreApi, 'deleteWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ status: 412, message: 'stale', kind: 'http' })
      )
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({
        data: meeting,
        meta: {},
        etag: 'etag-after-remove',
      })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return { data: [candidate], meta: { pagination } }
      }
      return {
        data: [organizer, activeParticipant, historicalParticipant],
        meta: {},
      }
    })
    const { screen } = await renderManagement()

    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Active participant' })
    )
    await expect.element(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(deleteSpy).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove participant' })
    )
    await expect.poll(() => deleteSpy.mock.calls.length).toBe(1)
    await expect.poll(() => detailSpy.mock.calls.length).toBe(1)
    await expect
      .element(screen.getByText(/changed on the server/))
      .toBeInTheDocument()
    await expect
      .element(
        screen.getByRole('button', { name: 'Remove Active participant' })
      )
      .toBeInTheDocument()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('preserves the add selection after stale-version recovery without false success', async () => {
    mockCandidates()
    const staleAdd = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ status: 412, message: 'stale', kind: 'http' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: meeting,
      meta: {},
      etag: 'etag-refreshed',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return { data: [candidate], meta: { pagination } }
      }
      return {
        data: [organizer, activeParticipant, historicalParticipant],
        meta: {},
      }
    })
    const { screen: staleScreen } = await renderManagement()
    await userEvent.click(
      staleScreen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      staleScreen.getByPlaceholder('Search active participants...'),
      'new'
    )
    await userEvent.click(
      staleScreen.getByRole('option', { name: /New candidate/ })
    )
    await userEvent.click(
      staleScreen.getByRole('button', { name: 'Add participant' })
    )
    await expect.poll(() => staleAdd.mock.calls.length).toBe(1)
    await expect
      .element(staleScreen.getByText(/changed on the server/))
      .toBeInTheDocument()
    await expect
      .element(staleScreen.getByText('1 participant selected'))
      .toBeInTheDocument()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('locks add and remove after a confirmed add cannot verify the new version', async () => {
    mockCandidates()
    const addSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockResolvedValue({
      data: {
        id: 'membership-new',
        meetingId: meeting.id,
        userId: candidate.id,
        addedByUserId: meeting.organizerUserId,
        addedAt: '2026-09-01T00:04:00Z',
        removedAt: null,
        removedByUserId: null,
        displayName: candidate.displayName,
      },
      meta: {},
      etag: 'ignored-add-etag',
    })
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
      .mockResolvedValue({ data: meeting, meta: {}, etag: 'etag-v2' })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return { data: [candidate], meta: { pagination } }
      }
      return { data: [organizer, activeParticipant], meta: {} }
    })

    const { screen } = await renderManagement()
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'new'
    )
    await userEvent.click(screen.getByRole('option', { name: /New candidate/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Add participant' })
    )

    await expect.poll(() => addSpy.mock.calls.length).toBe(1)
    await expect
      .element(
        screen.getByText(/latest meeting version could not be verified/i)
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Retry refresh' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Add participant' }))
      .toBeDisabled()
    await expect
      .element(
        screen.getByRole('button', { name: 'Remove Active participant' })
      )
      .toBeDisabled()
    expect(addSpy).toHaveBeenCalledTimes(1)
  })

  it('retries only GET reconciliation after a detail refresh failure', async () => {
    mockCandidates()
    const addSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockResolvedValue({
      data: {
        id: 'membership-new',
        meetingId: meeting.id,
        userId: candidate.id,
        addedByUserId: meeting.organizerUserId,
        addedAt: '2026-09-01T00:04:00Z',
        removedAt: null,
        removedByUserId: null,
        displayName: candidate.displayName,
      },
      meta: {},
      etag: 'ignored-add-etag',
    })
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockRejectedValueOnce(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
      .mockResolvedValue({ data: meeting, meta: {}, etag: 'etag-v2' })
    const participantsSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (url) => {
        if (url === '/users/meeting-candidates') {
          return { data: [candidate], meta: { pagination } }
        }
        return { data: [organizer, activeParticipant], meta: {} }
      })

    const { screen } = await renderManagement()
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'new'
    )
    await userEvent.click(screen.getByRole('option', { name: /New candidate/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Add participant' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Retry refresh' }))
      .toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Retry refresh' }))
    await expect.poll(() => detailSpy.mock.calls.length).toBe(2)
    await expect
      .poll(
        () =>
          participantsSpy.mock.calls.filter(
            ([url]) => url === '/meetings/meeting-1/participants'
          ).length
      )
      .toBe(2)
    await expect
      .element(screen.getByText('Participant added', { exact: true }))
      .not.toBeInTheDocument()
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it('locks after a participant-list refresh failure and retries both GETs only', async () => {
    mockCandidates()
    const addSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockResolvedValue({
      data: {
        id: 'membership-new',
        meetingId: meeting.id,
        userId: candidate.id,
        addedByUserId: meeting.organizerUserId,
        addedAt: '2026-09-01T00:04:00Z',
        removedAt: null,
        removedByUserId: null,
        displayName: candidate.displayName,
      },
      meta: {},
      etag: 'ignored-add-etag',
    })
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({
        data: meeting,
        meta: {},
        etag: 'etag-v2',
      })
    let participantRefreshCount = 0
    const participantsSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (url) => {
        if (url === '/users/meeting-candidates') {
          return { data: [candidate], meta: { pagination } }
        }
        participantRefreshCount += 1
        if (participantRefreshCount === 1) {
          throw new CoreApiError({
            message: 'Connection lost',
            kind: 'network',
          })
        }
        return { data: [organizer, activeParticipant], meta: {} }
      })

    const { screen } = await renderManagement()
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'new'
    )
    await userEvent.click(screen.getByRole('option', { name: /New candidate/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Add participant' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Retry refresh' }))
      .toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Retry refresh' }))
    await expect.poll(() => detailSpy.mock.calls.length).toBe(2)
    await expect.poll(() => participantRefreshCount).toBe(2)
    expect(
      participantsSpy.mock.calls.filter(
        ([url]) => url === '/meetings/meeting-1/participants'
      )
    ).toHaveLength(2)
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it('keeps controls locked when retrying a failed reconciliation fails again', async () => {
    mockCandidates()
    const addSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockResolvedValue({
      data: {
        id: 'membership-new',
        meetingId: meeting.id,
        userId: candidate.id,
        addedByUserId: meeting.organizerUserId,
        addedAt: '2026-09-01T00:04:00Z',
        removedAt: null,
        removedByUserId: null,
        displayName: candidate.displayName,
      },
      meta: {},
      etag: 'ignored-add-etag',
    })
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return { data: [candidate], meta: { pagination } }
      }
      return { data: [organizer, activeParticipant], meta: {} }
    })

    const { screen } = await renderManagement()
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'new'
    )
    await userEvent.click(screen.getByRole('option', { name: /New candidate/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Add participant' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Retry refresh' }))

    await expect.poll(() => detailSpy.mock.calls.length).toBe(2)
    await expect
      .element(screen.getByRole('button', { name: 'Retry refresh' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Add participant' }))
      .toBeDisabled()
    expect(addSpy).toHaveBeenCalledTimes(1)
  })

  it('reconciles a successful delete before showing the confirmed removal', async () => {
    mockCandidates()
    const deleteSpy = vi
      .spyOn(coreApi, 'deleteWithMetaAndEtag')
      .mockResolvedValue({ data: meeting, meta: {}, etag: 'delete-etag' })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: meeting,
      meta: {},
      etag: 'etag-after-remove',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return { data: [candidate], meta: { pagination } }
      }
      return { data: [organizer, historicalParticipant], meta: {} }
    })

    const { screen, onReconciled } = await renderManagement()
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Active participant' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove participant' })
    )

    await expect.poll(() => deleteSpy.mock.calls.length).toBe(1)
    await expect.poll(() => onReconciled.mock.calls.length).toBe(1)
    expect(onReconciled.mock.calls[0]?.[1]).toBe(true)
    expect(toastSuccess).toHaveBeenCalledWith(
      'Participant removed',
      expect.anything()
    )
  })

  it('locks after a successful delete when participant reconciliation fails', async () => {
    mockCandidates()
    const deleteSpy = vi
      .spyOn(coreApi, 'deleteWithMetaAndEtag')
      .mockResolvedValue({ data: meeting, meta: {}, etag: 'delete-etag' })
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockRejectedValueOnce(
      new CoreApiError({ message: 'Connection lost', kind: 'network' })
    )
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return { data: [candidate], meta: { pagination } }
      }
      return { data: [organizer, activeParticipant], meta: {} }
    })

    const { screen } = await renderManagement()
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Active participant' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove participant' })
    )

    await expect
      .element(screen.getByRole('button', { name: 'Retry refresh' }))
      .toBeInTheDocument()
    await expect
      .element(
        screen.getByRole('button', { name: 'Remove Active participant' })
      )
      .toBeDisabled()
    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('uses the ETag returned by the authoritative refresh for the next add', async () => {
    vi.spyOn(coreApi, 'postWithMetaAndEtag').mockResolvedValue({
      data: {
        id: 'membership-new',
        meetingId: meeting.id,
        userId: candidate.id,
        addedByUserId: meeting.organizerUserId,
        addedAt: '2026-09-01T00:04:00Z',
        removedAt: null,
        removedByUserId: null,
        displayName: candidate.displayName,
      },
      meta: {},
      etag: 'ignored-add-etag',
    })
    const addSpy = vi.mocked(coreApi.postWithMetaAndEtag)
    vi.spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({ data: meeting, meta: {}, etag: 'etag-v2' })
      .mockResolvedValueOnce({ data: meeting, meta: {}, etag: 'etag-v3' })
    let participantRefresh = 0
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return {
          data: [candidate, secondCandidate],
          meta: { pagination },
        }
      }
      participantRefresh += 1
      return {
        data:
          participantRefresh === 1
            ? [
                organizer,
                activeParticipant,
                historicalParticipant,
                {
                  id: 'membership-new',
                  meetingId: meeting.id,
                  userId: candidate.id,
                  addedByUserId: meeting.organizerUserId,
                  addedAt: '2026-09-01T00:04:00Z',
                  removedAt: null,
                  removedByUserId: null,
                  displayName: candidate.displayName,
                },
              ]
            : [organizer, activeParticipant, historicalParticipant],
        meta: {},
      }
    })

    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <SynchronizedManagement />
      </QueryClientProvider>
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'new'
    )
    await userEvent.click(screen.getByRole('option', { name: /New candidate/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Add participant' })
    )
    await expect.poll(() => addSpy.mock.calls.length).toBe(1)

    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'second'
    )
    await userEvent.click(
      screen.getByRole('option', { name: /Second candidate/ })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Add participant' })
    )

    await expect.poll(() => addSpy.mock.calls.length).toBe(2)
    expect(addSpy.mock.calls[0]?.[2]).toEqual({
      headers: { 'If-Match': 'etag-current' },
    })
    expect(addSpy.mock.calls[1]?.[2]).toEqual({
      headers: { 'If-Match': 'etag-v2' },
    })
  })

  it('reports an ambiguous add as observed state rather than confirmed success', async () => {
    mockCandidates()
    const addSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: meeting,
      meta: {},
      etag: 'etag-observed',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return { data: [candidate], meta: { pagination } }
      }
      return {
        data: [
          organizer,
          activeParticipant,
          historicalParticipant,
          {
            id: 'membership-new',
            meetingId: meeting.id,
            userId: candidate.id,
            addedByUserId: meeting.organizerUserId,
            addedAt: '2026-09-01T00:04:00Z',
            removedAt: null,
            removedByUserId: null,
            displayName: candidate.displayName,
          },
        ],
        meta: {},
      }
    })

    const { screen, onReconciled } = await renderManagement()
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'new'
    )
    await userEvent.click(screen.getByRole('option', { name: /New candidate/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Add participant' })
    )

    await expect
      .element(
        screen.getByText(
          /latest participant state has been refreshed.*original request outcome could not be confirmed/i
        )
      )
      .toBeInTheDocument()
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(onReconciled.mock.calls[0]?.[1]).toBe(false)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('preserves ambiguous add intent when the requested state is not observed', async () => {
    mockCandidates()
    vi.spyOn(coreApi, 'postWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({ message: 'Connection lost', kind: 'network' })
    )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: meeting,
      meta: {},
      etag: 'etag-observed',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return { data: [candidate], meta: { pagination } }
      }
      return {
        data: [organizer, activeParticipant, historicalParticipant],
        meta: {},
      }
    })

    const { screen } = await renderManagement()
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'new'
    )
    await userEvent.click(screen.getByRole('option', { name: /New candidate/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Add participant' })
    )

    await expect
      .element(screen.getByText(/requested membership state was not found/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('1 participant selected'))
      .toBeInTheDocument()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('reports ambiguous delete state without a removal success toast', async () => {
    mockCandidates()
    const deleteSpy = vi
      .spyOn(coreApi, 'deleteWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: meeting,
      meta: {},
      etag: 'etag-observed',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return { data: [candidate], meta: { pagination } }
      }
      return { data: [organizer, historicalParticipant], meta: {} }
    })

    const { screen } = await renderManagement()
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Active participant' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove participant' })
    )

    await expect
      .element(
        screen.getByText(
          /latest participant state has been refreshed.*original request outcome could not be confirmed/i
        )
      )
      .toBeInTheDocument()
    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('refreshes a duplicate conflict without treating the conflict as a confirmed add', async () => {
    mockCandidates()
    const addSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({
        status: 409,
        code: 'ALREADY_ACTIVE',
        message: 'duplicate',
        kind: 'http',
      })
    )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: meeting,
      meta: {},
      etag: 'etag-v2',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return { data: [candidate], meta: { pagination } }
      }
      return {
        data: [organizer, activeParticipant, historicalParticipant],
        meta: {},
      }
    })

    const { screen } = await renderManagement()
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'new'
    )
    await userEvent.click(screen.getByRole('option', { name: /New candidate/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Add participant' })
    )

    await expect
      .element(screen.getByText(/already has an active membership/i))
      .toBeInTheDocument()
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it.each([401, 403, 404] as const)(
    'blocks further membership actions after an authorization-related %s response without retrying',
    async (status) => {
      mockCandidates()
      const addSpy = vi
        .spyOn(coreApi, 'postWithMetaAndEtag')
        .mockRejectedValue(
          new CoreApiError({ status, message: 'denied', kind: 'http' })
        )
      const detailSpy = vi.spyOn(coreApi, 'getWithMetaAndEtag')

      const { screen } = await renderManagement()
      await userEvent.click(
        screen.getByRole('combobox', { name: 'Participants' })
      )
      await userEvent.fill(
        screen.getByPlaceholder('Search active participants...'),
        'new'
      )
      await userEvent.click(
        screen.getByRole('option', { name: /New candidate/ })
      )
      await userEvent.click(
        screen.getByRole('button', { name: 'Add participant' })
      )

      await expect
        .element(
          screen.getByText(
            /session is no longer authenticated|no local success was recorded|could not be found/i
          )
        )
        .toBeInTheDocument()
      await expect
        .element(screen.getByRole('button', { name: 'Add participant' }))
        .not.toBeInTheDocument()
      expect(addSpy).toHaveBeenCalledTimes(1)
      expect(detailSpy).not.toHaveBeenCalled()
    }
  )

  it('prevents a second click while the first participant mutation is in flight', async () => {
    mockCandidates()
    let resolveAdd: ((value: unknown) => void) | undefined
    const addSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAdd = resolve
        }) as never
    )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: meeting,
      meta: {},
      etag: 'etag-v2',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return { data: [candidate], meta: { pagination } }
      }
      return { data: [organizer, activeParticipant], meta: {} }
    })

    const { screen } = await renderManagement()
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'new'
    )
    await userEvent.click(screen.getByRole('option', { name: /New candidate/ }))
    const addButton = screen.getByRole('button', {
      name: 'Add participant',
    })
    await userEvent.click(addButton)
    await expect.poll(() => addSpy.mock.calls.length).toBe(1)
    await expect
      .element(screen.getByRole('button', { name: 'Adding participant...' }))
      .toBeDisabled()
    expect(addSpy).toHaveBeenCalledTimes(1)

    resolveAdd?.({
      data: {
        id: 'membership-new',
        meetingId: meeting.id,
        userId: candidate.id,
        addedByUserId: meeting.organizerUserId,
        addedAt: '2026-09-01T00:04:00Z',
        removedAt: null,
        removedByUserId: null,
        displayName: candidate.displayName,
      },
      meta: {},
      etag: 'ignored-add-etag',
    })
  })

  it('removes mutation controls when conflict reconciliation reports a terminal lifecycle', async () => {
    const addSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockRejectedValue(
        new CoreApiError({ status: 409, message: 'lifecycle', kind: 'http' })
      )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: { ...meeting, status: 'ENDED' },
      meta: {},
      etag: 'etag-ended',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return { data: [candidate], meta: { pagination } }
      }
      return { data: [organizer, activeParticipant], meta: {} }
    })

    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <SynchronizedManagement />
      </QueryClientProvider>
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'new'
    )
    await userEvent.click(screen.getByRole('option', { name: /New candidate/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Add participant' })
    )

    await expect
      .element(
        screen.getByText(/no longer allowed for this meeting lifecycle/i)
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Add participant' }))
      .not.toBeInTheDocument()
    expect(addSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps ambiguous removal intent when the participant remains active', async () => {
    mockCandidates()
    vi.spyOn(coreApi, 'deleteWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({ message: 'Connection lost', kind: 'network' })
    )
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: meeting,
      meta: {},
      etag: 'etag-observed',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/users/meeting-candidates') {
        return { data: [candidate], meta: { pagination } }
      }
      return {
        data: [organizer, activeParticipant, historicalParticipant],
        meta: {},
      }
    })

    const { screen } = await renderManagement()
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Active participant' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove participant' })
    )

    await expect
      .element(screen.getByText(/requested membership state was not found/i))
      .toBeInTheDocument()
    await expect
      .element(
        screen.getByRole('button', { name: 'Remove Active participant' })
      )
      .toBeInTheDocument()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('does not reuse participant state after the session actor changes', async () => {
    mockCandidates()
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <SessionChangingManagement />
      </QueryClientProvider>
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Participants' })
    )
    await userEvent.fill(
      screen.getByPlaceholder('Search active participants...'),
      'new'
    )
    await userEvent.click(screen.getByRole('option', { name: /New candidate/ }))
    await expect
      .element(screen.getByText('1 participant selected'))
      .toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Switch session actor' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Add participant' }))
      .not.toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Switch session actor' })
    )
    await expect
      .element(screen.getByText('1 participant selected'))
      .not.toBeInTheDocument()
  })

  it.each(['DRAFT', 'SCHEDULED', 'IN_PROGRESS'] as const)(
    'enables organizer membership controls in %s',
    async (status) => {
      mockCandidates()
      const { screen } = await renderManagement({
        meeting: { ...meeting, status },
      })
      await expect
        .element(screen.getByRole('button', { name: 'Add participant' }))
        .toBeInTheDocument()
      await expect
        .element(
          screen.getByRole('button', { name: 'Remove Active participant' })
        )
        .toBeInTheDocument()
    }
  )

  it.each(['ENDED', 'CANCELLED'] as const)(
    'disables organizer membership controls in %s',
    async (status) => {
      mockCandidates()
      const { screen } = await renderManagement({
        meeting: { ...meeting, status },
      })
      await expect
        .element(screen.getByRole('button', { name: 'Add participant' }))
        .not.toBeInTheDocument()
      await expect
        .element(
          screen.getByRole('button', { name: 'Remove Active participant' })
        )
        .not.toBeInTheDocument()
    }
  )

  it('keeps every lifecycle read-only for non-organizers', async () => {
    for (const status of [
      'DRAFT',
      'SCHEDULED',
      'IN_PROGRESS',
      'ENDED',
      'CANCELLED',
    ] as const) {
      mockCandidates()
      const { screen } = await renderManagement({
        meeting: { ...meeting, status },
        currentUserId: 'viewer-1',
      })
      await expect
        .element(screen.getByRole('button', { name: 'Add participant' }))
        .not.toBeInTheDocument()
      await expect
        .element(
          screen.getByRole('button', { name: 'Remove Active participant' })
        )
        .not.toBeInTheDocument()
    }
  })
})
