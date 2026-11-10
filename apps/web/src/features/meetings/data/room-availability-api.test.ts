import { describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  fetchRoomAvailability,
  parseRoomAvailabilityResponse,
  roomAvailabilityQueryOptions,
  serializeRoomAvailabilityQuery,
} from './room-availability-api'

const pagination = {
  page: 0,
  size: 20,
  totalElements: 1,
  totalPages: 1,
  hasNext: false,
  hasPrevious: false,
}

const room = {
  id: 'room-1',
  code: 'BOARD-1',
  name: 'Boardroom',
  location: 'HQ',
  capacity: 8,
  available: true,
  participantCount: 3,
  capacityExceeded: false,
}

describe('room availability API adapter', () => {
  it('serializes valid interval, filters, and zero-based pagination', () => {
    expect(
      serializeRoomAvailabilityQuery({
        start: '2026-09-01T02:00:00.000Z',
        end: '2026-09-01T03:00:00.000Z',
        q: '  board  ',
        minCapacity: 4,
        participantCount: 3,
        availableOnly: true,
        page: 2,
        pageSize: 50,
      })
    ).toEqual({
      start: '2026-09-01T02:00:00.000Z',
      end: '2026-09-01T03:00:00.000Z',
      q: 'board',
      minCapacity: '4',
      participantCount: '3',
      availableOnly: 'true',
      page: '1',
      size: '50',
    })
  })

  it('validates capacity and advisory availability signals', () => {
    expect(
      parseRoomAvailabilityResponse({
        data: [room],
        meta: { pagination },
      })
    ).toEqual({ rooms: [room], pagination })
    expect(() =>
      parseRoomAvailabilityResponse({
        data: [{ ...room, available: 'yes' }],
        meta: {},
      })
    ).toThrowError(CoreApiError)
  })

  it('uses the authorized availability endpoint and a stable query key', async () => {
    const spy = vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
      data: [room],
      meta: { pagination },
    })
    const options = roomAvailabilityQueryOptions({
      start: '2026-09-01T02:00:00.000Z',
      end: '2026-09-01T03:00:00.000Z',
      participantCount: 1,
    })

    expect(options.queryKey[0]).toBe('rooms')
    expect(options.queryKey[1]).toBe('availability')
    expect(options.retry).toBe(false)
    await options.queryFn?.({
      client: {} as never,
      queryKey: options.queryKey,
      signal: new AbortController().signal,
      meta: undefined,
    })
    expect(spy).toHaveBeenCalledWith('/rooms/availability', {
      params: {
        start: '2026-09-01T02:00:00.000Z',
        end: '2026-09-01T03:00:00.000Z',
        participantCount: '1',
        availableOnly: 'false',
        page: '0',
        size: '20',
      },
      signal: expect.any(AbortSignal),
    })
    await fetchRoomAvailability({
      start: '2026-09-01T02:00:00.000Z',
      end: '2026-09-01T03:00:00.000Z',
    })
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
