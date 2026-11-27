import { act, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'
import { setUiLanguage } from '@/lib/i18n'
import { MediaUploadError } from './media-api'
import { UploadPanel } from './upload-panel'

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
      <UploadPanel meetingId={meetingId} canSubmitMedia />
    </QueryClientProvider>
  )
}

function UploadCapabilityHarness() {
  const [canSubmitMedia, setCanSubmitMedia] = useState(true)
  return (
    <>
      <button type='button' onClick={() => setCanSubmitMedia(false)}>
        Revoke media submission
      </button>
      <button type='button' onClick={() => setCanSubmitMedia(true)}>
        Restore media submission
      </button>
      <UploadPanel meetingId={meetingId} canSubmitMedia={canSubmitMedia} />
    </>
  )
}

function renderCapabilityHarness() {
  return render(
    <QueryClientProvider client={queryClient()}>
      <UploadCapabilityHarness />
    </QueryClientProvider>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('UploadPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mediaMocks.uploadMeetingFile.mockReset()
    mediaMocks.reconcileMeetingMedia.mockReset()
    toastMocks.error.mockReset()
    toastMocks.success.mockReset()
    vi.spyOn(coreApi, 'get').mockResolvedValue([])
  })

  it('rejects unsupported files before creating an upload intent', async () => {
    const screen = await renderPanel()
    await userEvent.upload(
      screen.getByLabelText('Select WAV, MP3, or AAC M4A audio file'),
      new File(['webm'], 'meeting.webm', { type: 'audio/webm' })
    )

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent(/WAV, MP3, or AAC M4A/i)
    expect(mediaMocks.uploadMeetingFile).not.toHaveBeenCalled()
  })

  it('prevents duplicate submit and keeps one operation key', async () => {
    let resolveUpload: (value: unknown) => void = () => undefined
    mediaMocks.uploadMeetingFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve
        })
    )
    const screen = await renderPanel()
    await userEvent.upload(
      screen.getByLabelText('Select WAV, MP3, or AAC M4A audio file'),
      new File(['wav'], 'meeting.wav', { type: 'audio/wav' })
    )

    const submit = screen.getByRole('button', {
      name: 'Upload and finalize',
    })
    await userEvent.click(submit)

    expect(mediaMocks.uploadMeetingFile).toHaveBeenCalledOnce()
    await expect
      .element(screen.getByRole('button', { name: 'Uploading…' }))
      .toBeDisabled()
    const firstOptions = mediaMocks.uploadMeetingFile.mock.calls[0]?.[3]
    expect(firstOptions).toEqual(
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    )
    resolveUpload({
      id: '22222222-2222-4222-8222-222222222222',
      meetingId,
      sourceType: 'UPLOAD',
      status: 'AVAILABLE',
      originalFilename: 'meeting.wav',
      contentType: 'audio/wav',
      sizeBytes: 3,
      durationMs: 1000,
      sha256: null,
      createdAt: '2030-01-01T00:00:00Z',
      availableAt: '2030-01-01T00:00:01Z',
      failureCode: null,
    })
  })

  it('keeps the selected file when the UI language changes', async () => {
    const screen = await renderPanel()
    try {
      await userEvent.upload(
        screen.getByLabelText('Select WAV, MP3, or AAC M4A audio file'),
        new File(['wav'], 'meeting.wav', { type: 'audio/wav' })
      )
      await act(async () => {
        await setUiLanguage('vi')
      })
      await expect.element(screen.getByText('meeting.wav')).toBeInTheDocument()
      await expect
        .element(screen.getByRole('button', { name: 'Tải lên và hoàn tất' }))
        .toBeEnabled()
      expect(mediaMocks.uploadMeetingFile).not.toHaveBeenCalled()
    } finally {
      await act(async () => {
        await setUiLanguage('en')
      })
    }
  })

  it('retains the selected file after an uncertain operation', async () => {
    mediaMocks.uploadMeetingFile.mockRejectedValue(
      new MediaUploadError('uncertain', {
        outcome: 'uncertain',
        mediaId: '22222222-2222-4222-8222-222222222222',
      })
    )
    const screen = await renderPanel()
    await userEvent.upload(
      screen.getByLabelText('Select WAV, MP3, or AAC M4A audio file'),
      new File(['wav'], 'meeting.wav', { type: 'audio/wav' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Upload and finalize' })
    )

    await expect
      .element(screen.getByRole('button', { name: 'Check upload status' }))
      .toBeInTheDocument()
    await expect.element(screen.getByText('meeting.wav')).toBeInTheDocument()
  })

  it('does not claim upload success after media submission admission is revoked', async () => {
    const upload = deferred<unknown>()
    mediaMocks.uploadMeetingFile.mockImplementation(
      async (
        _meetingId: string,
        _file: File,
        _sourceType: string,
        options: { canContinue?: () => void }
      ) => {
        const result = await upload.promise
        options.canContinue?.()
        return result
      }
    )
    const screen = await renderCapabilityHarness()
    await userEvent.upload(
      screen.getByLabelText('Select WAV, MP3, or AAC M4A audio file'),
      new File(['wav'], 'meeting.wav', { type: 'audio/wav' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Upload and finalize' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Uploading…' }))
      .toBeDisabled()

    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke media submission' })
    )
    await expect
      .element(screen.getByLabelText('Select WAV, MP3, or AAC M4A audio file'))
      .not.toBeInTheDocument()
    upload.resolve({
      id: '22222222-2222-4222-8222-222222222222',
      meetingId,
      sourceType: 'UPLOAD',
      status: 'AVAILABLE',
      originalFilename: 'meeting.wav',
      contentType: 'audio/wav',
      sizeBytes: 3,
      durationMs: 1000,
      sha256: null,
      createdAt: '2030-01-01T00:00:00Z',
      availableAt: '2030-01-01T00:00:01Z',
      failureCode: null,
    })

    await userEvent.click(
      screen.getByRole('button', { name: 'Restore media submission' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Retry submission' }))
      .toBeEnabled()
    expect(toastMocks.success).not.toHaveBeenCalled()
  })
})
