import { describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  buildCancelMeetingPayload,
  cancelMeeting,
  classifyMeetingLifecycleError,
  endMeeting,
  parseMeetingLifecycleResponse,
  startMeeting,
} from './meeting-lifecycle-api'

const meeting = {
  id: 'meeting/1',
  title: 'Roadmap',
  description: null,
  organizerUserId: 'organizer-1',
  roomId: null,
  scheduledStartAt: '2026-09-01T02:00:00.000Z',
  scheduledEndAt: '2026-09-01T03:00:00.000Z',
  status: 'IN_PROGRESS' as const,
  startedAt: '2026-09-01T02:01:00.000Z',
  endedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: 'organizer-1',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T02:01:00.000Z',
}

describe('meeting lifecycle API adapter', () => {
  it('builds an optional cancellation reason without applying an unsupported length rule', () => {
    expect(buildCancelMeetingPayload('  Room unavailable  ')).toEqual({
      reason: 'Room unavailable',
    })
    expect(buildCancelMeetingPayload('   ')).toEqual({})
    expect(buildCancelMeetingPayload(undefined)).toEqual({})
    expect(buildCancelMeetingPayload('x'.repeat(501))).toEqual({
      reason: 'x'.repeat(501),
    })
  })

  it('validates the expected resulting status and opaque ETag', () => {
    expect(
      parseMeetingLifecycleResponse(
        { data: meeting, meta: {}, etag: 'W/"meeting-2"' },
        'IN_PROGRESS'
      )
    ).toEqual({ meeting, etag: 'W/"meeting-2"' })

    expect(() =>
      parseMeetingLifecycleResponse(
        { data: { ...meeting, status: 'ENDED' }, meta: {}, etag: 'etag' },
        'IN_PROGRESS'
      )
    ).toThrowError(CoreApiError)
    expect(() =>
      parseMeetingLifecycleResponse({ data: meeting, meta: {} }, 'IN_PROGRESS')
    ).toThrowError(/malformed/i)
  })

  it('uses encoded lifecycle routes, exact If-Match values, and the cancel payload only for cancellation', async () => {
    const mutationSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: meeting,
        meta: {},
        etag: 'start-etag',
      })
      .mockResolvedValueOnce({
        data: { ...meeting, status: 'ENDED', endedAt: meeting.updatedAt },
        meta: {},
        etag: 'end-etag',
      })
      .mockResolvedValueOnce({
        data: {
          ...meeting,
          status: 'CANCELLED',
          startedAt: null,
          cancelledAt: meeting.updatedAt,
          cancellationReason: 'Room unavailable',
        },
        meta: {},
        etag: 'cancel-etag',
      })

    await expect(startMeeting('meeting/1', '  start-etag  ')).resolves.toEqual({
      meeting,
      etag: 'start-etag',
    })
    await expect(endMeeting('meeting/1', 'end-etag')).resolves.toMatchObject({
      etag: 'end-etag',
    })
    await expect(
      cancelMeeting('meeting/1', 'cancel-etag', '  Room unavailable  ')
    ).resolves.toMatchObject({ etag: 'cancel-etag' })

    expect(mutationSpy).toHaveBeenNthCalledWith(
      1,
      '/meetings/meeting%2F1/start',
      undefined,
      { headers: { 'If-Match': '  start-etag  ' } }
    )
    expect(mutationSpy).toHaveBeenNthCalledWith(
      2,
      '/meetings/meeting%2F1/end',
      undefined,
      { headers: { 'If-Match': 'end-etag' } }
    )
    expect(mutationSpy).toHaveBeenNthCalledWith(
      3,
      '/meetings/meeting%2F1/cancel',
      { reason: 'Room unavailable' },
      { headers: { 'If-Match': 'cancel-etag' } }
    )
  })

  it('sends an empty cancellation object when no reason is supplied', async () => {
    const mutationSpy = vi
      .spyOn(coreApi, 'postWithMetaAndEtag')
      .mockResolvedValue({
        data: { ...meeting, status: 'CANCELLED' },
        meta: {},
        etag: 'cancel-etag',
      })

    await cancelMeeting('meeting-1', 'etag-current')

    expect(mutationSpy).toHaveBeenCalledWith(
      '/meetings/meeting-1/cancel',
      {},
      { headers: { 'If-Match': 'etag-current' } }
    )
  })

  it('classifies lifecycle failures by status and transport kind', () => {
    expect(
      classifyMeetingLifecycleError(
        new CoreApiError({ status: 401, message: 'x', kind: 'http' })
      )
    ).toBe('unauthenticated')
    expect(
      classifyMeetingLifecycleError(
        new CoreApiError({ status: 403, message: 'x', kind: 'http' })
      )
    ).toBe('forbidden')
    expect(
      classifyMeetingLifecycleError(
        new CoreApiError({ status: 404, message: 'x', kind: 'http' })
      )
    ).toBe('not_found')
    expect(
      classifyMeetingLifecycleError(
        new CoreApiError({ status: 409, message: 'x', kind: 'http' })
      )
    ).toBe('conflict')
    expect(
      classifyMeetingLifecycleError(
        new CoreApiError({ status: 412, message: 'x', kind: 'http' })
      )
    ).toBe('precondition')
    expect(
      classifyMeetingLifecycleError(
        new CoreApiError({ status: 428, message: 'x', kind: 'http' })
      )
    ).toBe('precondition')
    expect(
      classifyMeetingLifecycleError(
        new CoreApiError({ status: 422, message: 'x', kind: 'http' })
      )
    ).toBe('validation')
    expect(
      classifyMeetingLifecycleError(
        new CoreApiError({ status: 503, message: 'x', kind: 'server' })
      )
    ).toBe('temporary')
    expect(
      classifyMeetingLifecycleError(
        new CoreApiError({ message: 'x', kind: 'network' })
      )
    ).toBe('network')
    expect(
      classifyMeetingLifecycleError(
        new CoreApiError({ message: 'x', kind: 'malformed' })
      )
    ).toBe('malformed')
  })
})
