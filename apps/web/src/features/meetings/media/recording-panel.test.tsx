import { StrictMode, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { RecordingPanel } from './recording-panel'

const mediaMocks = vi.hoisted(() => ({
  uploadMeetingFile: vi.fn(),
  reconcileMeetingMedia: vi.fn(),
}))
const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}))

vi.mock('./media-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./media-api')>()
  return {
    ...actual,
    uploadMeetingFile: mediaMocks.uploadMeetingFile,
    reconcileMeetingMedia: mediaMocks.reconcileMeetingMedia,
  }
})

vi.mock('sonner', () => ({
  toast: toastMocks,
}))

const meetingId = '11111111-1111-4111-8111-111111111111'

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

function renderPanel(strict = false) {
  const panel = (
    <QueryClientProvider client={queryClient()}>
      <RecordingPanel meetingId={meetingId} canRecordAudio canSubmitMedia />
    </QueryClientProvider>
  )
  return render(strict ? <StrictMode>{panel}</StrictMode> : panel)
}

function CapabilityHarness() {
  const [canRecordAudio, setCanRecordAudio] = useState(true)
  return (
    <>
      <button type='button' onClick={() => setCanRecordAudio(false)}>
        Revoke recording admission
      </button>
      <button type='button' onClick={() => setCanRecordAudio(true)}>
        Restore recording admission
      </button>
      <RecordingPanel
        meetingId={meetingId}
        canRecordAudio={canRecordAudio}
        canSubmitMedia
      />
    </>
  )
}

type RecorderOptions = {
  supported?: boolean
  getUserMedia?: ReturnType<typeof vi.fn>
  startError?: Error
}

function installRecorder(options: RecorderOptions = {}) {
  const track = { stop: vi.fn() }
  const getUserMedia =
    options.getUserMedia ??
    vi.fn().mockResolvedValue({
      getTracks: () => [track],
    })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })

  const supported = options.supported ?? true
  const startError = options.startError
  class FakeMediaRecorder {
    static isTypeSupported = vi.fn(() => supported)
    static instances: FakeMediaRecorder[] = []
    state: RecordingState = 'inactive'
    mimeType = 'audio/mp4;codecs=mp4a.40.2'
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null

    constructor() {
      FakeMediaRecorder.instances.push(this)
    }

    start() {
      if (startError) throw startError
      this.state = 'recording'
      this.ondataavailable?.({
        data: new Blob(['captured'], { type: 'audio/mp4' }),
      })
    }

    stop() {
      this.state = 'inactive'
      this.onstop?.()
    }
  }

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  return { getUserMedia, track, recorder: FakeMediaRecorder }
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

