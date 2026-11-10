import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { coreApi } from '@/lib/core-api'

const mediaSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  sourceType: z.string(),
  status: z.string(),
  originalFilename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().nullable(),
  durationMs: z.number().nullable(),
  sha256: z.string().nullable(),
  createdAt: z.string(),
  availableAt: z.string().nullable(),
  failureCode: z.string().nullable(),
})
export type MeetingMedia = z.infer<typeof mediaSchema>
const uploadIntentSchema = z.object({
  mediaId: z.string().uuid(),
  status: z.string(),
  uploadUrl: z.string().url(),
  expiresAt: z.string(),
  requiredContentType: z.string(),
})
const path = (meetingId: string) =>
  '/meetings/' + encodeURIComponent(meetingId) + '/media'
export function meetingMediaQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['meeting-media', meetingId],
    queryFn: async ({ signal }) =>
      mediaSchema
        .array()
        .parse(await coreApi.get<unknown>(path(meetingId), { signal })),
    retry: false,
  })
}
export async function uploadMeetingFile(
  meetingId: string,
  file: File,
  sourceType: 'UPLOAD' | 'RECORDING' = 'UPLOAD'
) {
  if (file.size <= 0) throw new Error('Choose a non-empty audio recording.')
  const contentType = file.type || 'application/octet-stream'
  const intent = uploadIntentSchema.parse(
    await coreApi.post<unknown>(
      path(meetingId) + '/uploads',
      {
        sourceType,
        originalFilename: file.name,
        contentType,
        expectedSizeBytes: file.size,
      },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } }
    )
  )
  // The short-lived S3 capability is never sent to Core API or persisted in browser storage.
  // Do not attach session cookies or CSRF headers to third-party object storage.
  const response = await fetch(intent.uploadUrl, {
    method: 'PUT',
    body: file,
    credentials: 'omit',
    headers: { 'Content-Type': intent.requiredContentType },
    referrerPolicy: 'no-referrer',
  })
  if (!response.ok)
    throw new Error(
      'Object storage upload failed (' +
        response.status +
        '). The file was not finalized.'
    )
  return mediaSchema.parse(
    await coreApi.post<unknown>(
      path(meetingId) + '/' + intent.mediaId + '/finalize'
    )
  )
}
export async function requestMediaAccess(meetingId: string, mediaId: string) {
  return z
    .object({ url: z.string().url(), expiresAt: z.string() })
    .parse(
      await coreApi.post<unknown>(
        path(meetingId) + '/' + encodeURIComponent(mediaId) + '/access-url'
      )
    )
}
