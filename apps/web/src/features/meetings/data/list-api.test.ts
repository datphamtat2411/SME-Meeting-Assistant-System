import { describe, expect, it } from 'vitest'
import {
  getMeetingDisplay,
  meetingLifecycleStatuses,
  parseOrganizerFilterOptionsResponse,
  parseRoomFilterOptionsResponse,
  parseMeetingListResponse,
  serializeFilterOptionsQuery,
  serializeMeetingListQuery,
} from './list-api'

describe('meeting list API adapter', () => {
  it('uses canonical lifecycle values and serializes server-side discovery state', () => {
    expect(meetingLifecycleStatuses).toEqual([
      'DRAFT',
      'SCHEDULED',
      'IN_PROGRESS',
      'ENDED',
      'CANCELLED',
    ])

    expect(
      serializeMeetingListQuery({
        q: '  roadmap  ',
        status: 'IN_PROGRESS',
        relationship: 'PARTICIPANT',
        from: '2026-09-01T00:00:00+07:00',
        to: 'not-an-offset-date',
        roomId: 'room-1',
        organizerId: 'organizer-1',
        sort: 'title,asc',
        page: 3,
        pageSize: 25,
      })
    ).toEqual({
      q: 'roadmap',
      status: 'IN_PROGRESS',
      relationship: 'PARTICIPANT',
      from: '2026-09-01T00:00:00+07:00',
      roomId: 'room-1',
      organizerId: 'organizer-1',
      page: '2',
      size: '25',
      sort: 'title,asc',
    })
  })

  it('validates pagination and preserves approved projection nulls', () => {
    const result = parseMeetingListResponse({
      data: [
        {
          id: 'meeting-1',
          title: 'Roadmap',
          description: null,
          organizerUserId: 'organizer-1',
          roomId: null,
          scheduledStartAt: null,
          scheduledEndAt: null,
          status: 'DRAFT',
          createdAt: '2026-09-01T00:00:00Z',
          display: {
            organizerName: null,
            roomName: null,
            roomLocation: null,
            participantCount: 0,
            participantPreview: [],
          },
        },
      ],
      meta: {
        pagination: {
          page: 0,
          size: 10,
          totalElements: 1,
          totalPages: 1,
          hasNext: false,
          hasPrevious: false,
        },
      },
    })

    expect(result.pagination.totalElements).toBe(1)
    expect(getMeetingDisplay(result.meetings[0])).toEqual({
      organizerName: null,
      roomName: null,
      roomLocation: null,
      participantCount: 0,
      participantPreview: [],
    })
  })

  it('rejects malformed pagination instead of manufacturing totals', () => {
    expect(() =>
      parseMeetingListResponse({
        data: [],
        meta: { pagination: { page: 0, totalElements: 0 } },
      })
    ).toThrowError(/malformed/i)
  })

  it('rejects a list item without the authoritative display projection', () => {
    expect(() =>
      parseMeetingListResponse({
        data: [{ id: 'meeting-1', title: 'Roadmap', status: 'DRAFT' }],
        meta: {
          pagination: {
            page: 0,
            size: 10,
            totalElements: 1,
            totalPages: 1,
            hasNext: false,
            hasPrevious: false,
          },
        },
      })
    ).toThrowError(/malformed/i)
  })

  it('serializes bounded server-side lookup pagination and search', () => {
    expect(
      serializeFilterOptionsQuery({ q: '  room  ', page: 3, pageSize: 20 })
    ).toEqual({ q: 'room', page: '2', size: '20' })
  })

  it('parses paginated room and organizer lookup responses', () => {
    const meta = {
      pagination: {
        page: 0,
        size: 20,
        totalElements: 1,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
      },
    }

    expect(
      parseRoomFilterOptionsResponse({
        data: [{ id: 'room-1', name: 'Boardroom', location: 'HQ' }],
        meta,
      })
    ).toEqual({
      options: [{ id: 'room-1', name: 'Boardroom', location: 'HQ' }],
      pagination: meta.pagination,
    })
    expect(
      parseOrganizerFilterOptionsResponse({
        data: [{ id: 'organizer-1', name: 'Lan Nguyen' }],
        meta,
      })
    ).toEqual({
      options: [{ id: 'organizer-1', name: 'Lan Nguyen' }],
      pagination: meta.pagination,
    })
  })

  it('rejects unpaginated filter option responses', () => {
    expect(() =>
      parseRoomFilterOptionsResponse({
        data: [{ id: 'room-1', name: 'Boardroom' }],
      })
    ).toThrowError(/malformed/i)
  })
})
