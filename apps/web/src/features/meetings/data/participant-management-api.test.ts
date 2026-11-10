import { describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  addMeetingParticipant,
  classifyParticipantMutationError,
  parseAddParticipantResponse,
  parseRemoveParticipantResponse,
  refreshMeetingParticipantState,
  removeMeetingParticipant,
} from './participant-management-api'

const meeting = {
  id: 'meeting/1',
  title: 'Roadmap',
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

const participant = {
  id: 'membership-1',
  meetingId: 'meeting/1',
  userId: 'user-2',
  addedByUserId: 'organizer-1',
  addedAt: '2026-09-01T00:00:00Z',
  removedAt: null,
  removedByUserId: null,
  displayName: 'Candidate User',
}

describe('participant management API adapter', () => {
  it('validates projected add and remove responses without requiring an add ETag', () => {
    expect(
      parseAddParticipantResponse({
        data: participant,
        meta: {},
        etag: 'ignored-add-etag',
      })
    ).toEqual(participant)
    expect(
      parseRemoveParticipantResponse({
        data: meeting,
        meta: {},
        etag: 'remove-etag',
      })
    ).toEqual({ meeting, etag: 'remove-etag' })
    expect(() =>
      parseAddParticipantResponse({
        data: { ...participant, id: '' },
        meta: {},
      })
    ).toThrowError(CoreApiError)
    expect(() =>
      parseRemoveParticipantResponse({ data: meeting, meta: {} })
    ).toThrowError(CoreApiError)
    expect(
      parseAddParticipantResponse({
        data: { ...participant, displayName: null },
        meta: {},
      })
    ).toEqual({ ...participant, displayName: null })
  })

  it('serializes encoded routes, current If-Match headers, and one-user add payloads', async () => {
    const addSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValue({ data: participant, meta: {}, etag: 'not-used' })
    const deleteSpy = vi
      .spyOn(coreApi, 'deleteWithMetaAndEtag')
      .mockResolvedValue({ data: meeting, meta: {}, etag: 'delete-etag' })

    await expect(
      addMeetingParticipant('meeting/1', 'etag-current', 'user-2')
    ).resolves.toEqual(participant)
    await expect(
      removeMeetingParticipant('meeting/1', 'user-2', 'etag-next')
    ).resolves.toEqual({ meeting, etag: 'delete-etag' })

    expect(addSpy).toHaveBeenCalledWith(
      '/meetings/meeting%2F1/participants',
      { userId: 'user-2' },
      { headers: { 'If-Match': 'etag-current' } }
    )
    expect(deleteSpy).toHaveBeenCalledWith(
      '/meetings/meeting%2F1/participants/user-2',
      { headers: { 'If-Match': 'etag-next' } }
    )
    expect(addSpy.mock.results[0]?.value).toBeDefined()
  })

  it('refreshes detail and all membership rows from the authoritative GET endpoints', async () => {
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({ data: meeting, meta: {}, etag: 'etag-fresh' })
    const participantsSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValue({ data: [participant], meta: {} })

    const signal = new AbortController().signal
    await expect(
      refreshMeetingParticipantState('meeting/1', signal)
    ).resolves.toEqual({
      detail: { meeting, etag: 'etag-fresh' },
      participants: [participant],
    })
    expect(detailSpy).toHaveBeenCalledWith('/meetings/meeting%2F1', {
      signal,
    })
    expect(participantsSpy).toHaveBeenCalledWith(
      '/meetings/meeting%2F1/participants',
      { signal }
    )
  })

  it('classifies status and contract failures without relying on backend messages', () => {
    expect(
      classifyParticipantMutationError(
        new CoreApiError({ status: 401, message: 'x', kind: 'http' })
      )
    ).toBe('unauthenticated')
    expect(
      classifyParticipantMutationError(
        new CoreApiError({ status: 403, message: 'x', kind: 'http' })
      )
    ).toBe('forbidden')
    expect(
      classifyParticipantMutationError(
        new CoreApiError({ status: 412, message: 'x', kind: 'http' })
      )
    ).toBe('precondition')
    expect(
      classifyParticipantMutationError(
        new CoreApiError({ status: 422, message: 'x', kind: 'http' })
      )
    ).toBe('invalid_candidate')
    expect(
      classifyParticipantMutationError(
        new CoreApiError({ status: 500, message: 'x', kind: 'server' })
      )
    ).toBe('temporary')
    expect(
      classifyParticipantMutationError(
        new CoreApiError({
          status: 409,
          code: 'ALREADY_ACTIVE',
          message: 'x',
          kind: 'http',
        })
      )
    ).toBe('duplicate')
    expect(
      classifyParticipantMutationError(
        new CoreApiError({
          status: 409,
          code: 'LIFECYCLE_TERMINAL',
          message: 'x',
          kind: 'http',
        })
      )
    ).toBe('terminal')
  })
})
