import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import type { MeetingMedia } from './media-api'
import {
  MeetingSessionProvider,
  useMeetingSession,
} from './meeting-session-context'

const mediaMocks = vi.hoisted(() => ({
  fetchMediaCapability: vi.fn(),
  requestMediaAccess: vi.fn(),
}))

vi.mock('./media-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./media-api')>()
  return {
    ...actual,
    fetchMediaCapability: mediaMocks.fetchMediaCapability,
    meetingMediaQuery: (meetingId: string) => ({
      queryKey: ['meeting-media', meetingId],
      queryFn: async () => [],
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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
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
      <output data-testid='playback-state'>
        {session.playback.sourceMediaId ?? 'none'}:{session.playback.status}
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

    await userEvent.click(
      screen.getByRole('button', { name: 'Play first source' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Play second source' })
    )

    await expect
      .element(screen.getByTestId('playback-state'))
      .toHaveTextContent(`${secondMediaId}:loading`)
    firstFetch.resolve(new Blob(['first'], { type: 'audio/wav' }))
    await expect
      .element(screen.getByTestId('playback-state'))
      .toHaveTextContent(`${secondMediaId}:loading`)
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
})
