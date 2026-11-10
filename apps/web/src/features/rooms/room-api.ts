import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { coreApi } from '@/lib/core-api'
import { pageInfo, paginationParams } from '@/lib/list-pagination'

export const roomSchema = z.object({
  id: z.string().uuid(), code: z.string(), name: z.string(), location: z.string().nullable(),
  capacity: z.number().int().nullable(), status: z.enum(['ACTIVE', 'INACTIVE']),
  notes: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
})
export type Room = z.infer<typeof roomSchema>
export interface RoomInput { code: string; name: string; location?: string | null; capacity?: number | null; notes?: string | null }

export function roomsQuery(page: number, q: string) {
  return queryOptions({
    queryKey: ['rooms', 'directory', page, q],
    queryFn: async ({ signal }) => {
      const response = await coreApi.getWithMeta<unknown>('/rooms', {
        params: { ...paginationParams(page), q, sort: 'code,asc' }, signal,
      })
      return { items: z.array(roomSchema).parse(response.data), page: pageInfo(response.meta.pagination) }
    },
    retry: false,
  })
}

export async function roomDetail(id: string) {
  const result = await coreApi.getWithMetaAndEtag<unknown>('/rooms/' + encodeURIComponent(id))
  return { room: roomSchema.parse(result.data), etag: result.etag }
}
export function createRoom(input: RoomInput) {
  return coreApi.post<Room>('/rooms', input)
}
export function updateRoom(id: string, input: Partial<RoomInput>, etag?: string) {
  return coreApi.patch<Room>('/rooms/' + encodeURIComponent(id), input, { headers: etag ? { 'If-Match': etag } : {} })
}
export function deactivateRoom(id: string, etag?: string) {
  return coreApi.post<Room>('/rooms/' + encodeURIComponent(id) + '/deactivate', undefined, { headers: etag ? { 'If-Match': etag } : {} })
}
