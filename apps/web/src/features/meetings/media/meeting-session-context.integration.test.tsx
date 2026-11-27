import { act, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { setUiLanguage } from '@/lib/i18n'
import { featureValidationMessage } from '@/lib/i18n/presentation'
import type { MeetingMedia } from './media-api'
import {
  MeetingSessionProvider,
  useMeetingSession,
} from './meeting-session-context'
import { PlaybackControls } from './playback-controls'

const mediaMocks = vi.hoisted(() => ({
  fetchMediaCapability: vi.fn(),
  requestMediaAccess: vi.fn(),
  sources: [] as Array<Record<string, unknown>>,
}))

vi.mock('./media-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./media-api')>()
  return {
    ...actual,
    fetchMediaCapability: mediaMocks.fetchMediaCapability,
    meetingMediaQuery: (meetingId: string) => ({
      queryKey: ['meeting-media', meetingId],
      queryFn: async () => mediaMocks.sources,
      retry: false,
    }),
    requestMediaAccess: mediaMocks.requestMediaAccess,
  }
})

const meetingId = '11111111-1111-4111-8111-111111111111'
const firstMediaId = '22222222-2222-4222-8222-222222222222'
const secondMediaId = '33333333-3333-4333-8333-333333333333'
const nextMeetingId = '44444444-4444-4444-8444-444444444444'

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
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

function playableWaveFile(durationMs = 1000): Blob {
  const sampleRate = 8000
  const channelCount = 1
  const bitsPerSample = 16
  const frameCount = Math.floor((sampleRate * durationMs) / 1000)
  const dataSize = frameCount * channelCount * (bitsPerSample / 8)
  const bytes = new Uint8Array(44 + dataSize)
  const view = new DataView(bytes.buffer)
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index)
    }
  }

  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * (bitsPerSample / 8), true)
  view.setUint16(32, channelCount * (bitsPerSample / 8), true)
  view.setUint16(34, bitsPerSample, true)
  writeText(36, 'data')
  view.setUint32(40, dataSize, true)

  return new Blob([bytes.buffer], { type: 'audio/wav' })
}

function media(id: string, filename: string): MeetingMedia {
  return {
    id,
    meetingId,
    sourceType: 'UPLOAD',
    status: 'AVAILABLE',
    originalFilename: filename,
    contentType: 'audio/wav',
    sizeBytes: 3,
    durationMs: 1000,
    sha256: null,
    createdAt: '2030-01-01T00:00:00Z',
    availableAt: '2030-01-01T00:00:01Z',
    failureCode: null,
  }
}

function PlaybackHarness() {
  const session = useMeetingSession()
  return (
    <>
      <button
        type='button'
        onClick={() =>
          void session.playRemoteMedia(media(firstMediaId, 'first.wav'))
        }
      >
        Play first source
      </button>
      <button
        type='button'
        onClick={() =>
          void session.playRemoteMedia(media(secondMediaId, 'second.wav'))
        }
      >
        Play second source
      </button>
      <button type='button' onClick={() => void session.play()}>
        Play audio
      </button>
      <button type='button' onClick={() => session.seek(5000)}>
        Seek to five seconds
      </button>
      <button
        type='button'
        onClick={() =>
          void session.seekToSource(firstMediaId, 700, 'transcript-a')
        }
      >
        Seek from transcript A
      </button>
      <button
        type='button'
        onClick={() =>
          void session.seekToSource(firstMediaId, 300, 'transcript-b')
        }
      >
        Seek from transcript B
      </button>
      <button
        type='button'
        onClick={() => session.setTranscriptReviewDirty(true)}
      >
        Mark transcript review dirty
      </button>
      <button
        type='button'
        onClick={() => session.cancelPendingSeek('transcript-a')}
      >
        Cancel transcript A
      </button>
      <PlaybackControls />
      <output data-testid='pending-seek'>
        {session.playback.pendingSeek?.ownerKey ?? 'none'}
      </output>
      <output data-testid='playback-state'>
        {session.playback.sourceMediaId ?? 'none'}:{session.playback.status}:
        {session.playback.currentTimeMs}
      </output>
      <output data-testid='playback-error'>
        {session.playback.error ?? 'none'}
      </output>
      <output data-testid='media-state'>
        {session.media.isSuccess ? 'ready' : 'pending'}
      </output>
    </>
  )
}

function ScopeHarness() {
  const [currentMeetingId, setCurrentMeetingId] = useState(meetingId)
  return (
    <>
      <button type='button' onClick={() => setCurrentMeetingId(nextMeetingId)}>
        Switch meeting
      </button>
      <MeetingSessionProvider
        meetingId={currentMeetingId}
        fallbackCapabilities={{
          canReadMedia: false,
          canReadProcessing: false,
        }}
      >
        <ScopeContent />
      </MeetingSessionProvider>
    </>
  )
}

