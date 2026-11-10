import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import type { MeetingView, ParticipantView } from '../data/detail-api'
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
        data: [activeCandidate, historicalCandidate, candidate],
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
  }> = {},
  onReconciled = vi.fn()
) {
  const screen = await render(
    <QueryClientProvider client={createQueryClient()}>
      <MeetingParticipantManagement
        meeting={overrides.meeting ?? meeting}
        etag='etag-current'
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

  it('requires confirmation before remove and keeps selection after stale-version recovery', async () => {
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
      return {
        data: [organizer, historicalParticipant],
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
})
