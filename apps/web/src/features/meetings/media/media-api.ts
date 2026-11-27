import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { MediaPresentationError } from './media-error-presentation'

const mediaStatuses = [
  'PENDING_UPLOAD',
  'AVAILABLE',
  'REJECTED',
  'FAILED',
] as const
const mediaStatusSchema = z.enum(mediaStatuses)
const dateTimeSchema = z
  .string()
  .refine(
    (value) =>
      /(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    'Core returned an invalid timestamp.'
  )

const mediaSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  sourceType: z.string().min(1),
  status: mediaStatusSchema,
  originalFilename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  createdAt: dateTimeSchema,
  availableAt: dateTimeSchema.nullable(),
  failureCode: z.string().nullable(),
})
export type MeetingMedia = z.infer<typeof mediaSchema>

const uploadIntentSchema = z
  .object({
    mediaId: z.string().uuid(),
    status: mediaStatusSchema,
    uploadUrl: z.string().url().nullable(),
    expiresAt: dateTimeSchema.nullable(),
    requiredContentType: z.string().min(1),
  })
  .superRefine((intent, context) => {
    const pending = intent.status === 'PENDING_UPLOAD'
    if (pending && (!intent.uploadUrl || !intent.expiresAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Pending media must include an upload capability and expiry.',
        path: ['uploadUrl'],
      })
    }
    if (!pending && (intent.uploadUrl !== null || intent.expiresAt !== null)) {
      context.addIssue({
        code: 'custom',
        message:
          'A completed or failed media intent cannot include a capability.',
        path: ['uploadUrl'],
      })
    }
  })
type MediaUploadIntent = z.infer<typeof uploadIntentSchema>

const mediaAccessSchema = z.object({
  url: z.string().url(),
  expiresAt: dateTimeSchema,
})

const uploadMimes: Readonly<Record<string, readonly string[]>> = {
  wav: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  mp3: ['audio/mpeg', 'audio/mp3', 'audio/x-mp3', 'audio/x-mpeg'],
  m4a: [
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'video/mp4',
    'application/mp4',
  ],
}

const canonicalMimes: Readonly<Record<string, string>> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
}

const DEFAULT_MAX_MEDIA_UPLOAD_BYTES = 1024 ** 3
const configuredMaxMediaUploadBytes = Number(
  import.meta.env.VITE_MEDIA_MAX_UPLOAD_BYTES
)
export const MAX_MEDIA_UPLOAD_BYTES =
  Number.isSafeInteger(configuredMaxMediaUploadBytes) &&
  configuredMaxMediaUploadBytes > 0 &&
  configuredMaxMediaUploadBytes <= DEFAULT_MAX_MEDIA_UPLOAD_BYTES
    ? configuredMaxMediaUploadBytes
    : DEFAULT_MAX_MEDIA_UPLOAD_BYTES

export type MediaFileDeclaration = {
  filename: string
  contentType: string
  canonicalContentType: string
  extension: 'wav' | 'mp3' | 'm4a'
}

export type MediaCapabilityOperation = 'PUT' | 'GET'

export type MediaCapabilityResolutionOptions = {
  development?: boolean
  localStorageOrigin?: string
  publicStorageOrigin?: string
}

export type MediaUploadPhase =
  | 'intent-created'
  | 'available-replay'
  | 'storage-uploading'
  | 'storage-uploaded'
  | 'finalizing'
  | 'reconciling'
  | 'available'

export type MediaUploadOptions = {
  idempotencyKey?: string
  onPhase?: (phase: MediaUploadPhase) => void
  onRequestStart?: () => void
  onMediaIdentity?: (mediaId: string) => void
  signal?: AbortSignal
  recovery?: {
    mediaId: string
    phase: MediaUploadPhase | null
  }
  /**
   * Called immediately before a consequential phase. The meeting-scoped
   * ingestion owner uses this to re-check operation identity and authorization
   * after asynchronous preparation.
   */
  canContinue?: () => void
  uploadTransport?: SignedMediaTransport
}

export type SignedMediaTransport = (
  url: string,
  init: RequestInit
) => Promise<Response>

export type MediaCapabilityFetchOptions = {
  signal?: AbortSignal
  transport?: SignedMediaTransport
}

export class MediaUploadError extends MediaPresentationError {
  readonly outcome: 'failed' | 'uncertain'
  readonly mediaId?: string

