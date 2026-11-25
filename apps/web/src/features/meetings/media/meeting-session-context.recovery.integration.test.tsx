import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError } from '@/lib/core-api'
import {
  currentUserQueryKey,
  type AuthContext,
} from '@/features/auth/session/current-user'
import type { MeetingView } from '../data/detail-api'
import { MeetingAuthorizationProvider } from '../meeting-authorization-context'
import { MediaUploadError, type MeetingMedia } from './media-api'
import {
  MeetingSessionProvider,
  useMeetingSession,
} from './meeting-session-context'

const mediaMocks = vi.hoisted(() => ({
  uploadMeetingFile: vi.fn(),
  reconcileMeetingMedia: vi.fn(),
}))

vi.mock('./media-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./media-api')>()
  return {
    ...actual,
    meetingMediaQuery: (meetingId: string) => ({
      queryKey: ['meeting-media', meetingId],
      queryFn: async () => [],
      retry: false,
    }),
    uploadMeetingFile: mediaMocks.uploadMeetingFile,
    reconcileMeetingMedia: mediaMocks.reconcileMeetingMedia,
  }
})

const meetingId = '11111111-1111-4111-8111-111111111111'
const actorId = '22222222-2222-4222-8222-222222222222'
const mediaId = '33333333-3333-4333-8333-333333333333'

const identity: AuthContext = {
  userId: actorId,
  email: 'organizer@example.com',
  displayName: 'Meeting organizer',
  globalRole: 'EMPLOYEE',
  accountStatus: 'ACTIVE',
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: false, unitIds: [] },
  session: {
    id: '44444444-4444-4444-8444-444444444444',
    clientType: 'WEB',
    createdAt: '2030-01-01T00:00:00Z',
    lastSeenAt: null,
    absoluteExpiresAt: '2030-01-02T00:00:00Z',
  },
}

const meeting: MeetingView = {
  id: meetingId,
  title: 'Upload recovery meeting',
  description: null,
  organizerUserId: actorId,
  roomId: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
  status: 'ENDED',
  startedAt: null,
  endedAt: '2030-01-01T01:00:00Z',
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: actorId,
  createdAt: '2030-01-01T00:00:00Z',
  updatedAt: '2030-01-01T01:00:00Z',
}

const availableMedia: MeetingMedia = {
  id: mediaId,
  meetingId,
  sourceType: 'UPLOAD',
  status: 'AVAILABLE',
  originalFilename: 'source.wav',
  contentType: 'audio/wav',
  sizeBytes: 4,
  durationMs: 1000,
  sha256: null,
  createdAt: '2030-01-01T00:00:00Z',
  availableAt: '2030-01-01T00:00:01Z',
  failureCode: null,
}

type UploadCall = {
  signal: AbortSignal
  idempotencyKey: string
  recovery?: { mediaId: string; phase: string | null }
  onMediaIdentity?: (id: string) => void
  onPhase?: (phase: string) => void
  resolve: (media: MeetingMedia) => void
  reject: (reason?: unknown) => void
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function RecoveryHarness() {
  const session = useMeetingSession()
  const selectedFile = new File(['audio'], 'source.wav', { type: 'audio/wav' })
  return (
    <>
      <button
        type='button'
        onClick={() => session.selectImportedFile(selectedFile)}
      >
        Select source
      </button>
      <button type='button' onClick={() => void session.submitImportedMedia()}>
        Submit source
      </button>
      <button
        type='button'
        onClick={() => void session.reconcileImportedMedia()}
      >
        Reconcile source
      </button>
      <output data-testid='selected-file'>
        {session.importedMedia.file?.name ?? 'empty'}
      </output>
      <output data-testid='submission-state'>
        {session.importedMedia.status}:
        {session.importedMedia.uncertainMediaId ?? 'no-media'}
      </output>
      <output data-testid='scope-state'>
        {session.authorization?.scopeReady ? 'ready' : 'pending'}
      </output>
    </>
  )
}

async function renderRecovery() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(currentUserQueryKey, identity)
  let sessionFailure = false
  const getSpy = vi.spyOn(
    await import('@/lib/core-api').then((module) => module.coreApi),
    'get'
  )
  getSpy.mockImplementation(async (url) => {
    if (url === '/auth/me') {
      if (sessionFailure) {
        throw new CoreApiError({
          message: 'Temporary session verification failure.',
          kind: 'network',
        })
      }
      return identity
    }
    if (url.endsWith('/processing-jobs')) return []
    throw new Error(`Unexpected GET ${url}`)
  })
  vi.spyOn(
    await import('@/lib/core-api').then((module) => module.coreApi),
    'getWithMetaAndEtag'
  ).mockResolvedValue({ data: meeting, meta: {}, etag: '"meeting-etag"' })
  vi.spyOn(
    await import('@/lib/core-api').then((module) => module.coreApi),
    'getWithMeta'
  ).mockResolvedValue({ data: [], meta: {} })

  const screen = await render(
    <QueryClientProvider client={client}>
      <MeetingAuthorizationProvider meetingId={meetingId}>
        <MeetingSessionProvider meetingId={meetingId}>
          <RecoveryHarness />
        </MeetingSessionProvider>
      </MeetingAuthorizationProvider>
    </QueryClientProvider>
  )
  return {
    client,
    screen,
    failSessionVerification: () => {
      sessionFailure = true
      return client.invalidateQueries({ queryKey: currentUserQueryKey })
    },
    restoreSession: () => {
      sessionFailure = false
      client.setQueryData(currentUserQueryKey, identity)
    },
  }
}

