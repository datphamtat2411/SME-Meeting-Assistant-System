import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  isValidOffsetDateTime,
  meetingLifecycleStatuses,
} from '../data/list-api'

const instant = z.string().refine(isValidOffsetDateTime)
const revision = z.number().int().nonnegative()
const count = revision.max(Number.MAX_SAFE_INTEGER)

const summarySchema = z.object({
  availability: z.enum(['AVAILABLE', 'NOT_AVAILABLE', 'NEEDS_REVIEW']),
  id: z.string().uuid().nullable(),
  versionNumber: revision.nullable(),
  content: z.string().nullable(),
  sourceType: z.enum(['AI_GENERATED', 'HUMAN_EDIT']).nullable(),
  qualityStatus: z.enum(['READY', 'READY_WITH_WARNINGS']).nullable(),
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
    details: z.string().nullable(),
    status: z.enum(['PROPOSED', 'OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']),
    sourceType: z.enum(['AI_EXTRACTED', 'MANUAL']),
    assigneeUserId: z.string().uuid().nullable(),
    dueDate: z.iso.date().nullable(),
    version: revision,
    createdAt: instant,
    confirmedByUserId: z.string().uuid().nullable(),
    confirmedAt: instant.nullable(),
  })
  .passthrough()

const decisionSchema = z
  .object({
    id: z.string().uuid(),
    content: z.string(),
    status: z.literal('CONFIRMED'),
    sourceType: z.enum(['AI_EXTRACTED', 'MANUAL']),
    version: z.number().int().nonnegative(),
    transcriptId: z.string().uuid().nullable(),
    contentRevision: revision.nullable(),
    confirmedByUserId: z.string().uuid().nullable(),
    evidenceSegmentIds: z.array(z.string().uuid()),
    isStale: z.boolean(),
    aiWarnings: z.array(z.string()),
    aiUncertainty: z.string().nullable(),
    confirmedAt: instant.nullable(),
  })
  .passthrough()

export const minutesSchema = z
  .object({
    schemaVersion: z.literal(1),
    assembledAt: instant,
    sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/i),
    completeness: z.enum(['COMPLETE', 'PARTIAL', 'NEEDS_REVIEW']),
    proposalsIncluded: z.literal(false),
    warnings: z.array(z.string()),
    meeting: z.object({
      id: z.string().uuid(),
      title: z.string(),
      description: z.string().nullable(),
      organizerUserId: z.string().uuid(),
      status: z.enum(meetingLifecycleStatuses),
      scheduledStartAt: instant.nullable(),
      scheduledEndAt: instant.nullable(),
      startedAt: instant.nullable(),
      endedAt: instant.nullable(),
    }),
    summary: summarySchema,
    confirmedDecisions: z.array(decisionSchema),
    officialActionItems: z.array(actionSchema),
    transcript: z
      .object({
        availability: z.enum([
          'AVAILABLE',
          'NOT_AVAILABLE',
          'PROCESSING',
          'FAILED',
          'NEEDS_REVIEW',
        ]),
        id: z.string().uuid().nullable(),
        processingJobId: z.string().uuid().nullable(),
        versionNumber: revision.nullable(),
        languageCode: z.string().nullable(),
        status: z
          .enum(['PROCESSING', 'READY', 'READY_WITH_WARNINGS', 'FAILED'])
          .nullable(),
        contentRevision: revision.nullable(),
        durationMs: count.nullable(),
        suspiciousSegments: count,
        unresolvedSegments: count,
        unresolvedCoverageRegions: count,
      })
      .passthrough(),
    displayMetadata: z
      .object({
        assigneeDisplayNames: z.record(
          z.string().uuid(),
          z.string().trim().min(1)
        ),
      })
      .default({ assigneeDisplayNames: {} }),
  })
  .passthrough()
  .superRefine((minutes, context) => {
    // Validate structural guarantees of the server projection. Do not
    // recompute completeness or replace the server's review classification.
    if (
      minutes.completeness === 'COMPLETE' &&
      (minutes.summary.availability !== 'AVAILABLE' ||
        minutes.transcript.availability !== 'AVAILABLE' ||
        minutes.warnings.length > 0 ||
        minutes.confirmedDecisions.some(
          (decision) =>
            decision.isStale ||
            decision.aiUncertainty === 'MATERIAL' ||
            decision.aiWarnings.length > 0
        ))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['completeness'],
        message:
          'Complete Minutes cannot contain unavailable or warned sources.',
      })
    }
    if (
      minutes.summary.availability === 'AVAILABLE' &&
      (minutes.summary.id === null ||
        minutes.summary.content === null ||
        minutes.summary.sourceType === null ||
        minutes.summary.qualityStatus !== 'READY' ||
        minutes.summary.isStale ||
        minutes.summary.aiWarnings.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['summary'],
        message: 'Available Summary has inconsistent source or review state.',
      })
    }
    if (
      minutes.transcript.availability === 'AVAILABLE' &&
      (minutes.transcript.id === null ||
        minutes.transcript.status !== 'READY' ||
        minutes.transcript.suspiciousSegments > 0 ||
        minutes.transcript.unresolvedSegments > 0 ||
        minutes.transcript.unresolvedCoverageRegions > 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['transcript'],
        message:
          'Available transcript has inconsistent source or quality state.',
      })
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

export function parseMinutes(
  value: unknown,
  expectedMeetingId?: string
): MeetingMinutes {
  const parsed = minutesSchema.safeParse(value)
  if (!parsed.success) {
    throw new CoreApiError({
      message: 'Core API returned an invalid canonical Minutes snapshot.',
      code: 'MALFORMED_MINUTES_SNAPSHOT',
      kind: 'malformed',
      cause: parsed.error,
    })
  }
  if (expectedMeetingId && parsed.data.meeting.id !== expectedMeetingId) {
    throw new CoreApiError({
      message:
        'Core API returned a canonical Minutes snapshot for a different meeting.',
      code: 'MALFORMED_MINUTES_SNAPSHOT',
      kind: 'malformed',
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
        ),
        meetingId
      ),
    meta: { featureErrorBoundary: true },
    retry: false,
  })
}
