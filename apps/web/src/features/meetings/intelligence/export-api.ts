import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi, normalizeCoreApiError } from '@/lib/core-api'

const instant = z.string().datetime({ offset: true })

export const exportStatusSchema = z.object({
  exportId: z.string().uuid(),
  meetingId: z.string().uuid(),
  format: z.enum(['PDF', 'MARKDOWN']),
  status: z.enum(['PENDING', 'GENERATING', 'READY', 'FAILED']),
  attemptCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: instant,
  readyAt: instant.nullable(),
  safeErrorCode: z.string().nullable(),
  freshness: z.enum(['CURRENT', 'STALE', 'NOT_APPLICABLE', 'UNKNOWN']),
  freshnessCheckedAt: instant.nullable(),
})
export type ExportStatus = z.infer<typeof exportStatusSchema>

function malformedExportResponse(message: string, cause?: unknown) {
  return new CoreApiError({
    message,
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause,
  })
}

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
const exportRecoverySchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('RECOVERED'),
    admission: exportAdmissionSchema,
  }),
  z.object({
    outcome: z.literal('UNAVAILABLE'),
    admission: z.null().optional(),
  }),
])

export async function recoverMinutesExport(
  meetingId: string,
  format: ExportStatus['format'],
  idempotencyKey: string
): Promise<ExportAdmission | null> {
  const result = exportRecoverySchema.safeParse(
    await coreApi.post<unknown>(
      '/meetings/' + encodeURIComponent(meetingId) + '/exports/recover',
      { format },
      { headers: { 'Idempotency-Key': idempotencyKey } }
    )
  )
  if (!result.success) {
    throw malformedExportResponse(
      'Export recovery response could not be verified.',
      result.error
    )
  }
  if (result.data.outcome === 'UNAVAILABLE') return null
  const admission = result.data.admission
  if (admission.meetingId !== meetingId || admission.format !== format) {
    throw malformedExportResponse(
      'Export recovery response belongs to a different intent.'
    )
  }
  return admission
}

const exportCapabilitiesSchema = z.object({
  meetingId: z.string().uuid(),
  admission: z.boolean(),
  recovery: z.boolean(),
  status: z.boolean(),
  access: z.boolean(),
})

export function exportCapabilitiesQuery(meetingId: string, scope: string) {
  return queryOptions({
    queryKey: ['export', 'capabilities', meetingId, scope],
    queryFn: async ({ signal }) => {
      const result = exportCapabilitiesSchema.safeParse(
        await coreApi.get<unknown>(
          '/meetings/' +
            encodeURIComponent(meetingId) +
            '/exports/capabilities',
          { signal }
        )
      )
      if (!result.success || result.data.meetingId !== meetingId) {
        throw malformedExportResponse(
          'Export service availability could not be verified.'
        )
      }
      return result.data
    },
    meta: { featureErrorBoundary: true },
    retry: false,
  })
}

export function parseExportStatus(
  value: unknown,
  expected?: {
    exportId?: string
    meetingId?: string
    format?: ExportStatus['format']
  }
): ExportStatus {
  const parsed = exportStatusSchema.safeParse(value)
  if (!parsed.success) {
    throw malformedExportResponse(
      'Core API returned a malformed export status response.',
      parsed.error
    )
  }
  if (expected?.exportId && parsed.data.exportId !== expected.exportId) {
    throw malformedExportResponse(
      'Core API returned the status of a different export.'
    )
  }
  if (expected?.meetingId && parsed.data.meetingId !== expected.meetingId) {
    throw malformedExportResponse(
      'Core API returned export status for a different meeting.'
    )
  }
  if (expected?.format && parsed.data.format !== expected.format) {
    throw malformedExportResponse(
      'Core API returned export status for a different format.'
    )
  }
  const { status, readyAt, freshness, freshnessCheckedAt } = parsed.data
  if (
    (status === 'READY' &&
      (readyAt === null || freshness === 'NOT_APPLICABLE')) ||
    (status !== 'READY' &&
      (freshness !== 'NOT_APPLICABLE' || freshnessCheckedAt !== null)) ||
    ((freshness === 'CURRENT' || freshness === 'STALE') &&
      freshnessCheckedAt === null)
  ) {
    throw malformedExportResponse(
      'Core API returned inconsistent export status and freshness.'
    )
  }
  return parsed.data
}

export async function fetchExportStatus(
  exportId: string,
  expected?: {
    meetingId?: string
    format?: ExportStatus['format']
  },
  signal?: AbortSignal
) {
  return parseExportStatus(
    await coreApi.get<unknown>('/exports/' + encodeURIComponent(exportId), {
      signal,
    }),
    { exportId, ...expected }
  )
}

export function exportStatusQuery(
  exportId: string,
  expected?: {
    meetingId?: string
    format?: ExportStatus['format']
    scope?: string
  }
) {
  const meetingId = expected?.meetingId
  const format = expected?.format
  const scope = expected?.scope
  return queryOptions({
    queryKey: ['export', exportId, meetingId, format, scope],
    queryFn: ({ signal }) =>
      fetchExportStatus(exportId, { meetingId, format }, signal),
    meta: { featureErrorBoundary: true },
    retry: false,
  })
}
export async function accessMinutesExport(exportId: string) {
  const schema = z.object({
    exportId: z.string().uuid(),
    accessUrl: z.string().url(),
    filename: z.string().min(1).max(160),
    contentType: z.string(),
    expiresAt: z.string().datetime({ offset: true }),
    freshness: z.enum(['CURRENT', 'STALE', 'NOT_APPLICABLE', 'UNKNOWN']),
    freshnessCheckedAt: z.string().datetime({ offset: true }),
  })
  const parsed = schema.safeParse(
    await coreApi.post<unknown>(
      '/exports/' + encodeURIComponent(exportId) + '/access-url'
    )
  )
  if (!parsed.success) {
    throw malformedExportResponse(
      'Core API returned a malformed export download capability.',
      parsed.error
    )
  }
  if (parsed.data.exportId !== exportId) {
    throw malformedExportResponse(
      'Core API returned a download capability for a different export.'
    )
  }
  return parsed.data
}
