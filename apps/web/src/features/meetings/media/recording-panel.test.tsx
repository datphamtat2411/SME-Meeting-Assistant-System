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

function renderPanel() {
  return render(
    <QueryClientProvider client={queryClient()}>
      <RecordingPanel meetingId={meetingId} />
    </QueryClientProvider>
  )
}

function installRecorder(supported = true) {
  const track = { stop: vi.fn() }
  const getUserMedia = vi.fn().mockResolvedValue({
    getTracks: () => [track],
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })

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

describe('RecordingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mediaMocks.uploadMeetingFile.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      status: 'AVAILABLE',
    })
  })

  it('does not request microphone access when no supported AAC recorder exists', async () => {
    const { getUserMedia } = installRecorder(false)
    const screen = await renderPanel()

    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )

    expect(getUserMedia).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith(
      expect.stringContaining('supported AAC-in-M4A')
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
    expect(track.stop).toHaveBeenCalledOnce()
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

  it('stops an active recorder when the component is cleaned up', async () => {
    const { track } = installRecorder()
    const screen = await renderPanel()
    await userEvent.click(
      screen.getByRole('button', { name: 'Start recording' })
    )

    screen.unmount()

    expect(track.stop).toHaveBeenCalledOnce()
    expect(mediaMocks.uploadMeetingFile).not.toHaveBeenCalled()
  })

  it('reports microphone permission failure without creating an upload', async () => {
    installRecorder()
    const getUserMedia = vi
      .fn()
      .mockRejectedValue(new Error('permission denied'))
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })
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
})
