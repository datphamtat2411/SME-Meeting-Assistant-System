import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi } from '@/lib/core-api'

const summarySchema = z.object({
  availability: z.string(),
  id: z.string().uuid().nullable(),
  versionNumber: z.number().int().nullable(),
  content: z.string().nullable(),
  sourceType: z.string().nullable(),
  qualityStatus: z.string().nullable(),
  transcriptId: z.string().uuid().nullable(),
  contentRevision: z.number().int().nonnegative().nullable(),
  selectionEpoch: z.number().int().nonnegative(),
  isStale: z.boolean(),
  aiWarnings: z.array(z.string()),
})

const actionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    details: z.string().nullable().optional(),
    status: z.string(),
    sourceType: z.string(),
    assigneeUserId: z.string().uuid().nullable(),
    dueDate: z.string().nullable(),
    version: z.number().int().nonnegative().optional(),
    createdAt: z.string().optional(),
    confirmedByUserId: z.string().uuid().nullable().optional(),
    confirmedAt: z.string().nullable().optional(),
  })
  .passthrough()

const decisionSchema = z
  .object({
    id: z.string().uuid(),
    content: z.string(),
    status: z.string(),
    sourceType: z.string(),
    version: z.number().int().nonnegative(),
    transcriptId: z.string().uuid().nullable().optional(),
    contentRevision: z.number().int().nonnegative().nullable().optional(),
    confirmedByUserId: z.string().uuid().nullable().optional(),
    evidenceSegmentIds: z.array(z.string().uuid()).default([]),
    isStale: z.boolean().default(false),
    aiWarnings: z.array(z.string()).default([]),
  })
  .passthrough()

export const minutesSchema = z
  .object({
    schemaVersion: z.number().int(),
    assembledAt: z.string(),
    sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/i),
    completeness: z.enum(['COMPLETE', 'PARTIAL', 'NEEDS_REVIEW']),
    proposalsIncluded: z.boolean(),
    warnings: z.array(z.string()),
    meeting: z.object({
      id: z.string().uuid(),
      title: z.string(),
      description: z.string().nullable(),
      organizerUserId: z.string().uuid(),
      status: z.string(),
      scheduledStartAt: z.string().nullable(),
      scheduledEndAt: z.string().nullable(),
      startedAt: z.string().nullable(),
      endedAt: z.string().nullable(),
    }),
    summary: summarySchema,
    confirmedDecisions: z.array(decisionSchema),
    officialActionItems: z.array(actionSchema),
    transcript: z
      .object({
        availability: z.string(),
        id: z.string().uuid().nullable(),
        processingJobId: z.string().uuid().nullable().optional(),
        versionNumber: z.number().nullable(),
        languageCode: z.string().nullable().optional(),
        status: z.string().nullable(),
        contentRevision: z.number().int().nonnegative().nullable().optional(),
        durationMs: z.number().nonnegative().nullable().optional(),
        suspiciousSegments: z.number().int().nonnegative().optional(),
        unresolvedSegments: z.number(),
        unresolvedCoverageRegions: z.number(),
      })
      .passthrough(),
  })
  .passthrough()
  .superRefine((minutes, context) => {
    for (const decision of minutes.confirmedDecisions) {
      if (decision.status !== 'CONFIRMED') {
        context.addIssue({
          code: 'custom',
          path: ['confirmedDecisions'],
          message: 'Canonical Minutes contain an unconfirmed Decision.',
        })
      }
    }
    for (const item of minutes.officialActionItems) {
      if (
        item.status === 'PROPOSED' ||
        (item.sourceType !== 'MANUAL' && item.confirmedByUserId == null)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['officialActionItems'],
          message: 'Canonical Minutes contain an unconfirmed Action Item.',
        })
      }
    }
  })
export type MeetingMinutes = z.infer<typeof minutesSchema>

export function parseMinutes(value: unknown): MeetingMinutes {
  const parsed = minutesSchema.safeParse(value)
  if (!parsed.success) {
    throw new CoreApiError({
      message: 'Core API returned an invalid canonical Minutes snapshot.',
      code: 'MALFORMED_MINUTES_SNAPSHOT',
      kind: 'malformed',
      cause: parsed.error,
    })
  }
  return parsed.data
}

export function minutesQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['minutes', meetingId],
    queryFn: async ({ signal }) =>
      parseMinutes(
        await coreApi.get<unknown>(
          '/meetings/' + encodeURIComponent(meetingId) + '/minutes',
          { signal }
        )
      ),
    retry: false,
  })
}