  constructor(
    message: string,
    options: {
      outcome?: 'failed' | 'uncertain'
      mediaId?: string
      cause?: unknown
      presentationKey?: string
      presentationValues?: Record<string, string | number>
    } = {}
  ) {
    super(
      message,
      options.presentationKey ??
        (options.outcome === 'uncertain'
          ? 'media:uploadOutcomeUncertain'
          : 'media:uploadFailureHint'),
      options.presentationValues
    )
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: options.cause,
      })
    }
    this.name = 'MediaUploadError'
    this.outcome = options.outcome ?? 'failed'
    this.mediaId = options.mediaId
  }
}

export class MediaUploadCancelledError extends Error {
  constructor(message = 'The media operation was cancelled.') {
    super(message)
    this.name = 'MediaUploadCancelledError'
  }
}

function invalidCapability(): Error {
  return new Error(
    'Core returned an invalid or unauthorized storage capability.'
  )
}

function configuredOrigin(
  value: string | undefined,
  kind: 'local' | 'public'
): URL | null {
  if (!value) return null
  try {
    const origin = new URL(value)
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      (kind === 'local' && origin.hostname !== 'storage.internal')
    ) {
      throw new Error('invalid origin')
    }
    return origin
  } catch {
    throw new Error(
      kind === 'local'
        ? 'The approved local media storage origin is invalid.'
        : 'The approved public media storage origin is invalid.'
    )
  }
}

function uuidPattern(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  )
}

function containsControlCharacters(value: string, includeSpaces: boolean) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x7f || code < 0x20 || (includeSpaces && code === 0x20)) {
      return true
    }
  }
  return false
}

const capabilityPathPattern =
  /^\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/meetings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(pending|sources)\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

/**
 * Resolves only the two Core-issued media object namespaces. The raw path and
 * query are taken from the capability string rather than reconstructed from a
 * URL object so a signed query is not reordered or normalized.
 */
export function resolveMediaCapability(
  value: string,
  operation: MediaCapabilityOperation,
  meetingId: string,
  mediaId: string,
  options: MediaCapabilityResolutionOptions = {}
): string {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    containsControlCharacters(value, true) ||
    !uuidPattern(meetingId) ||
    !uuidPattern(mediaId)
  ) {
    throw invalidCapability()
  }

  const raw = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?$/.exec(value)
  if (!raw || value.includes('#')) throw invalidCapability()

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidCapability()
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw invalidCapability()
  }

  const rawPath = raw[2] ?? ''
  const rawQuery = raw[3]
  if (!rawQuery) throw invalidCapability()

  const pathMatch = capabilityPathPattern.exec(rawPath)
  if (
    !pathMatch ||
    pathMatch[2].toUpperCase() !== operationNamespace(operation) ||
    pathMatch[1].toLowerCase() !== meetingId.toLowerCase() ||
    pathMatch[3].toLowerCase() !== mediaId.toLowerCase()
  ) {
    throw invalidCapability()
  }

  const query = new URLSearchParams(rawQuery)
  if (
    query.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' ||
    !/^[a-f0-9]{64}$/i.test(query.get('X-Amz-Signature') ?? '')
  ) {
    throw invalidCapability()
  }

  const localOrigin = configuredOrigin(
    options.localStorageOrigin ??
      import.meta.env.VITE_LOCAL_MEDIA_STORAGE_ORIGIN,
    'local'
  )
  const publicOrigin = configuredOrigin(
    options.publicStorageOrigin ??
      import.meta.env.VITE_MEDIA_STORAGE_PUBLIC_ORIGIN,
    'public'
  )
  const development = options.development ?? import.meta.env.DEV

  if (development && localOrigin && url.origin === localOrigin.origin) {
    return `/__local-media${rawPath}?${rawQuery}`
  }
  if (publicOrigin && url.origin === publicOrigin.origin) return value

  throw new Error(
    'The approved browser-reachable media storage origin is not configured.'
  )
}

function operationNamespace(operation: MediaCapabilityOperation): string {
  return operation === 'PUT' ? 'PENDING' : 'SOURCES'
}

function normalizeContentType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function filenameExtension(filename: string): string | undefined {
  const match = /\.([^.]+)$/.exec(filename)
  return match?.[1]?.toLowerCase()
}

