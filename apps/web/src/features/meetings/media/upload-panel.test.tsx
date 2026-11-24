import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'
import { MediaUploadError } from './media-api'
import { UploadPanel } from './upload-panel'

const mediaMocks = vi.hoisted(() => ({
  uploadMeetingFile: vi.fn(),
  reconcileMeetingMedia: vi.fn(),
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
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
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

describe('UploadPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mediaMocks.uploadMeetingFile.mockReset()
    mediaMocks.reconcileMeetingMedia.mockReset()
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
})