function ScopeContent() {
  const session = useMeetingSession()
  return (
    <>
      <button
        type='button'
        onClick={() =>
          session.selectImportedFile(
            new File(['audio'], 'local-source.wav', { type: 'audio/wav' })
          )
        }
      >
        Select local source
      </button>
      <output data-testid='selected-file'>
        {session.importedMedia.file?.name ?? 'empty'}
      </output>
    </>
  )
}

describe('meeting session ownership boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mediaMocks.sources = [
      {
        ...media(firstMediaId, 'first.wav'),
        status: 'AVAILABLE',
      },
      {
        ...media(secondMediaId, 'second.wav'),
        status: 'AVAILABLE',
      },
    ]
  })

  it('keeps a newer playback source authoritative when an older fetch resolves late', async () => {
    const firstFetch = deferred<Blob>()
    const secondFetch = deferred<Blob>()
    mediaMocks.requestMediaAccess.mockImplementation(
      async (_meetingId: string, sourceMediaId: string) => ({
        url: sourceMediaId,
        expiresAt: '2030-01-01T00:05:00Z',
      })
    )
    mediaMocks.fetchMediaCapability.mockImplementation((url: string) =>
      url === firstMediaId ? firstFetch.promise : secondFetch.promise
    )

    const screen = await render(
      <QueryClientProvider client={queryClient()}>
        <MeetingSessionProvider
          meetingId={meetingId}
          fallbackCapabilities={{
            canReadMedia: true,
            canReadProcessing: false,
          }}
        >
          <PlaybackHarness />
        </MeetingSessionProvider>
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByTestId('media-state'))
      .toHaveTextContent('ready')
    await userEvent.click(
      screen.getByRole('button', { name: 'Play first source' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Play second source' })
    )

    await expect
      .element(screen.getByTestId('playback-state'))
      .toHaveTextContent(`${secondMediaId}:loading`)
    firstFetch.resolve(playableWaveFile())
    await expect
      .element(screen.getByTestId('playback-state'))
      .toHaveTextContent(`${secondMediaId}:loading`)
  })

  it('cancels only the obsolete transcript seek while the source loads', async () => {
    const fetch = deferred<Blob>()
    mediaMocks.requestMediaAccess.mockResolvedValue({
      url: firstMediaId,
      expiresAt: '2030-01-01T00:05:00Z',
    })
    mediaMocks.fetchMediaCapability.mockReturnValue(fetch.promise)
    const screen = await render(
      <QueryClientProvider client={queryClient()}>
        <MeetingSessionProvider
          meetingId={meetingId}
          fallbackCapabilities={{
            canReadMedia: true,
            canReadProcessing: false,
          }}
        >
          <PlaybackHarness />
        </MeetingSessionProvider>
      </QueryClientProvider>
    )
    await expect
      .element(screen.getByTestId('media-state'))
      .toHaveTextContent('ready')
    await userEvent.click(
      screen.getByRole('button', { name: 'Seek from transcript A' })
    )
    await expect
      .element(screen.getByTestId('pending-seek'))
      .toHaveTextContent('transcript-a')
    await userEvent.click(
      screen.getByRole('button', { name: 'Seek from transcript B' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel transcript A' })
    )
    await expect
      .element(screen.getByTestId('pending-seek'))
      .toHaveTextContent('transcript-b')
    fetch.resolve(playableWaveFile())
    await expect
      .element(screen.getByTestId('pending-seek'))
      .toHaveTextContent('none')
    await expect
      .element(screen.getByTestId('playback-state'))
      .toHaveTextContent(':300')
    expect(mediaMocks.fetchMediaCapability).toHaveBeenCalledTimes(1)
  })

  it('ignores a late play failure from a source replaced during playback', async () => {
    mediaMocks.requestMediaAccess.mockImplementation(
      async (_meetingId: string, sourceMediaId: string) => ({
        url: sourceMediaId,
        expiresAt: '2030-01-01T00:05:00Z',
      })
    )
    mediaMocks.fetchMediaCapability.mockResolvedValue(playableWaveFile())
    const firstPlay = deferred<void>()
    const secondPlay = deferred<void>()
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockReturnValueOnce(firstPlay.promise)
      .mockReturnValueOnce(secondPlay.promise)

    const screen = await render(
      <QueryClientProvider client={queryClient()}>
        <MeetingSessionProvider
          meetingId={meetingId}
          fallbackCapabilities={{
            canReadMedia: true,
            canReadProcessing: false,
          }}
        >
          <PlaybackHarness />
        </MeetingSessionProvider>
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByTestId('media-state'))
      .toHaveTextContent('ready')
    await userEvent.click(
      screen.getByRole('button', { name: 'Play first source' })
    )
    await expect
      .element(screen.getByTestId('playback-state'))
      .toHaveTextContent(`${firstMediaId}:ready`)
    await userEvent.click(screen.getByRole('button', { name: 'Play audio' }))
    await expect.poll(() => play.mock.calls.length).toBe(1)

    await userEvent.click(
      screen.getByRole('button', { name: 'Play second source' })
    )
    await expect
      .element(screen.getByTestId('playback-state'))
      .toHaveTextContent(`${secondMediaId}:ready`)
    await userEvent.click(screen.getByRole('button', { name: 'Play audio' }))
    await expect.poll(() => play.mock.calls.length).toBe(2)

    firstPlay.reject(new Error('The old source failed to start.'))
    await expect
      .element(screen.getByTestId('playback-state'))
      .toHaveTextContent(`${secondMediaId}:ready`)
  })

  it('does not report a failed seek as a confirmed playback position', async () => {
    mediaMocks.requestMediaAccess.mockImplementation(
      async (_meetingId: string, sourceMediaId: string) => ({
        url: sourceMediaId,
        expiresAt: '2030-01-01T00:05:00Z',
      })
    )
    mediaMocks.fetchMediaCapability.mockResolvedValue(playableWaveFile())

    const screen = await render(
      <QueryClientProvider client={queryClient()}>
        <MeetingSessionProvider
          meetingId={meetingId}
          fallbackCapabilities={{
            canReadMedia: true,
            canReadProcessing: false,
          }}
        >
          <PlaybackHarness />
        </MeetingSessionProvider>
      </QueryClientProvider>
    )
    await expect
      .element(screen.getByTestId('media-state'))
      .toHaveTextContent('ready')
    await userEvent.click(
      screen.getByRole('button', { name: 'Play first source' })
    )
    await expect
      .element(screen.getByTestId('playback-state'))
      .toHaveTextContent(`${firstMediaId}:ready`)

    const audio = document.querySelector('audio')
    expect(audio).not.toBeNull()
    Object.defineProperty(audio, 'duration', {
      configurable: true,
      value: 10,
    })
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: () => {
        throw new Error('The browser rejected this seek.')
      },
    })

    await userEvent.click(
      screen.getByRole('button', { name: 'Seek to five seconds' })
    )
    await expect
      .element(screen.getByTestId('playback-state'))
      .toHaveTextContent(new RegExp(`${firstMediaId}:ready:\\s*0`))
  })

  it('preserves a real browser playback error for malformed audio', async () => {
    mediaMocks.requestMediaAccess.mockImplementation(
      async (_meetingId: string, sourceMediaId: string) => ({
        url: sourceMediaId,
        expiresAt: '2030-01-01T00:05:00Z',
      })
    )
    mediaMocks.fetchMediaCapability.mockResolvedValue(
      new Blob(['not a WAV file'], { type: 'audio/wav' })
    )

    const screen = await render(
      <QueryClientProvider client={queryClient()}>
        <MeetingSessionProvider
          meetingId={meetingId}
          fallbackCapabilities={{
            canReadMedia: true,
            canReadProcessing: false,
          }}
        >
          <PlaybackHarness />
        </MeetingSessionProvider>
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Play first source' })
    )
    await expect
      .element(screen.getByTestId('playback-error'))
      .toHaveTextContent(featureValidationMessage('media:sourcePlayFailed'))
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('The selected audio source could not be played.')
    try {
      await act(async () => {
        await setUiLanguage('vi')
      })
      await expect
        .element(screen.getByRole('alert'))
        .toHaveTextContent('Không thể phát audio đã chọn.')
      await expect
        .element(screen.getByTestId('playback-state'))
        .toHaveTextContent(`${firstMediaId}:error`)
      expect(mediaMocks.requestMediaAccess).toHaveBeenCalledOnce()
    } finally {
      await act(async () => {
        await setUiLanguage('en')
      })
    }
  })

  it('clears imported meeting resources when the provider scope changes', async () => {
    const screen = await render(
      <QueryClientProvider client={queryClient()}>
        <ScopeHarness />
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Select local source' })
    )
    await expect
      .element(screen.getByTestId('selected-file'))
      .toHaveTextContent('local-source.wav')

    await userEvent.click(
      screen.getByRole('button', { name: 'Switch meeting' })
    )
    await expect
      .element(screen.getByTestId('selected-file'))
      .toHaveTextContent('empty')
  })

  it('protects unsaved transcript review work from browser unload', async () => {
    const screen = await render(
      <QueryClientProvider client={queryClient()}>
        <MeetingSessionProvider
          meetingId={meetingId}
          fallbackCapabilities={{
            canReadMedia: true,
            canReadProcessing: false,
          }}
        >
          <PlaybackHarness />
        </MeetingSessionProvider>
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Mark transcript review dirty' })
    )
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})
