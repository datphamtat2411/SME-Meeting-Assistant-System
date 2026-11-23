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
function readUploadIntent(value: unknown): z.infer<typeof uploadIntentSchema> {
  const parsed = uploadIntentSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Core returned an invalid media upload capability.')
  }
  return parsed.data
}
function secureCapabilityUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Core returned an invalid or insecure storage capability.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Core returned an invalid or insecure storage capability.')
  }
  // Return the original capability so its signed query is not normalized.
  return value
}
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
  const intent = readUploadIntent(
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
  const uploadUrl = secureCapabilityUrl(intent.uploadUrl)
  let response: Response
  try {
    response = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      credentials: 'omit',
      redirect: 'error',
      headers: { 'Content-Type': intent.requiredContentType },
      referrerPolicy: 'no-referrer',
    })
  } catch {
    throw new Error(
      'Object storage upload could not be completed. The file was not finalized.'
    )
  }
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
