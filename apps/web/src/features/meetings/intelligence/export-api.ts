import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { coreApi } from '@/lib/core-api'

export const exportStatusSchema = z.object({
  exportId: z.string().uuid(), meetingId: z.string().uuid(),
  format: z.enum(['PDF', 'MARKDOWN']), status: z.enum(['PENDING', 'GENERATING', 'READY', 'FAILED']),
  attemptCount: z.number(), createdAt: z.string(), readyAt: z.string().nullable(),
  safeErrorCode: z.string().nullable(),
  freshness: z.enum(['CURRENT', 'STALE', 'NOT_APPLICABLE', 'UNKNOWN']),
  freshnessCheckedAt: z.string().nullable(),
})
export type ExportStatus = z.infer<typeof exportStatusSchema>
export function createMinutesExport(meetingId: string, format: ExportStatus['format']) {
  return z.object({ exportId: z.string().uuid() }).parseAsync(coreApi.post<unknown>(
    '/meetings/' + encodeURIComponent(meetingId) + '/exports',
    { format }, { headers: { 'Idempotency-Key': crypto.randomUUID() } }))
}
export function exportStatusQuery(exportId: string) {
  return queryOptions({
    queryKey: ['export', exportId],
    queryFn: async ({ signal }) => exportStatusSchema.parse(await coreApi.get<unknown>('/exports/' + encodeURIComponent(exportId), { signal })),
    retry: false,
  })
}
export async function accessMinutesExport(exportId: string) {
  return z.object({
    exportId: z.string().uuid(), accessUrl: z.string().url(),
    filename: z.string(), contentType: z.string(), expiresAt: z.string(),
    freshness: z.enum(['CURRENT', 'STALE', 'NOT_APPLICABLE', 'UNKNOWN']),
  }).parse(await coreApi.post<unknown>('/exports/' + encodeURIComponent(exportId) + '/access-url'))
}
