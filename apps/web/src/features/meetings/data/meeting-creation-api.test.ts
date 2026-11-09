import { describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  buildCreateMeetingPayload,
  buildScheduleCheckPayload,
  buildScheduleMeetingPayload,
  canonicalizeLocalDateTime,
  checkMeetingSchedule,
  classifyMeetingMutationError,
  createMeeting,
  mapMeetingFieldErrors,
  parseCreateMeetingResponse,
  parseScheduleCheckResponse,
  parseScheduleMeetingResponse,
  scheduleMeeting,
} from './meeting-creation-api'

const meeting = {
  id: 'meeting-1',
  title: 'Roadmap',
  description: null,
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

const scheduledMeeting = { ...meeting, status: 'SCHEDULED' as const }

describe('meeting creation API adapter', () => {
  it('canonicalizes local date/time values without a hard-coded timezone', () => {
    expect(canonicalizeLocalDateTime('2026-09-01', '09:00')).toMatch(
      /2026-09-01T\d{2}:00:00\.000Z/
    )
    expect(canonicalizeLocalDateTime('not-a-date', '09:00')).toBeUndefined()
  })

  it('omits optional draft fields and preserves selected participant IDs', () => {
    expect(
      buildCreateMeetingPayload({
        title: '  Roadmap  ',
        description: '  Details  ',
        scheduledStartAt: '2026-09-01T02:00:00.000Z',
        scheduledEndAt: '2026-09-01T03:00:00.000Z',
        roomId: 'room-1',
        participantUserIds: ['user-1', 'user-2'],
      })
    ).toEqual({
      title: 'Roadmap',
      description: 'Details',
      scheduledStartAt: '2026-09-01T02:00:00.000Z',
      scheduledEndAt: '2026-09-01T03:00:00.000Z',
      roomId: 'room-1',
      participantUserIds: ['user-1', 'user-2'],
    })
    expect(buildCreateMeetingPayload({ title: 'Draft' })).toEqual({
      title: 'Draft',
    })
  })

  it('builds schedule-check and schedule payloads without inventing optional values', () => {
    expect(
      buildScheduleCheckPayload({
        start: '2026-09-01T02:00:00.000Z',
        end: '2026-09-01T03:00:00.000Z',
        roomId: 'room-1',
        participantUserIds: ['user-1'],
      })
    ).toEqual({
      roomId: 'room-1',
      start: '2026-09-01T02:00:00.000Z',
      end: '2026-09-01T03:00:00.000Z',
      participantUserIds: ['user-1'],
    })
    expect(
      buildScheduleMeetingPayload({
        scheduledStartAt: '2026-09-01T02:00:00.000Z',
        scheduledEndAt: '2026-09-01T03:00:00.000Z',
      })
    ).toEqual({
      scheduledStartAt: '2026-09-01T02:00:00.000Z',
      scheduledEndAt: '2026-09-01T03:00:00.000Z',
    })
  })

  it('validates create and schedule status plus exact opaque ETags', () => {
    expect(
      parseCreateMeetingResponse({ data: meeting, meta: {}, etag: 'W/"m-7"' })
    ).toEqual({ meeting, etag: 'W/"m-7"' })
    expect(
      parseScheduleMeetingResponse({
        data: scheduledMeeting,
        meta: {},
        etag: 'opaque;v=8',
      })
    ).toEqual({ meeting: scheduledMeeting, etag: 'opaque;v=8' })
    expect(() =>
      parseCreateMeetingResponse({
        data: { ...meeting, status: 'SCHEDULED' },
        meta: {},
        etag: 'W/"m-7"',
      })
    ).toThrowError(/malformed/i)
    expect(() =>
      parseScheduleMeetingResponse({ data: scheduledMeeting, meta: {} })
    ).toThrowError(CoreApiError)
  })

  it('parses advisory room and participant warnings without treating them as failures', () => {
    const result = parseScheduleCheckResponse({
      data: {
        previewOnly: true,
        canSchedule: true,
        roomConflict: false,
        room: {
          roomId: 'room-1',
          active: true,
          available: true,
          capacity: 1,
          participantCount: 2,
          capacityExceeded: true,
        },
        warnings: [
          { code: 'CAPACITY_ADVISORY_EXCEEDED', userId: null },
          { code: 'PARTICIPANT_OVERLAP', userId: 'user-1' },
        ],
      },
      meta: {},
    })

    expect(result.canSchedule).toBe(true)
    expect(result.room?.capacityExceeded).toBe(true)
    expect(result.warnings[1]).toEqual({
      code: 'PARTICIPANT_OVERLAP',
      userId: 'user-1',
    })
  })

  it('calls create, preview, and schedule with their required headers and endpoints', async () => {
    const mutationSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    mutationSpy
      .mockResolvedValueOnce({ data: meeting, meta: {}, etag: 'create-etag' })
      .mockResolvedValueOnce({
        data: scheduledMeeting,
        meta: {},
        etag: 'schedule-etag',
      })
    const previewSpy = vi.spyOn(coreApi, 'post').mockResolvedValue({
      previewOnly: true,
      canSchedule: true,
      roomConflict: false,
      room: null,
      warnings: [],
    })

    await expect(
      createMeeting({ title: 'Roadmap' }, 'intent-1')
    ).resolves.toEqual({ meeting, etag: 'create-etag' })
    await expect(
      checkMeetingSchedule({
        start: '2026-09-01T02:00:00.000Z',
        end: '2026-09-01T03:00:00.000Z',
      })
    ).resolves.toMatchObject({ canSchedule: true })
    await expect(
      scheduleMeeting('meeting-1', 'create-etag', {
        scheduledStartAt: meeting.scheduledStartAt!,
        scheduledEndAt: meeting.scheduledEndAt!,
      })
    ).resolves.toEqual({ meeting: scheduledMeeting, etag: 'schedule-etag' })

    expect(mutationSpy).toHaveBeenNthCalledWith(
      1,
      '/meetings',
      { title: 'Roadmap' },
      { headers: { 'Idempotency-Key': 'intent-1' } }
    )
    expect(previewSpy).toHaveBeenCalledWith(
      '/meeting-schedule-checks',
      {
        start: '2026-09-01T02:00:00.000Z',
        end: '2026-09-01T03:00:00.000Z',
      },
      undefined
    )
    expect(mutationSpy).toHaveBeenNthCalledWith(
      2,
      '/meetings/meeting-1/schedule',
      {
        scheduledStartAt: meeting.scheduledStartAt,
        scheduledEndAt: meeting.scheduledEndAt,
      },
      { headers: { 'If-Match': 'create-etag' } }
    )
  })

  it('classifies recoverable backend outcomes and maps API fields to form fields', () => {
    expect(
      classifyMeetingMutationError(
        new CoreApiError({ status: 409, message: 'Conflict', kind: 'http' })
      )
    ).toBe('conflict')
    expect(
      classifyMeetingMutationError(
        new CoreApiError({ status: 412, message: 'Stale', kind: 'http' })
      )
    ).toBe('precondition')
    expect(
      mapMeetingFieldErrors({
        scheduledStartAt: ['Start is invalid'],
        scheduledEndAt: ['End is invalid'],
        roomId: ['Room is unavailable'],
        participantUserIds: ['Select active participants'],
      })
    ).toEqual({
      startTime: ['Start is invalid'],
      endTime: ['End is invalid'],
      roomId: ['Room is unavailable'],
      participantIds: ['Select active participants'],
    })
  })
})
