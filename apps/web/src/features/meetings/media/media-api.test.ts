import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  fetchMediaCapability,
  MAX_MEDIA_UPLOAD_BYTES,
  MediaUploadError,
  requestMediaAccess,
  resolveMediaCapability,
  uploadMeetingFile,
  validateMeetingAudioFile,
} from './media-api'

const meetingId = '11111111-1111-4111-8111-111111111111'
const mediaId = '22222222-2222-4222-8222-222222222222'
const signature = 'a'.repeat(64)
const signedQuery =
  'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=' +
  signature +
  '&X-Amz-Date=20300101T000000Z'
const capability = `https://storage.example.invalid/meeting-media/meetings/${meetingId}/pending/${mediaId}?${signedQuery}`
const accessCapability = `https://storage.example.invalid/meeting-media/meetings/${meetingId}/sources/${mediaId}?${signedQuery}`

const finalizedMedia = {
  id: mediaId,
  meetingId,
  sourceType: 'UPLOAD',
  status: 'AVAILABLE',
  originalFilename: 'meeting.wav',
  contentType: 'audio/wav',
  sizeBytes: 3,
  durationMs: 1000,
  sha256: 'b'.repeat(64),
  createdAt: '2030-01-01T00:00:00Z',
  availableAt: '2030-01-01T00:00:01Z',
  failureCode: null,
}

function pendingMedia(
  status: 'PENDING_UPLOAD' | 'REJECTED' | 'FAILED' = 'PENDING_UPLOAD'
) {
  return {
    ...finalizedMedia,
    status,
    availableAt: null,
    sizeBytes: status === 'PENDING_UPLOAD' ? null : 3,
    durationMs: status === 'PENDING_UPLOAD' ? null : 1000,
    failureCode:
      status === 'PENDING_UPLOAD' ? null : 'MEDIA_FORMAT_UNSUPPORTED',
  }
}

function uploadIntent(
  uploadUrl: string | null = capability,
  status:
    | 'PENDING_UPLOAD'
    | 'AVAILABLE'
    | 'REJECTED'
    | 'FAILED' = 'PENDING_UPLOAD'
) {
  return {
    mediaId,
    status,
    uploadUrl,
    expiresAt: status === 'PENDING_UPLOAD' ? '2030-01-01T00:05:00Z' : null,
    requiredContentType: 'audio/wav',
  }
}

function file(name = 'meeting.wav', type = 'audio/wav', body = 'abc'): File {
  return new File([body], name, { type })
}

describe('signed media capability resolution', () => {
  it('keeps a configured public capability byte-for-byte unchanged', () => {
    expect(
      resolveMediaCapability(capability, 'PUT', meetingId, mediaId, {
        publicStorageOrigin: 'https://storage.example.invalid',
      })
    ).toBe(capability)
  })

  it('rewrites only the approved local origin and preserves the signed query', () => {
    const local = capability.replace(
      'https://storage.example.invalid',
      'https://storage.internal:9443'
    )
    expect(
      resolveMediaCapability(local, 'PUT', meetingId, mediaId, {
        development: true,
        localStorageOrigin: 'https://storage.internal:9443',
      })
    ).toBe(
      `/__local-media/meeting-media/meetings/${meetingId}/pending/${mediaId}?${signedQuery}`
    )
  })

  it.each([
    'http://storage.example.invalid/meeting-media/meetings/' +
      meetingId +
      '/pending/' +
      mediaId +
      '?' +
      signedQuery,
    capability.replace(
      'https://storage.example.invalid',
      'https://user:password@storage.example.invalid'
    ),
    capability + '#fragment',
    capability.replace('/pending/', '/sources/'),
    capability.replace(`/${mediaId}?`, `/../${mediaId}?`),
    capability.replace(`/${mediaId}?`, `/%2e%2e/${mediaId}?`),
  ])('rejects unsafe or operation-mismatched capabilities', (value) => {
    expect(() =>
      resolveMediaCapability(value, 'PUT', meetingId, mediaId, {
        publicStorageOrigin: 'https://storage.example.invalid',
      })
    ).toThrow(/invalid|unauthorized|configured/i)
  })

  it('fails closed when no approved public origin is configured', () => {
    expect(() =>
      resolveMediaCapability(capability, 'PUT', meetingId, mediaId)
    ).toThrow(/origin is not configured/i)
  })
})