export function validateMeetingAudioFile(file: File): MediaFileDeclaration {
  const filename = file.name.trim()
  if (
    !filename ||
    filename.length > 512 ||
    filename !== file.name ||
    containsControlCharacters(filename, false) ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    throw new MediaPresentationError(
      'Choose an audio file with a simple, valid filename.',
      'media:invalidFilename'
    )
  }

  const extension = filenameExtension(filename)
  if (extension !== 'wav' && extension !== 'mp3' && extension !== 'm4a') {
    throw new MediaPresentationError(
      'Choose a WAV, MP3, or AAC M4A recording.',
      'media:unsupportedFile'
    )
  }

  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new MediaPresentationError(
      'Choose a non-empty recording.',
      'media:emptyFile'
    )
  }
  if (file.size > MAX_MEDIA_UPLOAD_BYTES) {
    throw new MediaPresentationError(
      `The recording exceeds the ${formatByteLimit(MAX_MEDIA_UPLOAD_BYTES)} upload limit.`,
      'media:fileTooLarge',
      { limit: formatByteLimit(MAX_MEDIA_UPLOAD_BYTES) }
    )
  }

  const reportedType = normalizeContentType(file.type)
  const contentType = reportedType || 'application/octet-stream'
  if (
    contentType !== 'application/octet-stream' &&
    !uploadMimes[extension].includes(contentType)
  ) {
    throw new MediaPresentationError(
      'The browser reported a media type that does not match the filename.',
      'media:fileTypeMismatch'
    )
  }

  return {
    filename,
    contentType,
    canonicalContentType: canonicalMimes[extension],
    extension,
  }
}

