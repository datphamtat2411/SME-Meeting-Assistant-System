import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi } from '@/lib/core-api'

const segmentSchema = z
  .object({
    id: z.string().uuid(),
    ordinal: z.number().int().nonnegative(),
    startMs: z.number().finite().nonnegative(),
    endMs: z.number().finite().nonnegative(),
    text: z.string(),
    qualityStatus: z.string(),
    speakerClusterId: z.string().uuid().nullable(),
    speakerLabel: z.string().nullable(),
    version: z.number().int().nonnegative(),
  })
  .superRefine((segment, context) => {
    if (segment.endMs < segment.startMs) {
      context.addIssue({
        code: 'custom',
        message: 'A transcript segment cannot end before it starts.',
        path: ['endMs'],
      })
    }
  })
export const transcriptSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  sourceMediaId: z.string().uuid(),
  processingJobId: z.string().uuid(),
  versionNumber: z.number().int().nonnegative(),
  languageCode: z.string().nullable(),
  status: z.string(),
  durationMs: z.number().finite().nonnegative().nullable(),
  finalizedAt: z.string().nullable(),
  contentRevision: z.number().int().nonnegative(),
  segments: z.array(segmentSchema),
})
export type Transcript = z.infer<typeof transcriptSchema>
export const coverageSchema = z
  .object({
    id: z.string().uuid(),
    startMs: z.number().finite().nonnegative(),
    endMs: z.number().finite().nonnegative(),
    coverageStatus: z.enum(['COVERED', 'SUSPICIOUS', 'UNRESOLVED_ERROR']),
    recovered: z.boolean(),
    retryCount: z.number().int().nonnegative(),
  })
  .superRefine((region, context) => {
    if (region.endMs < region.startMs) {
      context.addIssue({
        code: 'custom',
        message: 'A coverage region cannot end before it starts.',
        path: ['endMs'],
      })
    }
  })
export type TranscriptCoverage = z.infer<typeof coverageSchema>
export const speakerSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  userId: z.string().uuid().nullable(),
  displayName: z.string().nullable(),
})
export type Speaker = z.infer<typeof speakerSchema>

export type TranscriptReview = {
  transcript: Transcript
  etag: string
}

function requiredEtag(value: string | undefined): string {
  if (typeof value === 'string' && value.length > 0) return value
  throw new CoreApiError({
    message: 'Core API did not return a transcript concurrency token.',
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
  })
}

const route = (meetingId: string) =>
  '/meetings/' + encodeURIComponent(meetingId)

/**
 * The original transcript query is retained for callers that only need the
 * canonical transcript body. Review and mutation surfaces use the sibling
 * query below so the collection ETag is captured with the same observation.
 */
export function transcriptQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['transcript', meetingId],
    queryFn: async ({ signal }) =>
      transcriptSchema.parse(
        await coreApi.get<unknown>(route(meetingId) + '/transcript', { signal })
      ),
    retry: false,
  })
}

export function transcriptReviewQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['transcript', meetingId, 'review'],
    queryFn: async ({ signal }): Promise<TranscriptReview> => {
      const response = await coreApi.getWithMetaAndEtag<unknown>(
        route(meetingId) + '/transcript',
        { signal }
      )
      return {
        transcript: transcriptSchema.parse(response.data),
        etag: requiredEtag(response.etag),
      }
    },
    retry: false,
  })
}

export function transcriptCoverageQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['transcript', meetingId, 'coverage'],
    queryFn: async ({ signal }) =>
      coverageSchema
        .array()
        .parse(
          await coreApi.get<unknown>(
            route(meetingId) + '/transcript/coverage',
            { signal }
          )
        ),
    retry: false,
  })
}
export function speakerClustersQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['transcript', meetingId, 'speakers'],
    queryFn: async ({ signal }) =>
      speakerSchema.array().parse(
        await coreApi.get<unknown>(route(meetingId) + '/speaker-clusters', {
          signal,
        })
      ),
    retry: false,
  })
}
export async function correctTranscriptSegment(
  meetingId: string,
  segment: Transcript['segments'][number],
  text: string,
  reason: string,
  signal?: AbortSignal
) {
  return coreApi.patch(
    route(meetingId) + '/transcript/segments/' + encodeURIComponent(segment.id),
    { text, reason: reason || null },
    {
      headers: { 'If-Match': transcriptSegmentEtag(segment) },
      ...(signal ? { signal } : {}),
    }
  )
}

export function transcriptSegmentEtag(
  segment: Pick<Transcript['segments'][number], 'id' | 'version'>
): string {
  return `"s-${segment.id}-${segment.version}"`
}

export async function mapSpeaker(
  meetingId: string,
  speakerId: string,
  userId: string | null,
  ifMatch?: string,
  signal?: AbortSignal
) {
  if (!ifMatch) {
    throw new CoreApiError({
      message:
        'A transcript concurrency token is required before changing speaker mapping.',
      code: 'PRECONDITION_REQUIRED',
      kind: 'malformed',
    })
  }
  return coreApi.patch(
    route(meetingId) + '/speaker-clusters/' + encodeURIComponent(speakerId),
    { userId },
    {
      headers: { 'If-Match': ifMatch },
      ...(signal ? { signal } : {}),
    }
  )
}

export function timecode(ms: number) {
  const total = Math.floor(ms / 1000),
    seconds = total % 60,
    minutes = Math.floor(total / 60) % 60
  return (
    String(Math.floor(total / 3600)).padStart(2, '0') +
    ':' +
    String(minutes).padStart(2, '0') +
    ':' +
    String(seconds).padStart(2, '0')
  )
}
