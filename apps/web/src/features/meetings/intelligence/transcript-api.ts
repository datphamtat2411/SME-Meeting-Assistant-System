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
    // Legacy read-only responses may omit a token; never derive it.
    etag: z.string().min(1).optional(),
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

export async function fetchTranscriptReview(
  meetingId: string,
  signal?: AbortSignal
): Promise<TranscriptReview> {
  const response = await coreApi.getWithMetaAndEtag<unknown>(
    route(meetingId) + '/transcript',
    { signal }
  )
  const transcript = transcriptSchema.parse(response.data)
  if (transcript.meetingId !== meetingId) {
    throw new CoreApiError({
      message: 'Core returned a transcript for another meeting.',
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
    })
  }
  return { transcript, etag: requiredEtag(response.etag) }
}

export function transcriptReviewQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['transcript', meetingId, 'review'],
    queryFn: ({ signal }) => fetchTranscriptReview(meetingId, signal),
    retry: false,
  })
}

type TranscriptEvidenceIdentity = {
  meetingId: string
  transcriptId: string
  sourceMediaId: string
  processingJobId: string
  versionNumber: number
  contentRevision: number
  etag: string
}

export function transcriptEvidenceIdentity(
  snapshot: TranscriptReview
): TranscriptEvidenceIdentity {
  const transcript = snapshot.transcript
  return {
    meetingId: transcript.meetingId,
    transcriptId: transcript.id,
    sourceMediaId: transcript.sourceMediaId,
    processingJobId: transcript.processingJobId,
    versionNumber: transcript.versionNumber,
    contentRevision: transcript.contentRevision,
    etag: snapshot.etag,
  }
}

function sameTranscriptEvidence(
  expected: TranscriptEvidenceIdentity,
  current: TranscriptReview
): boolean {
  const observed = transcriptEvidenceIdentity(current)
  return (
    expected.meetingId === observed.meetingId &&
    expected.transcriptId === observed.transcriptId &&
    expected.sourceMediaId === observed.sourceMediaId &&
    expected.processingJobId === observed.processingJobId &&
    expected.versionNumber === observed.versionNumber &&
    expected.contentRevision === observed.contentRevision &&
    expected.etag === observed.etag
  )
}

// Supplementary endpoints do not carry a transcript identity. Bracket their
// read with canonical evidence checks; do not treat the result as atomic.
async function readBoundEvidence<T>(
  meetingId: string,
  evidence: TranscriptEvidenceIdentity,
  signal: AbortSignal,
  read: () => Promise<T>
): Promise<T> {
  const check = async () => {
    const current = await fetchTranscriptReview(meetingId, signal)
    if (!sameTranscriptEvidence(evidence, current)) {
      throw new CoreApiError({
        message: 'Transcript evidence changed. Reload the current snapshot.',
        code: 'TRANSCRIPT_EVIDENCE_CHANGED',
        kind: 'malformed',
      })
    }
  }
  await check()
  const data = await read()
  await check()
  return data
}

export function reviewCoverageQuery(
  meetingId: string,
  snapshot: TranscriptReview | undefined
) {
  const evidence = snapshot ? transcriptEvidenceIdentity(snapshot) : null
  return queryOptions({
    queryKey: ['transcript', meetingId, 'coverage', evidence],
    enabled: Boolean(evidence),
    queryFn: ({ signal }) => {
      if (!evidence) throw new Error('A transcript snapshot is required.')
      return readBoundEvidence(meetingId, evidence, signal, async () =>
        coverageSchema.array().parse(
          await coreApi.get<unknown>(
            route(meetingId) + '/transcript/coverage',
            {
              signal,
            }
          )
        )
      )
    },
    retry: false,
  })
}

export function reviewSpeakersQuery(
  meetingId: string,
  snapshot: TranscriptReview | undefined
) {
  const evidence = snapshot ? transcriptEvidenceIdentity(snapshot) : null
  return queryOptions({
    queryKey: ['transcript', meetingId, 'speakers', evidence],
    enabled: Boolean(evidence),
    queryFn: ({ signal }) => {
      if (!evidence) throw new Error('A transcript snapshot is required.')
      return readBoundEvidence(meetingId, evidence, signal, async () =>
        speakerSchema.array().parse(
          await coreApi.get<unknown>(route(meetingId) + '/speaker-clusters', {
            signal,
          })
        )
      )
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
  segment: Pick<Transcript['segments'][number], 'id' | 'etag'>,
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
  segment: Pick<Transcript['segments'][number], 'id' | 'etag'>
): string {
  if (!segment.etag) {
    throw new CoreApiError({
      message: 'A segment concurrency token is required before correction.',
      code: 'PRECONDITION_REQUIRED',
      kind: 'malformed',
    })
  }
  return segment.etag
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