describe('Core media declaration compatibility', () => {
  it.each([
    ['meeting.wav', 'audio/wav', 'audio/wav'],
    ['meeting.WAV', 'audio/x-wav', 'audio/wav'],
    ['meeting.mp3', 'audio/mp3', 'audio/mpeg'],
    ['meeting.mp3', 'audio/x-mpeg', 'audio/mpeg'],
    ['meeting.m4a', 'audio/mp4', 'audio/mp4'],
    ['meeting.m4a', 'video/mp4', 'audio/mp4'],
    ['meeting.m4a', '', 'audio/mp4'],
    ['meeting.m4a', 'application/octet-stream', 'audio/mp4'],
  ])('accepts %s as a %s declaration', (name, type, canonical) => {
    expect(
      validateMeetingAudioFile(file(name, type)).canonicalContentType
    ).toBe(canonical)
  })

  it.each([
    ['meeting.webm', 'audio/webm'],
    ['meeting.ogg', 'audio/ogg'],
    ['meeting.flac', 'audio/flac'],
    ['meeting.wav', 'audio/mpeg'],
    ['meeting.m4a', 'audio/mpeg'],
  ])('rejects unsupported or mismatched media: %s/%s', (name, type) => {
    expect(() => validateMeetingAudioFile(file(name, type))).toThrow(
      /WAV|media type/i
    )
  })

  it('rejects empty, unsafe, and oversized files before Core intent creation', () => {
    expect(() =>
      validateMeetingAudioFile(file('meeting.wav', 'audio/wav', ''))
    ).toThrow(/non-empty/i)
    expect(() =>
      validateMeetingAudioFile(file('../meeting.wav', 'audio/wav'))
    ).toThrow(/filename/i)
    expect(() =>
      validateMeetingAudioFile(file(' meeting.wav', 'audio/wav'))
    ).toThrow(/filename/i)
    const oversized = file()
    Object.defineProperty(oversized, 'size', {
      configurable: true,
      value: MAX_MEDIA_UPLOAD_BYTES + 1,
    })
    expect(() => validateMeetingAudioFile(oversized)).toThrow(/upload limit/i)
  })
})

describe('normal signed media upload transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.stubEnv(
      'VITE_MEDIA_STORAGE_PUBLIC_ORIGIN',
      'https://storage.example.invalid'
    )
  })

  it('uses one Core intent, one signed PUT, and one authoritative finalization', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValueOnce(uploadIntent())
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

  it('does not PUT or finalize an AVAILABLE idempotency replay', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValue(uploadIntent(null, 'AVAILABLE'))
    const get = vi.spyOn(coreApi, 'get').mockResolvedValue(finalizedMedia)
    const upload = vi.fn()
    vi.stubGlobal('fetch', upload)

    await expect(
      uploadMeetingFile(meetingId, file(), 'UPLOAD', {
        idempotencyKey: 'same-upload-operation',
      })
    ).resolves.toEqual(finalizedMedia)

    expect(post).toHaveBeenCalledExactlyOnceWith(
      `/meetings/${meetingId}/media/uploads`,
      expect.anything(),
      expect.anything()
    )
    expect(get).toHaveBeenCalledExactlyOnceWith(
      `/meetings/${meetingId}/media/${mediaId}`
    )
    expect(upload).not.toHaveBeenCalled()
  })

  it.each(['REJECTED', 'FAILED'] as const)(
    'reports a %s intent without attempting storage',
    async (status) => {
      const post = vi
        .spyOn(coreApi, 'post')
        .mockResolvedValue(uploadIntent(null, status))
      const upload = vi.fn()
      vi.stubGlobal('fetch', upload)

      await expect(uploadMeetingFile(meetingId, file())).rejects.toThrow(
        /rejected|failed/i
      )
      expect(post).toHaveBeenCalledOnce()
      expect(upload).not.toHaveBeenCalled()
    }
  )

  it('rejects an incomplete, expired, or malformed pending intent before PUT', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValueOnce({ ...uploadIntent(), uploadUrl: null })
    const upload = vi.fn()
    vi.stubGlobal('fetch', upload)
    await expect(uploadMeetingFile(meetingId, file())).rejects.toThrow(
      /invalid media upload intent/i
    )
    expect(upload).not.toHaveBeenCalled()

    post.mockReset().mockResolvedValueOnce({
      ...uploadIntent(),
      expiresAt: '2000-01-01T00:00:00Z',
    })
    await expect(uploadMeetingFile(meetingId, file())).rejects.toThrow(
      /expired/i
    )
    expect(upload).not.toHaveBeenCalled()
  })

  it('does not finalize after a definite storage failure', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValueOnce(uploadIntent())
      .mockResolvedValueOnce(finalizedMedia)
    const upload = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', upload)

    await expect(uploadMeetingFile(meetingId, file())).rejects.toThrow(
      /storage upload failed \(403\)/
    )
    expect(post).toHaveBeenCalledOnce()
  })

  it('does not repeat a signed PUT after an ambiguous transfer and reads Core status', async () => {
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue(uploadIntent())
    const get = vi.spyOn(coreApi, 'get').mockResolvedValue(pendingMedia())
    const upload = vi.fn().mockRejectedValue(new TypeError('network timeout'))
    vi.stubGlobal('fetch', upload)

    const error = await uploadMeetingFile(meetingId, file()).catch(
      (value) => value
    )
    expect(error).toBeInstanceOf(MediaUploadError)
    expect((error as MediaUploadError).outcome).toBe('uncertain')
    expect(upload).toHaveBeenCalledOnce()
    expect(post).toHaveBeenCalledOnce()
    expect(get).toHaveBeenCalledExactlyOnceWith(
      `/meetings/${meetingId}/media/${mediaId}`
    )
  })

  it('resumes a possibly transferred intent by reading and finalizing its exact media identity', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValueOnce(uploadIntent())
      .mockResolvedValueOnce(finalizedMedia)
    const get = vi.spyOn(coreApi, 'get').mockResolvedValue(pendingMedia())
    const upload = vi.fn()
    vi.stubGlobal('fetch', upload)
    const controller = new AbortController()

    await expect(
      uploadMeetingFile(meetingId, file(), 'UPLOAD', {
        idempotencyKey: 'original-logical-upload',
        signal: controller.signal,
        recovery: { mediaId, phase: 'storage-uploading' },
      })
    ).resolves.toEqual(finalizedMedia)

    expect(get).toHaveBeenCalledExactlyOnceWith(
      `/meetings/${meetingId}/media/${mediaId}`,
      { signal: controller.signal }
    )
    expect(post).toHaveBeenNthCalledWith(
      1,
      `/meetings/${meetingId}/media/uploads`,
      expect.anything(),
      expect.objectContaining({
        headers: { 'Idempotency-Key': 'original-logical-upload' },
        signal: controller.signal,
      })
    )
    expect(post).toHaveBeenNthCalledWith(
      2,
      `/meetings/${meetingId}/media/${mediaId}/finalize`,
      undefined,
      { signal: controller.signal }
    )
    expect(upload).not.toHaveBeenCalled()
  })

  it('fails closed when a replayed logical intent returns a different media identity', async () => {
    const otherMediaId = '33333333-3333-4333-8333-333333333333'
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      ...uploadIntent(),
      mediaId: otherMediaId,
    })
    const upload = vi.fn()
    vi.stubGlobal('fetch', upload)
    const onMediaIdentity = vi.fn()

    await expect(
      uploadMeetingFile(meetingId, file(), 'UPLOAD', {
        idempotencyKey: 'original-logical-upload',
        recovery: { mediaId, phase: 'finalizing' },
        onMediaIdentity,
      })
    ).rejects.toThrow(/different media identity/i)

    expect(onMediaIdentity).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })

  it('uses authoritative read-back when finalization response is lost', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValueOnce(uploadIntent())
      .mockRejectedValueOnce(
        new CoreApiError({
          message: 'network',
          kind: 'network',
        })
      )
    const get = vi.spyOn(coreApi, 'get').mockResolvedValue(finalizedMedia)
    const upload = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', upload)

    await expect(uploadMeetingFile(meetingId, file())).resolves.toEqual(
      finalizedMedia
    )
    expect(post).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledExactlyOnceWith(
      `/meetings/${meetingId}/media/${mediaId}`
    )
  })

  it('does not claim success for a rejected finalization response', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValueOnce(uploadIntent())
      .mockResolvedValueOnce(pendingMedia('REJECTED'))
    const upload = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', upload)

    await expect(uploadMeetingFile(meetingId, file())).rejects.toThrow(
      /container or codec/i
    )
    expect(post).toHaveBeenCalledTimes(2)
  })
})

