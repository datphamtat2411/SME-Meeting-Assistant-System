import { describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  fetchMeetingParticipantCandidates,
  isValidMeetingParticipantCandidateQuery,
  meetingParticipantCandidateQueryOptions,
  parseMeetingParticipantCandidateResponse,
  serializeMeetingParticipantCandidateQuery,
} from './meeting-candidates-api'

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

describe('meeting candidates API adapter', () => {
  it('serializes the required search and bounded zero-based pagination', () => {
    expect(
      serializeMeetingParticipantCandidateQuery({
        q: '  candidate  ',
        page: 2,
        pageSize: 10,
      })
    ).toEqual({ q: 'candidate', page: '1', size: '10' })
    expect(
      serializeMeetingParticipantCandidateQuery({
        q: 'a',
        page: 0,
        pageSize: 21,
      })
    ).toEqual({ q: 'a', page: '0', size: '20' })
  })

  it('requires two non-whitespace search characters and validates public fields', () => {
    expect(isValidMeetingParticipantCandidateQuery(' c ')).toBe(false)
    expect(isValidMeetingParticipantCandidateQuery(' ca ')).toBe(true)
    expect(
      parseMeetingParticipantCandidateResponse({
        data: [candidate],
        meta: { pagination },
      })
    ).toEqual({ candidates: [candidate], pagination })
    expect(() =>
      parseMeetingParticipantCandidateResponse({
        data: [{ ...candidate, email: null }],
        meta: { pagination },
      })
    ).toThrowError(CoreApiError)
  })

  it('uses the authorized candidate endpoint and disables invalid queries', async () => {
    const spy = vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
      data: [candidate],
      meta: { pagination },
    })
    const options = meetingParticipantCandidateQueryOptions({
      q: '  ca ',
      page: 2,
      pageSize: 10,
    })

    expect(options.queryKey[0]).toBe('users')
    expect(options.queryKey[1]).toBe('meeting-candidates')
    expect(options.enabled).toBe(true)
    expect(options.retry).toBe(false)
    await options.queryFn?.({
      client: {} as never,
      queryKey: options.queryKey,
      signal: new AbortController().signal,
      meta: undefined,
    })
    expect(spy).toHaveBeenCalledWith('/users/meeting-candidates', {
      params: { q: 'ca', page: '1', size: '10' },
      signal: expect.any(AbortSignal),
    })

    const invalidOptions = meetingParticipantCandidateQueryOptions({ q: 'x' })
    expect(invalidOptions.enabled).toBe(false)
    await expect(
      fetchMeetingParticipantCandidates({ q: 'x' })
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' })
  })
})
