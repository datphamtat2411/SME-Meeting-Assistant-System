import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  classifyParticipantMemberships,
  meetingDetailQueryOptions,
  meetingParticipantsQueryOptions,
  parseMeetingDetailResponse,
  parseMeetingParticipantsResponse,
} from './detail-api'

const meeting = {
  id: 'meeting-1',
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
  createdByUserId: 'creator-1',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
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
    addedAt: '2026-09-01T01:00:00Z',
    removedAt: '2026-09-01T02:00:00Z',
    removedByUserId: 'organizer-1',
    displayName: 'Historical participant',
  },
]

describe('meeting detail API adapter', () => {
  it('validates canonical detail fields, nullable schedule and room, and opaque ETags', () => {
    expect(
      parseMeetingDetailResponse({ data: meeting, meta: {}, etag: '"m-1-7"' })
    ).toEqual({ meeting, etag: '"m-1-7"' })

    expect(() =>
      parseMeetingDetailResponse({ data: meeting, meta: {} })
    ).toThrowError(/malformed/i)
    expect(() =>
      parseMeetingDetailResponse({
        data: { ...meeting, status: 'processing' },
        meta: {},
        etag: '"m-1-7"',
      })
    ).toThrowError(/malformed/i)
  })

  it('validates participant membership history and separates removed rows', () => {
    const result = parseMeetingParticipantsResponse({
      data: participants,
      meta: {},
    })

    expect(result).toEqual(participants)
    expect(classifyParticipantMemberships(result)).toEqual({
      active: [participants[0]],
      removed: [participants[1]],
    })
  })

  it('uses encoded detail endpoints, enabled participant fetching, and no automatic retries', async () => {
    const detailSpy = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValue({ data: meeting, meta: {}, etag: '"m-1-7"' })
    const participantSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValue({ data: participants, meta: {} })

    const detailOptions = meetingDetailQueryOptions('meeting/1')
    const participantOptions = meetingParticipantsQueryOptions(
      'meeting/1',
      false
    )

    expect(detailOptions.queryKey).toEqual(['meetings', 'detail', 'meeting/1'])
    expect(detailOptions.retry).toBe(false)
    expect(participantOptions.queryKey).toEqual([
      'meetings',
      'participants',
      'meeting/1',
    ])
    expect(participantOptions.enabled).toBe(false)
    expect(participantOptions.retry).toBe(false)

    const queryClient = new QueryClient()
    await detailOptions.queryFn?.({
      client: queryClient,
      queryKey: detailOptions.queryKey,
      signal: new AbortController().signal,
      meta: undefined,
    })
    const enabledParticipantOptions = meetingParticipantsQueryOptions(
      'meeting/1',
      true
    )
    await enabledParticipantOptions.queryFn?.({
      client: queryClient,
      queryKey: enabledParticipantOptions.queryKey,
      signal: new AbortController().signal,
      meta: undefined,
    })

    expect(detailSpy).toHaveBeenCalledWith('/meetings/meeting%2F1', {
      signal: expect.any(AbortSignal),
    })
    expect(participantSpy).toHaveBeenCalledWith(
      '/meetings/meeting%2F1/participants',
      { signal: expect.any(AbortSignal) }
    )
  })

  it('turns malformed participant responses into a Core API malformed error', () => {
    expect(() =>
      parseMeetingParticipantsResponse({
        data: [{ userId: 'missing-fields' }],
        meta: {},
      })
    ).toThrowError(CoreApiError)
  })

  it('accepts an unresolved projected identity without exposing an ID fallback', () => {
    const result = parseMeetingParticipantsResponse({
      data: [{ ...participants[0], displayName: null }],
      meta: {},
    })

    expect(result[0]?.displayName).toBeNull()
    expect(result[0]?.userId).toBe('user-1')
  })
})