describe('RecordingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mediaMocks.uploadMeetingFile.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      status: 'AVAILABLE',
    })
  })

  it('does not request microphone access when no supported AAC recorder exists', async () => {
    const { getUserMedia } = installRecorder({ supported: false })
    const screen = await renderPanel()

    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )

    expect(getUserMedia).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith(
      expect.stringContaining('supported AAC-in-M4A')
    )
  })

  it('starts, stops, and retains explicit submission through StrictMode effect replay', async () => {
    const { getUserMedia, track, recorder } = installRecorder()
    const screen = await renderPanel(true)

    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )
    expect(getUserMedia).toHaveBeenCalledOnce()
    await expect
      .element(screen.getByText('Recording in progress…'))
      .toBeInTheDocument()
    expect(recorder.instances).toHaveLength(1)
    expect(mediaMocks.uploadMeetingFile).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByRole('button', { name: 'Stop recording' })
    )
    await expect
      .element(screen.getByText(/captured \(M4A\/AAC declaration\)/))
      .toBeInTheDocument()
    expect(track.stop).toHaveBeenCalled()
    expect(mediaMocks.uploadMeetingFile).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByRole('button', { name: 'Submit recording' })
    )
    expect(mediaMocks.uploadMeetingFile).toHaveBeenCalledOnce()
    expect(mediaMocks.uploadMeetingFile.mock.calls[0]?.[0]).toBe(meetingId)
    expect(mediaMocks.uploadMeetingFile.mock.calls[0]?.[2]).toBe('RECORDING')
    expect(mediaMocks.uploadMeetingFile.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    )
  })

  it('keeps recording local until explicit submit and stops tracks', async () => {
    const { getUserMedia, track } = installRecorder()
    const screen = await renderPanel()

    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(mediaMocks.uploadMeetingFile).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByRole('button', { name: 'Stop recording' })
    )
    await expect
      .element(screen.getByText(/captured \(M4A\/AAC declaration\)/))
      .toBeInTheDocument()
    expect(track.stop).toHaveBeenCalled()
    expect(mediaMocks.uploadMeetingFile).not.toHaveBeenCalled()
  })

  it('releases tracks when permission resolves after genuine unmount', async () => {
    const pending = deferred<{ getTracks: () => { stop: () => void }[] }>()
    const getUserMedia = vi.fn(() => pending.promise)
    const { track, recorder } = installRecorder({ getUserMedia })
    const screen = await renderPanel()

    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )
    screen.unmount()
    pending.resolve({ getTracks: () => [track] })

    await expect.poll(() => track.stop.mock.calls.length).toBeGreaterThan(0)
    expect(recorder.instances).toHaveLength(0)
    expect(mediaMocks.uploadMeetingFile).not.toHaveBeenCalled()
  })

  it('reports microphone permission failure without creating an upload', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValue(new Error('permission denied'))
    installRecorder({ getUserMedia })
    const screen = await renderPanel()

    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )

    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(toastMocks.error).toHaveBeenCalledWith(
      'Microphone access failed',
      expect.objectContaining({ description: 'permission denied' })
    )
    expect(mediaMocks.uploadMeetingFile).not.toHaveBeenCalled()
  })

  it('releases tracks when recorder startup fails', async () => {
    const { track } = installRecorder({
      startError: new Error('start failed'),
    })
    const screen = await renderPanel()

    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )

    expect(track.stop).toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith(
      'Recording could not be started',
      expect.objectContaining({ description: 'start failed' })
    )
    expect(mediaMocks.uploadMeetingFile).not.toHaveBeenCalled()
  })

  it('stops an active recorder when the component is genuinely unmounted', async () => {
    const { track } = installRecorder()
    const screen = await renderPanel()
    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )

    screen.unmount()

    expect(track.stop).toHaveBeenCalled()
    expect(mediaMocks.uploadMeetingFile).not.toHaveBeenCalled()
  })

  it('ignores recorder callbacks after genuine unmount', async () => {
    const { track, recorder } = installRecorder()
    const screen = await renderPanel()
    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )
    const instance = recorder.instances[0]
    const errorsBeforeUnmount = toastMocks.error.mock.calls.length

    screen.unmount()
    instance?.ondataavailable?.({
      data: new Blob(['late'], { type: 'audio/mp4' }),
    })
    instance?.onerror?.()
    instance?.onstop?.()

    expect(track.stop).toHaveBeenCalled()
    expect(toastMocks.error.mock.calls.length).toBe(errorsBeforeUnmount)
    expect(mediaMocks.uploadMeetingFile).not.toHaveBeenCalled()
  })

  it('keeps completed audio controls when recording admission is revoked', async () => {
    const { track } = installRecorder()
    const screen = await render(
      <QueryClientProvider client={queryClient()}>
        <CapabilityHarness />
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Stop recording' })
    )
    await expect
      .element(screen.getByText(/captured \(M4A\/AAC declaration\)/))
      .toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke recording admission' })
    )

    await expect
      .element(screen.getByRole('button', { name: 'Submit recording' }))
      .toBeInTheDocument()
    expect(track.stop).toHaveBeenCalled()
  })

  it('releases a permission stream when admission is revoked while awaiting permission', async () => {
    const pending = deferred<{ getTracks: () => { stop: () => void }[] }>()
    const getUserMedia = vi.fn(() => pending.promise)
    const { track, recorder } = installRecorder({ getUserMedia })
    const screen = await render(
      <QueryClientProvider client={queryClient()}>
        <CapabilityHarness />
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke recording admission' })
    )
    pending.resolve({ getTracks: () => [track] })

    await expect.poll(() => track.stop.mock.calls.length).toBeGreaterThan(0)
    expect(recorder.instances).toHaveLength(0)
    expect(mediaMocks.uploadMeetingFile).not.toHaveBeenCalled()
  })

  it('allows a new permission request after an invalidated request resolves', async () => {
    const first = deferred<{ getTracks: () => { stop: () => void }[] }>()
    const second = deferred<{ getTracks: () => { stop: () => void }[] }>()
    const firstTrack = { stop: vi.fn() }
    const secondTrack = { stop: vi.fn() }
    const getUserMedia = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const { recorder } = installRecorder({ getUserMedia })
    const screen = await render(
      <QueryClientProvider client={queryClient()}>
        <CapabilityHarness />
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke recording admission' })
    )
    first.resolve({ getTracks: () => [firstTrack] })
    await expect
      .poll(() => firstTrack.stop.mock.calls.length)
      .toBeGreaterThan(0)

    await userEvent.click(
      screen.getByRole('button', { name: 'Restore recording admission' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )
    second.resolve({ getTracks: () => [secondTrack] })

    await expect
      .element(screen.getByText('Recording in progress…'))
      .toBeInTheDocument()
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(recorder.instances).toHaveLength(1)
  })

  it('does not let an obsolete request clear a newer permission request', async () => {
    const first = deferred<{ getTracks: () => { stop: () => void }[] }>()
    const second = deferred<{ getTracks: () => { stop: () => void }[] }>()
    const firstTrack = { stop: vi.fn() }
    const secondTrack = { stop: vi.fn() }
    const getUserMedia = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const { recorder } = installRecorder({ getUserMedia })
    const screen = await render(
      <QueryClientProvider client={queryClient()}>
        <CapabilityHarness />
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke recording admission' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Restore recording admission' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )

    first.resolve({ getTracks: () => [firstTrack] })
    await expect
      .poll(() => firstTrack.stop.mock.calls.length)
      .toBeGreaterThan(0)
    expect(recorder.instances).toHaveLength(0)

    second.resolve({ getTracks: () => [secondTrack] })
    await expect
      .element(screen.getByText('Recording in progress…'))
      .toBeInTheDocument()
    expect(recorder.instances).toHaveLength(1)
    expect(secondTrack.stop).not.toHaveBeenCalled()
  })
})
