import { beforeEach, describe, expect, it, vi } from 'vitest'
import { coreApi } from '@/lib/core-api'
import { uploadMeetingFile } from './media-api'

const meetingId = '11111111-1111-4111-8111-111111111111'
const mediaId = '22222222-2222-4222-8222-222222222222'
const capability =
  'https://storage.example.invalid/bucket/object?X-Amz-Signature=' +
  'a'.repeat(64)

const finalizedMedia = {
  id: mediaId,
  meetingId,
  sourceType: 'UPLOAD',
  status: 'AVAILABLE',
  originalFilename: 'meeting.wav',
  contentType: 'audio/wav',
  sizeBytes: 3,
  durationMs: null,
  sha256: null,
  createdAt: '2026-11-23T00:00:00Z',
  availableAt: '2026-11-23T00:00:00Z',
  failureCode: null,
}

function uploadIntent(uploadUrl: string) {
  return {
    mediaId,
    status: 'PENDING_UPLOAD',
    uploadUrl,
    expiresAt: '2026-11-23T00:05:00Z',
    requiredContentType: 'audio/wav',
  }
}

function file() {
  return new File(['abc'], 'meeting.wav', { type: 'audio/wav' })
}

describe('normal signed media upload transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses the Core capability once without browser credentials, referrers, or query mutation', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValueOnce(uploadIntent(capability))
      .mockResolvedValueOnce(finalizedMedia)
    const upload = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', upload)

    await expect(uploadMeetingFile(meetingId, file())).resolves.toEqual(
      finalizedMedia
    )

    expect(upload).toHaveBeenCalledExactlyOnceWith(
      capability,
      expect.objectContaining({
        method: 'PUT',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'audio/wav' },
      })
    )
    const request = upload.mock.calls[0]?.[1] as RequestInit
    expect(request.headers).not.toHaveProperty('Authorization')
    expect(request.headers).not.toHaveProperty('X-CSRF-Token')
    expect(post).toHaveBeenNthCalledWith(
      1,
      `/meetings/${meetingId}/media/uploads`,
      {
        sourceType: 'UPLOAD',
        originalFilename: 'meeting.wav',
        contentType: 'audio/wav',
        expectedSizeBytes: 3,
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    )
    expect(post).toHaveBeenNthCalledWith(
      2,
      `/meetings/${meetingId}/media/${mediaId}/finalize`
    )
  })

  it.each([
    'http://storage.example.invalid/bucket/object?signature=bad',
    'https://user:password@storage.example.invalid/bucket/object',
    'https://storage.example.invalid/bucket/object#capability',
    'not-a-url',
  ])(
    'rejects an unsafe or malformed capability before PUT: %s',
    async (url) => {
      const post = vi
        .spyOn(coreApi, 'post')
        .mockResolvedValue(uploadIntent(url))
      const upload = vi.fn()
      vi.stubGlobal('fetch', upload)

      await expect(uploadMeetingFile(meetingId, file())).rejects.toThrow(
        /invalid|insecure/i
      )

      expect(upload).not.toHaveBeenCalled()
      expect(post).toHaveBeenCalledTimes(1)
    }
  )

  it.each([302, 503])(
    'does not finalize after an unsuccessful storage response (%s)',
    async (status) => {
      const post = vi
        .spyOn(coreApi, 'post')
        .mockResolvedValueOnce(uploadIntent(capability))
        .mockResolvedValueOnce(finalizedMedia)
      const upload = vi.fn().mockResolvedValue(new Response(null, { status }))
      vi.stubGlobal('fetch', upload)

      await expect(uploadMeetingFile(meetingId, file())).rejects.toThrow(
        `Object storage upload failed (${status})`
      )

      expect(post).toHaveBeenCalledTimes(1)
    }
  )

  it('does not retry or finalize after an ambiguous network failure', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValue(uploadIntent(capability))
    const upload = vi
      .fn()
      .mockRejectedValue(new TypeError('failed at capability'))
    vi.stubGlobal('fetch', upload)

    await expect(uploadMeetingFile(meetingId, file())).rejects.toThrow(
      'could not be completed'
    )

    expect(upload).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledTimes(1)
  })
})