describe('signed media access', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('requires an available Core record and resolves one signed GET capability', async () => {
    const get = vi.spyOn(coreApi, 'get').mockResolvedValue(finalizedMedia)
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue({
      url: accessCapability,
      expiresAt: '2030-01-01T00:05:00Z',
    })

    await expect(
      requestMediaAccess(meetingId, mediaId, {
        publicStorageOrigin: 'https://storage.example.invalid',
      })
    ).resolves.toEqual({
      url: accessCapability,
      expiresAt: '2030-01-01T00:05:00Z',
    })
    expect(get).toHaveBeenCalledExactlyOnceWith(
      `/meetings/${meetingId}/media/${mediaId}`
    )
    expect(post).toHaveBeenCalledExactlyOnceWith(
      `/meetings/${meetingId}/media/${mediaId}/access-url`
    )
  })

  it('performs credential-free GET with redirect and referrer protection', async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response('audio', {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      })
    )
    await expect(
      fetchMediaCapability(accessCapability, { transport })
    ).resolves.toBeInstanceOf(Blob)
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      accessCapability,
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      })
    )
    const request = transport.mock.calls[0]?.[1] as RequestInit
    expect(request.headers ?? {}).not.toHaveProperty('Authorization')
    expect(request.headers ?? {}).not.toHaveProperty('X-CSRF-Token')
  })

  it('rejects expired or unsafe access capabilities before a storage GET', async () => {
    const get = vi.spyOn(coreApi, 'get').mockResolvedValue(finalizedMedia)
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      url: accessCapability.replace(
        'https://storage.example.invalid',
        'http://storage.example.invalid'
      ),
      expiresAt: '2030-01-01T00:05:00Z',
    })
    const transport = vi.fn()

    await expect(
      requestMediaAccess(meetingId, mediaId, {
        publicStorageOrigin: 'https://storage.example.invalid',
      })
    ).rejects.toThrow(/invalid|unauthorized/i)
    expect(transport).not.toHaveBeenCalled()
    expect(get).toHaveBeenCalledOnce()
  })
})
