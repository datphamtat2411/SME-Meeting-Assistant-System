import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { coreApi } from '@/lib/core-api'

const segmentSchema = z.object({
  id: z.string().uuid(),
  ordinal: z.number().int(),
  startMs: z.number(),
  endMs: z.number(),
  text: z.string(),
  qualityStatus: z.string(),
  speakerClusterId: z.string().uuid().nullable(),
  speakerLabel: z.string().nullable(),
  version: z.number().int(),
})
export const transcriptSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  sourceMediaId: z.string().uuid(),
  processingJobId: z.string().uuid(),
  versionNumber: z.number().int(),
  languageCode: z.string().nullable(),
  status: z.string(),
  durationMs: z.number().nullable(),
  finalizedAt: z.string().nullable(),
  contentRevision: z.number().int(),
  segments: z.array(segmentSchema),
})
export type Transcript = z.infer<typeof transcriptSchema>
export const coverageSchema = z.object({
  id: z.string().uuid(),
  startMs: z.number(),
  endMs: z.number(),
  coverageStatus: z.string(),
  recovered: z.boolean(),
  retryCount: z.number().int(),
})
export const speakerSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  userId: z.string().uuid().nullable(),
  displayName: z.string().nullable(),
})
export type Speaker = z.infer<typeof speakerSchema>
const route = (meetingId: string) =>
  '/meetings/' + encodeURIComponent(meetingId)
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
      speakerSchema
        .array()
        .parse(
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
  reason: string
) {
  return coreApi.patch(
    route(meetingId) + '/transcript/segments/' + encodeURIComponent(segment.id),
    { text, reason: reason || null },
    {
      headers: { 'If-Match': '"s-' + segment.id + '-' + segment.version + '"' },
    }
  )
}
export async function mapSpeaker(
  meetingId: string,
  speakerId: string,
  userId: string | null
) {
  const snapshot = await coreApi.getWithMetaAndEtag<unknown>(
    route(meetingId) + '/transcript'
  )
  transcriptSchema.parse(snapshot.data)
  return coreApi.patch(
    route(meetingId) + '/speaker-clusters/' + encodeURIComponent(speakerId),
    { userId },
    { headers: { 'If-Match': snapshot.etag } }
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
