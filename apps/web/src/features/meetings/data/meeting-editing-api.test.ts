import { describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  buildMeetingEditPayload,
  parseMeetingEditResponse,
  updateMeeting,
} from './meeting-editing-api'

const draftMeeting = {
  id: 'meeting-1',
  title: 'Roadmap',
  description: 'Details',
  organizerUserId: 'organizer-1',
  roomId: 'room-1',
  scheduledStartAt: '2026-09-01T02:00:00.000Z',
  scheduledEndAt: '2026-09-01T03:00:00.000Z',
  status: 'DRAFT' as const,
  startedAt: null,
  endedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: 'organizer-1',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}

describe('meeting editing API adapter', () => {
  it('omits unchanged fields and sends explicit nulls for cleared values', () => {
    expect(
      buildMeetingEditPayload(draftMeeting, {
        title: '  Roadmap  ',
        description: '   ',
        scheduledStartAt: null,
        scheduledEndAt: null,
        roomId: null,
      })
    ).toEqual({
      description: null,
      scheduledStartAt: null,
      scheduledEndAt: null,
      roomId: null,
    })
  })

  it('builds a complete interval when either schedule value changes', () => {
    expect(
      buildMeetingEditPayload(draftMeeting, {
        title: draftMeeting.title,
        description: draftMeeting.description,
        scheduledStartAt: '2026-09-01T04:00:00.000Z',
        scheduledEndAt: '2026-09-01T05:00:00.000Z',
        roomId: draftMeeting.roomId,
      })
    ).toEqual({
      scheduledStartAt: '2026-09-01T04:00:00.000Z',
      scheduledEndAt: '2026-09-01T05:00:00.000Z',
    })
  })

  it('accepts descriptions longer than 500 characters because Core API stores TEXT', () => {
    const description = 'x'.repeat(501)

    expect(
      buildMeetingEditPayload(draftMeeting, {
        title: draftMeeting.title,
        description,
        scheduledStartAt: draftMeeting.scheduledStartAt,
        scheduledEndAt: draftMeeting.scheduledEndAt,
        roomId: draftMeeting.roomId,
      })
    ).toEqual({ description })
  })

  it('does not mark an equivalent offset interval dirty', () => {
    expect(
      buildMeetingEditPayload(
        {
          ...draftMeeting,
          scheduledStartAt: '2026-09-01T09:00:00+07:00',
          scheduledEndAt: '2026-09-01T10:00:00+07:00',
        },
        {
          title: draftMeeting.title,
          description: draftMeeting.description,
          scheduledStartAt: '2026-09-01T02:00:00.000Z',
          scheduledEndAt: '2026-09-01T03:00:00.000Z',
          roomId: draftMeeting.roomId,
        }
      )
    ).toEqual({})
  })

  it('validates the unchanged lifecycle and opaque response ETag', () => {
    expect(
      parseMeetingEditResponse(
        { data: draftMeeting, meta: {}, etag: 'etag-next' },
        'DRAFT'
      )
    ).toEqual({ meeting: draftMeeting, etag: 'etag-next' })
    expect(() =>
      parseMeetingEditResponse(
        {
          data: { ...draftMeeting, status: 'SCHEDULED' },
          meta: {},
          etag: 'etag',
        },
        'DRAFT'
      )
    ).toThrowError(CoreApiError)
  })

  it('PATCHes an encoded meeting ID with the current If-Match value', async () => {
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({ data: draftMeeting, meta: {}, etag: 'etag-next' })

    await expect(
      updateMeeting(
        'meeting/1',
        'opaque-current-etag',
        { title: 'Updated title' },
        'DRAFT'
      )
    ).resolves.toEqual({ meeting: draftMeeting, etag: 'etag-next' })

    expect(patchSpy).toHaveBeenCalledWith(
      '/meetings/meeting%2F1',
      { title: 'Updated title' },
      { headers: { 'If-Match': 'opaque-current-etag' } }
    )
  })
})
