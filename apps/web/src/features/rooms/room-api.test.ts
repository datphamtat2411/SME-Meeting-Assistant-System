import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  classifyRoomMutationOutcome,
  deactivateRoom,
  fetchRoomDirectory,
  parseRoomDetailResponse,
  parseRoomListResponse,
  serializeRoomDirectoryParams,
  updateRoom,
} from './room-api'

const roomId = '11111111-1111-4111-8111-111111111111'
const room = {
  id: roomId,
  code: 'BOARD-1',
  name: 'Boardroom',
  location: 'HQ',
  capacity: 8,
  status: 'ACTIVE',
  notes: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
}
const pagination = {
  page: 0,
  size: 20,
  totalElements: 1,
  totalPages: 1,
  hasNext: false,
  hasPrevious: false,
}
describe('room API contracts', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('serializes only supported search, lifecycle, page, size, and sort criteria', () => {
    expect(
      serializeRoomDirectoryParams({
        q: 'Board',
        status: 'INACTIVE',
        page: 2,
        size: 50,
        sort: 'capacity,desc',
      })
    ).toEqual({
      q: 'Board',
      status: 'INACTIVE',
      page: 2,
      size: 50,
      sort: 'capacity,desc',
    })
  })

  it('validates list and detail contracts, including page metadata and opaque ETags', () => {
    expect(
      parseRoomListResponse({ data: [room], meta: { pagination } }, 0, 20)
    ).toMatchObject({ items: [room], pagination, outOfRange: false })
    expect(() =>
      parseRoomListResponse(
        {
          data: [room],
          meta: { pagination: { ...pagination, totalPages: 3 } },
        },
        0,
        20
      )
    ).toThrow(/malformed/i)
    expect(
      parseRoomDetailResponse(
        { data: room, meta: {}, etag: 'opaque;v=8' },
        roomId
      )
    ).toEqual({ room, etag: 'opaque;v=8' })
    expect(() =>
      parseRoomDetailResponse({ data: room, meta: {}, etag: ' ' }, roomId)
    ).toThrow(/malformed/i)
  })

  it('sends server-side directory criteria and forwards cancellation', async () => {
    const signal = new AbortController().signal
    const getSpy = vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
      data: [room],
      meta: { pagination },
    })
    await fetchRoomDirectory(
      { q: 'Board', status: 'ACTIVE', page: 0, size: 20, sort: 'name,asc' },
      signal
    )
    expect(getSpy).toHaveBeenCalledWith('/rooms', {
      params: {
        q: 'Board',
        status: 'ACTIVE',
        page: 0,
        size: 20,
        sort: 'name,asc',
      },
      signal,
    })
  })

  it('requires and submits the reviewed ETag for edits and deactivation', async () => {
    const patchSpy = vi
      .spyOn(coreApi, 'patchWithMetaAndEtag')
      .mockResolvedValue({
        data: { ...room, name: 'Updated' },
        meta: {},
        etag: 'new-version',
      })
    await updateRoom(roomId, { name: 'Updated' }, 'opaque-original')
    expect(patchSpy).toHaveBeenCalledWith(
      `/rooms/${roomId}`,
      { name: 'Updated' },
      { headers: { 'If-Match': 'opaque-original' } }
    )
    await expect(updateRoom(roomId, { name: 'Updated' }, '')).rejects.toThrow(
      /etag/i
    )
    expect(patchSpy).toHaveBeenCalledTimes(1)

    const postSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockResolvedValue({
      data: { ...room, status: 'INACTIVE' },
      meta: {},
      etag: 'inactive-version',
    })
    await deactivateRoom(roomId, 'opaque-confirmed')
    expect(postSpy).toHaveBeenCalledWith(
      `/rooms/${roomId}/deactivate`,
      undefined,
      { headers: { 'If-Match': 'opaque-confirmed' } }
    )
  })

  it('treats unknown mutation responses as uncertain, not safe-to-retry rejections', () => {
    expect(
      classifyRoomMutationOutcome(
        new Error('Unrecognized mutation transport failure')
      )
    ).toBe('uncertain')
    expect(
      classifyRoomMutationOutcome(
        new CoreApiError({
          status: 418,
          message: 'Unexpected HTTP response',
          kind: 'http',
        })
      )
    ).toBe('unknown')
  })
})
