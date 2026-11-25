import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi, normalizeCoreApiError } from '@/lib/core-api'

export const exportStatusSchema = z.object({
  exportId: z.string().uuid(),
  meetingId: z.string().uuid(),
  format: z.enum(['PDF', 'MARKDOWN']),
  status: z.enum(['PENDING', 'GENERATING', 'READY', 'FAILED']),
  attemptCount: z.number(),
  createdAt: z.string(),
  readyAt: z.string().nullable(),
  safeErrorCode: z.string().nullable(),
  freshness: z.enum(['CURRENT', 'STALE', 'NOT_APPLICABLE', 'UNKNOWN']),
  freshnessCheckedAt: z.string().nullable(),
})
export type ExportStatus = z.infer<typeof exportStatusSchema>

const exportAdmissionSchema = z.object({
  exportId: z.string().uuid(),
  meetingId: z.string().uuid(),
  format: z.enum(['PDF', 'MARKDOWN']),
  status: exportStatusSchema.shape.status,
  createdAt: z.string().datetime({ offset: true }),
})
export type ExportAdmission = z.infer<typeof exportAdmissionSchema>

export async function createMinutesExport(
  meetingId: string,
  format: ExportStatus['format'],
  idempotencyKey: string
) {
  try {
    const value = await coreApi.post<unknown>(
      '/meetings/' + encodeURIComponent(meetingId) + '/exports',
      { format },
      { headers: { 'Idempotency-Key': idempotencyKey } }
    )
    const receipt = exportAdmissionSchema.safeParse(value)
    if (
      !receipt.success ||
      receipt.data.meetingId !== meetingId ||
      receipt.data.format !== format
    ) {
      throw new CoreApiError({
        message: 'Export admission response could not be verified.',
        code: 'MALFORMED_RESPONSE',
        kind: 'malformed',
      })
    }
    return receipt.data
  } catch (error) {
    const failure = normalizeCoreApiError(error)
    if (
      failure.isNetworkError ||
      failure.isServerError ||
      failure.kind === 'malformed' ||
      failure.recoveryOutcome === 'uncertain'
    ) {
      throw new CoreApiError({
        message: 'Export admission is uncertain. Recover the original request.',
        code: 'EXPORT_ADMISSION_UNCERTAIN',
        kind: failure.kind,
        recoveryOutcome: 'uncertain',
        cause: error,
      })
    }
    throw error
  }
}
export function exportStatusQuery(exportId: string) {
  return queryOptions({
    queryKey: ['export', exportId],
    queryFn: async ({ signal }) =>
      exportStatusSchema.parse(
        await coreApi.get<unknown>('/exports/' + encodeURIComponent(exportId), {
          signal,
        })
      ),
    retry: false,
  })
}
export async function accessMinutesExport(exportId: string) {
  return z
    .object({
      exportId: z.string().uuid(),
      accessUrl: z.string().url(),
      filename: z.string().min(1).max(160),
      contentType: z.string(),
      expiresAt: z.string().datetime({ offset: true }),
      freshness: z.enum(['CURRENT', 'STALE', 'NOT_APPLICABLE', 'UNKNOWN']),
      freshnessCheckedAt: z.string().datetime({ offset: true }),
    })
    .parse(
      await coreApi.post<unknown>(
        '/exports/' + encodeURIComponent(exportId) + '/access-url'
      )
    )
}