function formatByteLimit(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${Math.round(bytes / 1024 ** 3)} GiB`
    : `${Math.round(bytes / 1024 ** 2)} MiB`
}

function readUploadIntent(value: unknown): MediaUploadIntent {
  const parsed = uploadIntentSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Core returned an invalid media upload intent.')
  }
  return parsed.data
}

function readMedia(value: unknown): MeetingMedia {
  const parsed = mediaSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Core returned an invalid media record.')
  }
  return parsed.data
}

function assertMediaBinding(
  media: MeetingMedia,
  meetingId: string,
  mediaId: string
): MeetingMedia {
  if (media.id !== mediaId || media.meetingId !== meetingId) {
    throw new Error('Core returned a media record for a different resource.')
  }
  return media
}

function mediaFailure(media: MeetingMedia): MediaUploadError {
  const reason =
    media.failureCode === 'MEDIA_FORMAT_UNSUPPORTED'
      ? 'Core rejected the audio container or codec. Use WAV, MP3, or AAC in M4A.'
      : media.failureCode === 'MEDIA_UNREADABLE'
        ? 'Core could not read this recording. Verify the file and export it again.'
        : media.failureCode === 'MEDIA_SIZE_INVALID'
          ? 'Core rejected the recording size. Check the file and upload limit.'
          : media.failureCode === 'MEDIA_CONTENT_TYPE_MISMATCH'
            ? 'Core rejected the storage content type for this recording.'
            : 'Core did not accept this media upload.'
  const presentationKey =
    media.failureCode === 'MEDIA_FORMAT_UNSUPPORTED'
      ? 'media:formatRejected'
      : media.failureCode === 'MEDIA_UNREADABLE'
        ? 'media:unreadableRejected'
        : media.failureCode === 'MEDIA_SIZE_INVALID'
          ? 'media:sizeRejected'
          : media.failureCode === 'MEDIA_CONTENT_TYPE_MISMATCH'
            ? 'media:contentTypeRejected'
            : 'media:uploadNotAccepted'
  return new MediaUploadError(reason, {
    mediaId: media.id,
    presentationKey,
  })
}

function isUncertainCoreError(error: unknown): boolean {
  return (
    (error instanceof CoreApiError &&
      (error.kind === 'network' || error.recoveryOutcome === 'uncertain')) ||
    error instanceof TypeError
  )
}

function newIdempotencyKey(): string {
  if (typeof crypto?.randomUUID !== 'function') {
    throw new MediaPresentationError(
      'This browser cannot create a safe operation identity.',
      'media:safeIdentityUnavailable'
    )
  }
  return crypto.randomUUID()
}

async function reconcileAfterUncertainMediaMutation(
  meetingId: string,
  mediaId: string,
  cause: unknown,
  signal?: AbortSignal
): Promise<MeetingMedia> {
  if (signal?.aborted) throw new MediaUploadCancelledError()
  try {
    const media = await getMeetingMedia(meetingId, mediaId, signal)
    if (media.status === 'AVAILABLE') return media
    if (media.status === 'REJECTED' || media.status === 'FAILED') {
      throw mediaFailure(media)
    }
  } catch (error) {
    if (error instanceof MediaUploadError && error.outcome === 'failed') {
      throw error
    }
  }
  throw new MediaUploadError(
    'The media operation outcome is uncertain. Check the media status before trying another upload.',
    { outcome: 'uncertain', mediaId, cause }
  )
}

async function finalizeMediaUpload(
  meetingId: string,
  mediaId: string,
  signal?: AbortSignal,
  onUncertain?: () => void
): Promise<MeetingMedia> {
  let response: unknown
  try {
    response = signal
      ? await coreApi.post<unknown>(
          mediaItemPath(meetingId, mediaId) + '/finalize',
          undefined,
          { signal }
        )
      : await coreApi.post<unknown>(
          mediaItemPath(meetingId, mediaId) + '/finalize'
        )
  } catch (error) {
    if (error instanceof MediaUploadCancelledError || signal?.aborted) {
      throw new MediaUploadCancelledError()
    }
    if (isUncertainCoreError(error)) {
      onUncertain?.()
      return reconcileAfterUncertainMediaMutation(
        meetingId,
        mediaId,
        error,
        signal
      )
    }
    throw error
  }

  const finalized = assertMediaBinding(readMedia(response), meetingId, mediaId)
  if (finalized.status === 'AVAILABLE') return finalized
  if (finalized.status === 'REJECTED' || finalized.status === 'FAILED') {
    throw mediaFailure(finalized)
  }
  throw new MediaUploadError(
    'Core has not confirmed this media as available after finalization.',
    {
      outcome: 'uncertain',
      mediaId,
      presentationKey: 'media:finalizationUnconfirmed',
    }
  )
}

async function readMediaForUploadRecovery(
  meetingId: string,
  mediaId: string,
  signal?: AbortSignal
): Promise<MeetingMedia> {
  try {
    return await getMeetingMedia(meetingId, mediaId, signal)
  } catch (error) {
    if (isUncertainCoreError(error)) {
      throw new MediaUploadError(
        'The media recovery status could not be confirmed. Check the same media intent before trying another upload.',
        {
          outcome: 'uncertain',
          mediaId,
          cause: error,
          presentationKey: 'media:recoveryUnconfirmed',
        }
      )
    }
    throw error
  }
}

export function meetingMediaQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['meeting-media', meetingId],
    queryFn: async ({ signal }) =>
      mediaSchema
        .array()
        .parse(await coreApi.get<unknown>(mediaPath(meetingId), { signal })),
    retry: false,
  })
}

function mediaPath(meetingId: string): string {
  return '/meetings/' + encodeURIComponent(meetingId) + '/media'
}

function mediaItemPath(meetingId: string, mediaId: string): string {
  return `${mediaPath(meetingId)}/${encodeURIComponent(mediaId)}`
}

export async function getMeetingMedia(
  meetingId: string,
  mediaId: string,
  signal?: AbortSignal
): Promise<MeetingMedia> {
  const response = signal
    ? await coreApi.get<unknown>(mediaItemPath(meetingId, mediaId), {
        signal,
      })
    : await coreApi.get<unknown>(mediaItemPath(meetingId, mediaId))
  return assertMediaBinding(readMedia(response), meetingId, mediaId)
}

export async function uploadMeetingFile(
  meetingId: string,
  file: File,
  sourceType: 'UPLOAD' | 'RECORDING' = 'UPLOAD',
  options: MediaUploadOptions = {}
): Promise<MeetingMedia> {
  const declaration = validateMeetingAudioFile(file)
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey()
  let intent: MediaUploadIntent
  const assertCanContinue = () => {
    if (options.signal?.aborted) throw new MediaUploadCancelledError()
    options.canContinue?.()
  }

  try {
    assertCanContinue()
    options.onRequestStart?.()
    const response = await coreApi.post<unknown>(
      mediaPath(meetingId) + '/uploads',
      {
        sourceType,
        originalFilename: declaration.filename,
        contentType: declaration.contentType,
        expectedSizeBytes: file.size,
      },
      {
        headers: { 'Idempotency-Key': idempotencyKey },
        ...(options.signal ? { signal: options.signal } : {}),
      }
    )
    intent = readUploadIntent(response)
  } catch (error) {
    if (error instanceof MediaUploadCancelledError || options.signal?.aborted) {
      throw new MediaUploadCancelledError()
    }
    if (isUncertainCoreError(error)) {
      throw new MediaUploadError(
        'The upload intent outcome is uncertain. Retry this same operation explicitly or choose a new file.',
        {
          outcome: 'uncertain',
          cause: error,
          presentationKey: 'media:intentUncertain',
        }
      )
    }
    throw error
  }

  if (intent.mediaId === '' || !uuidPattern(intent.mediaId)) {
    throw new Error('Core returned an invalid media identity.')
  }
  if (options.recovery && intent.mediaId !== options.recovery.mediaId) {
    throw new MediaUploadError(
      'Core returned a different media identity for the unresolved submission.',
      {
        outcome: 'uncertain',
        mediaId: options.recovery.mediaId,
        presentationKey: 'media:identityMismatch',
      }
    )
  }
  options.onMediaIdentity?.(intent.mediaId)
  if (
    intent.requiredContentType !== declaration.canonicalContentType ||
    !['audio/wav', 'audio/mpeg', 'audio/mp4'].includes(
      intent.requiredContentType
    )
  ) {
    throw new Error(
      'Core returned an incompatible required media content type.'
    )
  }

  if (intent.status === 'AVAILABLE') {
    assertCanContinue()
    options.onPhase?.('available-replay')
    let media: MeetingMedia
    try {
      media = await getMeetingMedia(meetingId, intent.mediaId, options.signal)
    } catch (error) {
      if (isUncertainCoreError(error)) {
        throw new MediaUploadError(
          'The available media replay could not be confirmed by read-back.',
          {
            outcome: 'uncertain',
            mediaId: intent.mediaId,
            cause: error,
            presentationKey: 'media:replayUnconfirmed',
          }
        )
      }
      throw error
    }
    if (media.status !== 'AVAILABLE') {
      throw new MediaUploadError(
        'Core reported an available replay but did not confirm available media.',
        {
          outcome: 'uncertain',
          mediaId: intent.mediaId,
          presentationKey: 'media:replayNotAvailable',
        }
      )
    }
    options.onPhase?.('available')
    return media
  }

  if (intent.status === 'REJECTED' || intent.status === 'FAILED') {
    throw new MediaUploadError(
      intent.status === 'REJECTED'
        ? 'Core rejected this media upload intent.'
        : 'Core reported that this media upload failed.',
      {
        mediaId: intent.mediaId,
        presentationKey:
          intent.status === 'REJECTED'
            ? 'media:intentRejected'
            : 'media:intentFailed',
      }
    )
  }

  const knownPhase = options.recovery?.phase
  if (
    options.recovery &&
    knownPhase !== null &&
    knownPhase !== undefined &&
    knownPhase !== 'intent-created'
  ) {
    assertCanContinue()
    options.onPhase?.('reconciling')
    const current = await readMediaForUploadRecovery(
      meetingId,
      intent.mediaId,
      options.signal
    )
    if (current.status === 'AVAILABLE') {
      options.onPhase?.('available')
      return current
    }
    if (current.status === 'REJECTED' || current.status === 'FAILED') {
      throw mediaFailure(current)
    }

    assertCanContinue()
    options.onPhase?.('finalizing')
    try {
      const finalized = await finalizeMediaUpload(
        meetingId,
        intent.mediaId,
        options.signal,
        () => options.onPhase?.('reconciling')
      )
      options.onPhase?.('available')
      return finalized
    } catch (error) {
      if (error instanceof CoreApiError && error.status === 409) {
        throw new MediaUploadError(
          'The existing media intent is still pending. Its transfer outcome has not been confirmed; do not create a new upload yet.',
          {
            outcome: 'uncertain',
            mediaId: intent.mediaId,
            cause: error,
            presentationKey: 'media:intentPending',
          }
        )
      }
      throw error
    }
  }

  if (!intent.uploadUrl || !intent.expiresAt) {
    throw new Error('Core returned an incomplete pending media intent.')
  }
  if (Date.parse(intent.expiresAt) <= Date.now()) {
    throw new MediaUploadError('The media upload capability has expired.', {
      mediaId: intent.mediaId,
      presentationKey: 'media:uploadCapabilityExpired',
    })
  }

  options.onPhase?.('intent-created')
  assertCanContinue()
  const uploadUrl = resolveMediaCapability(
    intent.uploadUrl,
    'PUT',
    meetingId,
    intent.mediaId
  )
  assertCanContinue()
  options.onPhase?.('storage-uploading')

  let response: Response
  try {
    response = await (options.uploadTransport ?? defaultMediaTransport)(
      uploadUrl,
      {
        method: 'PUT',
        body: file,
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': intent.requiredContentType },
        ...(options.signal ? { signal: options.signal } : {}),
      }
    )
  } catch (error) {
    if (error instanceof MediaUploadCancelledError || options.signal?.aborted) {
      throw new MediaUploadCancelledError()
    }
    options.onPhase?.('reconciling')
    return await reconcileAfterUncertainMediaMutation(
      meetingId,
      intent.mediaId,
      error,
      options.signal
    )
  }
  if (!response.ok) {
    throw new MediaUploadError(
      `Object storage upload failed (${response.status}). The file was not finalized.`,
      {
        mediaId: intent.mediaId,
        presentationKey: 'media:storageTransferFailed',
        presentationValues: { status: response.status },
      }
    )
  }
  options.onPhase?.('storage-uploaded')
  assertCanContinue()
  options.onPhase?.('finalizing')

  const bound = await finalizeMediaUpload(
    meetingId,
    intent.mediaId,
    options.signal,
    () => options.onPhase?.('reconciling')
  )
  options.onPhase?.('available')
  return bound
}

function defaultMediaTransport(url: string, init: RequestInit) {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('A browser media transport is required.')
  }
  return globalThis.fetch(url, init)
}

export async function reconcileMeetingMedia(
  meetingId: string,
  mediaId: string,
  signal?: AbortSignal
): Promise<MeetingMedia> {
  const media = await getMeetingMedia(meetingId, mediaId, signal)
  if (media.status === 'AVAILABLE') return media
  if (media.status === 'REJECTED' || media.status === 'FAILED') {
    throw mediaFailure(media)
  }
  throw new MediaUploadError(
    'Core has not confirmed this media as available. Do not upload the same operation again yet.',
    {
      outcome: 'uncertain',
      mediaId,
      presentationKey: 'media:mediaNotConfirmed',
    }
  )
}

export async function requestMediaAccess(
  meetingId: string,
  mediaId: string,
  options: MediaCapabilityResolutionOptions & { signal?: AbortSignal } = {}
) {
  const media = await getMeetingMedia(meetingId, mediaId, options.signal)
  if (media.status !== 'AVAILABLE') {
    throw new MediaPresentationError(
      'Only available media can be opened.',
      'media:availableMediaOnly'
    )
  }

  const response = options.signal
    ? await coreApi.post<unknown>(
        mediaItemPath(meetingId, mediaId) + '/access-url',
        undefined,
        { signal: options.signal }
      )
    : await coreApi.post<unknown>(
        mediaItemPath(meetingId, mediaId) + '/access-url'
      )
  const parsed = mediaAccessSchema.safeParse(response)
  if (!parsed.success || Date.parse(parsed.data.expiresAt) <= Date.now()) {
    throw new Error(
      'Core returned an expired or invalid media access capability.'
    )
  }
  return {
    url: resolveMediaCapability(
      parsed.data.url,
      'GET',
      meetingId,
      mediaId,
      options
    ),
    expiresAt: parsed.data.expiresAt,
  }
}

export async function fetchMediaCapability(
  url: string,
  options: MediaCapabilityFetchOptions = {}
): Promise<Blob> {
  let response: Response
  try {
    response = await (options.transport ?? defaultMediaTransport)(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch {
    throw new MediaPresentationError(
      'The media access capability could not be used.',
      'media:accessUnavailable'
    )
  }
  if (!response.ok) {
    throw new Error(`Media access failed (${response.status}).`)
  }
  const contentType = normalizeContentType(
    response.headers.get('content-type') ?? ''
  )
  if (
    !Object.values(uploadMimes).some((types) => types.includes(contentType))
  ) {
    throw new MediaPresentationError(
      'Media access returned an unsupported content type.',
      'media:accessUnsupportedType'
    )
  }
  try {
    return await response.blob()
  } catch {
    throw new MediaPresentationError(
      'The media response could not be read.',
      'media:mediaReadFailed'
    )
  }
}
