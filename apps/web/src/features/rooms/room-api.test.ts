import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  classifyRoomMutationOutcome,
  deactivateRoom,
  fetchRoomDirectory,
  parseRoomDetailResponse,
  parseRoomListResponse,
  reconcileRoomCreation,
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

function pageResponse(
  items: unknown[],
  page: number,
  size: number,
  totalElements: number
) {
  const totalPages = Math.ceil(totalElements / size)
  return {
    data: items,
    meta: {
      pagination: {
        page,
        size,
        totalElements,
        totalPages,
        hasNext: page + 1 < totalPages,
        hasPrevious: page > 0,
      },
    },
  }
}

function candidate(index: number) {
  return {
    ...room,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    code: `BOARD-${index}`,
    name: `Boardroom ${index}`,
  }
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

  it('reconciles creation through every catalog page and compares canonical metadata', async () => {
    const matching = {
      ...room,
      id: '33333333-3333-4333-8333-333333333333',
      code: 'BOARD-1',
      name: ' Boardroom ',
      location: 'HQ',
      notes: null,
    }
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      candidate(index + 10)
    )
    const getSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (_url, config) => {
        if (config?.params?.page === 0) {
          return pageResponse(firstPage, 0, 100, 101) as never
        }
        if (config?.params?.page === 1) {
          return pageResponse([matching], 1, 100, 101) as never
        }
        throw new Error('Unexpected page')
      })

    await expect(
      reconcileRoomCreation(
        {
          code: ' board-1 ',
          name: 'Boardroom',
          location: ' HQ ',
          capacity: 8,
          notes: ' ',
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({
      status: 'found',
      room: { code: 'BOARD-1' },
      metadataMatches: true,
    })
    expect(getSpy).toHaveBeenCalledTimes(2)
    expect(getSpy).toHaveBeenNthCalledWith(1, '/rooms', {
      params: { q: 'BOARD-1', page: 0, size: 100, sort: 'code,asc' },
      signal: expect.any(AbortSignal),
    })
    expect(getSpy).toHaveBeenNthCalledWith(2, '/rooms', {
      params: { q: 'BOARD-1', page: 1, size: 100, sort: 'code,asc' },
      signal: expect.any(AbortSignal),
    })
  })

  it('distinguishes a conflicting same-code resource from a missing exact code', async () => {
    const conflicting = { ...room, name: 'A different boardroom' }
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValueOnce(
      pageResponse([conflicting], 0, 100, 1) as never
    )
    await expect(
      reconcileRoomCreation({
        code: 'BOARD-1',
        name: 'Boardroom',
        location: 'HQ',
        capacity: 8,
        notes: null,
      })
    ).resolves.toMatchObject({
      status: 'found',
      metadataMatches: false,
      room: conflicting,
    })

    const getSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValueOnce(pageResponse([candidate(2)], 0, 100, 1) as never)
    await expect(
      reconcileRoomCreation({
        code: 'BOARD-1',
        name: 'Boardroom',
        location: 'HQ',
        capacity: 8,
        notes: null,
      })
    ).resolves.toEqual({ status: 'not-found' })
    expect(getSpy).toHaveBeenCalledWith('/rooms', {
      params: { q: 'BOARD-1', page: 0, size: 100, sort: 'code,asc' },
      signal: undefined,
    })
  })

  it('leaves creation inconclusive when an authoritative catalog page fails', async () => {
    const getSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValueOnce(
        pageResponse(
          Array.from({ length: 100 }, (_, i) => candidate(i)),
          0,
          100,
          101
        ) as never
      )
      .mockRejectedValueOnce(new Error('catalog unavailable'))

    await expect(
      reconcileRoomCreation({
        code: 'BOARD-1',
        name: 'Boardroom',
        location: null,
        capacity: null,
        notes: null,
      })
    ).rejects.toThrow('catalog unavailable')
    expect(getSpy).toHaveBeenCalledTimes(2)
  })
})