describe('meeting session upload intent recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    uploadCalls.length = 0
    mediaMocks.uploadMeetingFile.mockImplementation(
      (
        _meetingId: string,
        _file: File,
        _sourceType: string,
        options: {
          idempotencyKey: string
          signal: AbortSignal
          recovery?: { mediaId: string; phase: string | null }
          onRequestStart?: () => void
          onMediaIdentity?: (id: string) => void
          onPhase?: (phase: string) => void
        }
      ) => {
        options.onRequestStart?.()
        const result = deferred<MeetingMedia>()
        const call: UploadCall = {
          signal: options.signal,
          idempotencyKey: options.idempotencyKey,
          recovery: options.recovery,
          onMediaIdentity: options.onMediaIdentity,
          onPhase: options.onPhase,
          resolve: result.resolve,
          reject: result.reject,
        }
        uploadCalls.push(call)
        return result.promise
      }
    )
  })

  const uploadCalls: UploadCall[] = []

  it('replays an aborted execution with a fresh controller and stable intent, ignoring the obsolete completion', async () => {
    const { screen, failSessionVerification, restoreSession } =
      await renderRecovery()
    await userEvent.click(screen.getByRole('button', { name: 'Select source' }))
    await userEvent.click(screen.getByRole('button', { name: 'Submit source' }))

    await expect.poll(() => uploadCalls.length).toBe(1)
    const first = uploadCalls[0]!
    first.onMediaIdentity?.(mediaId)
    first.onPhase?.('storage-uploading')

    await failSessionVerification()
    await expect.poll(() => first.signal.aborted).toBe(true)
    await expect
      .element(screen.getByTestId('submission-state'))
      .toHaveTextContent('uncertain:')

    restoreSession()
    await expect
      .element(screen.getByTestId('scope-state'))
      .toHaveTextContent('ready')
    await userEvent.click(screen.getByRole('button', { name: 'Submit source' }))
    await expect.poll(() => uploadCalls.length).toBe(2)
    const replay = uploadCalls[1]!

    expect(replay.signal).not.toBe(first.signal)
    expect(replay.signal.aborted).toBe(false)
    expect(replay.idempotencyKey).toBe(first.idempotencyKey)
    expect(replay.recovery).toEqual({
      mediaId,
      phase: 'storage-uploading',
    })

    first.onMediaIdentity?.('55555555-5555-4555-8555-555555555555')
    first.resolve(availableMedia)
    await expect
      .element(screen.getByTestId('submission-state'))
      .toHaveTextContent('submitting:')

    replay.resolve(availableMedia)
    await expect
      .element(screen.getByTestId('submission-state'))
      .toHaveTextContent('success:')
  })

  it('retains uncertainty on a failed status request but resolves authoritative media rejection', async () => {
    mediaMocks.reconcileMeetingMedia
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockRejectedValueOnce(
        new MediaUploadError('Core rejected the media.', {
          mediaId,
          outcome: 'failed',
        })
      )
    const { screen } = await renderRecovery()
    await userEvent.click(screen.getByRole('button', { name: 'Select source' }))
    await userEvent.click(screen.getByRole('button', { name: 'Submit source' }))
    await expect.poll(() => uploadCalls.length).toBe(1)
    uploadCalls[0]!.reject(
      new MediaUploadError('Outcome uncertain', {
        mediaId,
        outcome: 'uncertain',
      })
    )
    await expect
      .element(screen.getByTestId('submission-state'))
      .toHaveTextContent('uncertain:' + mediaId)

    await userEvent.click(
      screen.getByRole('button', { name: 'Reconcile source' })
    )
    await expect
      .poll(() => mediaMocks.reconcileMeetingMedia.mock.calls.length)
      .toBe(1)
    await expect
      .element(screen.getByTestId('submission-state'))
      .toHaveTextContent('uncertain:' + mediaId)

    await userEvent.click(
      screen.getByRole('button', { name: 'Reconcile source' })
    )
    await expect
      .element(screen.getByTestId('submission-state'))
      .toHaveTextContent('failed:no-media')
    await expect
      .element(screen.getByTestId('selected-file'))
      .toHaveTextContent('source.wav')
  })

  it('releases protected local media when content access is denied but metadata remains readable', async () => {
    const { client, screen } = await renderRecovery()
    await expect
      .element(screen.getByTestId('scope-state'))
      .toHaveTextContent('ready')
    await userEvent.click(screen.getByRole('button', { name: 'Select source' }))
    await expect
      .element(screen.getByTestId('selected-file'))
      .toHaveTextContent('source.wav')

    client.setQueryData(['meetings', 'detail', meetingId], {
      meeting: { ...meeting, organizerUserId: mediaId },
      etag: '"updated-meeting"',
    })
    await expect
      .element(screen.getByTestId('selected-file'))
      .toHaveTextContent('empty')
    await expect
      .element(screen.getByTestId('scope-state'))
      .toHaveTextContent('ready')
  })
})
