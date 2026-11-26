import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError } from '@/lib/core-api'
import { MeetingSessionProvider } from '../media/meeting-session-context'
import { ExportPanel } from './export-panel'

const exportMocks = vi.hoisted(() => ({
  createMinutesExport: vi.fn(),
  recoverMinutesExport: vi.fn(),
  accessMinutesExport: vi.fn(),
  fetchExportStatus: vi.fn(),
  capabilities: { admission: true, recovery: true, status: true, access: true },
}))

const authorizationMocks = vi.hoisted(() => ({
  value: {
    meetingId: '11111111-1111-4111-8111-111111111111',
    identity: {
      userId: '99999999-9999-4999-8999-999999999999',
      session: { id: '88888888-8888-4888-8888-888888888888' },
    },
    scopeReady: true,
    isEstablished: true,
    canReadProtectedData: true,
    canPerformProtectedOperation: true,
    isConfirmedAccessLoss: false,
    status: 'verified',
    capabilities: {
      authorizationResolution: 'allowed',
      canReadMeetingContent: true,
      canReadMedia: false,
      canReadProcessing: false,
      canAdmitProcessing: false,
      canRecoverProcessing: false,
      canRecordAudio: false,
      canSubmitMedia: false,
      canReadActionItems: true,
      canManageActionItems: false,
    },
  },
}))

vi.mock('../meeting-authorization-context', () => ({
  useOptionalMeetingAuthorization: () => authorizationMocks.value,
}))

const minutesData = vi.hoisted(() => ({
  value: {
    schemaVersion: 1,
    assembledAt: '2026-11-23T00:00:00Z',
    sourceFingerprint: 'a'.repeat(64),
    completeness: 'COMPLETE',
    proposalsIncluded: true,
    warnings: [],
    meeting: {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Meeting with proposal leakage',
      description: null,
      organizerUserId: '22222222-2222-4222-8222-222222222222',
      status: 'ENDED',
      scheduledStartAt: null,
      scheduledEndAt: null,
      startedAt: null,
      endedAt: '2026-11-23T00:00:00Z',
    },
    summary: {
      availability: 'AVAILABLE',
      id: '33333333-3333-4333-8333-333333333333',
      versionNumber: 1,
      content: 'AI-derived summary',
      sourceType: 'AI_GENERATED',
      qualityStatus: 'READY',
      transcriptId: '44444444-4444-4444-8444-444444444444',
      contentRevision: 1,
      selectionEpoch: 1,
      isStale: false,
      aiWarnings: [],
    },
    confirmedDecisions: [],
    officialActionItems: [],
    transcript: {
      availability: 'AVAILABLE',
      id: '44444444-4444-4444-8444-444444444444',
      versionNumber: 1,
      status: 'READY',
      unresolvedSegments: 0,
      unresolvedCoverageRegions: 0,
    },
  },
}))

vi.mock('./minutes-api', () => ({
  minutesQuery: () => ({
    queryKey: ['minutes', 'proposal-leakage'],
    queryFn: async () => minutesData.value,
    retry: false,
  }),
}))

vi.mock('./export-api', () => ({
  createMinutesExport: exportMocks.createMinutesExport,
  recoverMinutesExport: exportMocks.recoverMinutesExport,
  exportCapabilitiesQuery: (meetingId: string) => ({
    queryKey: ['export', 'capabilities', meetingId],
    queryFn: async () => ({
      meetingId,
      ...exportMocks.capabilities,
    }),
    retry: false,
  }),
  accessMinutesExport: exportMocks.accessMinutesExport,
  fetchExportStatus: exportMocks.fetchExportStatus,
  exportStatusQuery: (exportId: string) => ({
    queryKey: ['export', exportId],
    queryFn: () => exportMocks.fetchExportStatus(exportId),
    retry: false,
  }),
}))

const exportId = '55555555-5555-4555-8555-555555555555'
const secondExportId = '77777777-7777-4777-8777-777777777777'
const secondMeetingId = '22222222-2222-4222-8222-222222222222'
const exportCapability = {
  exportId,
  accessUrl: 'https://localhost/download/export.pdf?signature=test',
  filename: 'meeting-minutes.pdf',
  contentType: 'application/pdf',
  expiresAt: '2099-11-23T00:05:00Z',
  freshness: 'CURRENT',
  freshnessCheckedAt: '2099-11-23T00:00:00Z',
}
const secondExportCapability = {
  ...exportCapability,
  exportId: secondExportId,
}

function renderPanel(canExport = true) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <MeetingSessionProvider meetingId='11111111-1111-4111-8111-111111111111'>
        <ExportPanel
          meetingId='11111111-1111-4111-8111-111111111111'
          canExport={canExport}
        />
      </MeetingSessionProvider>
    </QueryClientProvider>
  )
}

function ExportContextHarness() {
  const [canExport, setCanExport] = useState(true)
  const [showPanel, setShowPanel] = useState(true)
  const [meetingId, setMeetingId] = useState(
    '11111111-1111-4111-8111-111111111111'
  )
  return (
    <>
      <button type='button' onClick={() => setShowPanel((value) => !value)}>
        Toggle export panel
      </button>
      <button
        type='button'
        onClick={() => {
          authorizationMocks.value = {
            ...authorizationMocks.value,
            capabilities: {
              ...authorizationMocks.value.capabilities,
              authorizationResolution: 'denied',
              canReadMeetingContent: false,
            },
          }
          setCanExport(false)
        }}
      >
        Revoke export access
      </button>
      <button
        type='button'
        onClick={() => {
          authorizationMocks.value = {
            ...authorizationMocks.value,
            capabilities: {
              ...authorizationMocks.value.capabilities,
              authorizationResolution: 'allowed',
              canReadMeetingContent: true,
            },
          }
          setCanExport(true)
        }}
      >
        Restore export access
      </button>
      <button
        type='button'
        onClick={() => {
          const nextMeetingId = '22222222-2222-4222-8222-222222222222'
          authorizationMocks.value.meetingId = nextMeetingId
          setMeetingId(nextMeetingId)
        }}
      >
        Switch meeting
      </button>
      <MeetingSessionProvider meetingId={meetingId}>
        {showPanel && (
          <ExportPanel meetingId={meetingId} canExport={canExport} />
        )}
      </MeetingSessionProvider>
    </>
  )
}

function renderContextHarness() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <ExportContextHarness />
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

describe('ExportPanel authorization and download boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    sessionStorage.clear()
    authorizationMocks.value.meetingId = '11111111-1111-4111-8111-111111111111'
    authorizationMocks.value.capabilities.authorizationResolution = 'allowed'
    authorizationMocks.value.capabilities.canReadMeetingContent = true
    vi.stubEnv('VITE_EXPORT_DOWNLOAD_HOSTS', 'localhost')
    exportMocks.capabilities = {
      admission: true,
      recovery: true,
      status: true,
      access: true,
    }
    minutesData.value = {
      ...minutesData.value,
      completeness: 'COMPLETE',
      proposalsIncluded: false,
    }
    exportMocks.fetchExportStatus.mockImplementation(
      async (exportId: string) => ({
        exportId,
        meetingId:
          exportId === secondExportId
            ? secondMeetingId
            : '11111111-1111-4111-8111-111111111111',
        format: 'PDF',
        status: 'READY',
        attemptCount: 1,
        createdAt: '2026-11-23T00:00:00Z',
        readyAt: '2026-11-23T00:01:00Z',
        safeErrorCode: null,
        freshness: 'CURRENT',
        freshnessCheckedAt: '2026-11-23T00:01:00Z',
      })
    )
    exportMocks.createMinutesExport.mockResolvedValue({ exportId })
    exportMocks.recoverMinutesExport.mockResolvedValue({ exportId })
    exportMocks.accessMinutesExport.mockResolvedValue(exportCapability)
  })

  it('does not create exports when deployment admission is disabled', async () => {
    exportMocks.capabilities.admission = false
    const screen = await renderPanel()
    await expect
      .element(
        screen.getByText(
          'New export generation is disabled in this deployment.'
        )
      )
      .toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: 'Generate PDF' }))
      .toBeDisabled()
    await expect
      .element(screen.getByRole('button', { name: 'Generate Markdown' }))
      .toBeDisabled()
    expect(exportMocks.createMinutesExport).not.toHaveBeenCalled()
  })

  it('does not create exports without a trusted download configuration', async () => {
    vi.stubEnv('VITE_EXPORT_DOWNLOAD_HOSTS', '*')
    const screen = await renderPanel()
    await expect
      .element(
        screen.getByText(
          'Secure downloads are not configured. Contact your administrator.'
        )
      )
      .toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: 'Generate PDF' }))
      .toBeDisabled()
    expect(exportMocks.createMinutesExport).not.toHaveBeenCalled()
  })

  it('does not admit a durable export when Core marks proposals as included', async () => {
    minutesData.value = { ...minutesData.value, proposalsIncluded: true }
    const screen = await renderPanel()

    const generatePdf = screen.getByRole('button', { name: 'Generate PDF' })
    await expect.element(generatePdf).toBeDisabled()
    await expect
      .element(
        screen.getByText(
          'Minutes contain unconfirmed AI proposals and are not eligible for export.'
        )
      )
      .toBeInTheDocument()
    expect(exportMocks.createMinutesExport).not.toHaveBeenCalled()
  })

  it('allows an authorized meeting-content reader to generate and download an export', async () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    const screen = await renderPanel(true)

    await userEvent.click(screen.getByRole('button', { name: 'Generate PDF' }))
    await expect
      .element(screen.getByRole('button', { name: 'Download' }))
      .toBeInTheDocument()
    const observationsBeforeDownload =
      exportMocks.fetchExportStatus.mock.calls.length
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))

    await expect
      .poll(() => exportMocks.accessMinutesExport.mock.calls.length)
      .toBe(1)
    expect(clickSpy).toHaveBeenCalledOnce()
    expect(exportMocks.fetchExportStatus.mock.calls.length).toBeGreaterThan(
      observationsBeforeDownload
    )
  })

  it('refuses an insecure or untrusted download capability', async () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    exportMocks.accessMinutesExport.mockResolvedValue({
      ...exportCapability,
      accessUrl: 'http://untrusted.example/download/export.pdf?signature=test',
    })
    const screen = await renderPanel(true)

    await userEvent.click(screen.getByRole('button', { name: 'Generate PDF' }))
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))

    await expect
      .poll(() => exportMocks.accessMinutesExport.mock.calls.length)
      .toBe(1)
    await expect.poll(() => clickSpy.mock.calls.length).toBe(0)
  })

  it('recovers ambiguous export admission with the original key', async () => {
    exportMocks.createMinutesExport.mockRejectedValueOnce(
      new CoreApiError({
        message: 'Connection interrupted',
        code: 'EXPORT_ADMISSION_UNCERTAIN',
        kind: 'network',
        recoveryOutcome: 'uncertain',
      })
    )
    const screen = await renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Generate PDF' }))
    const recover = screen.getByRole('button', { name: 'Recover PDF request' })
    await expect.element(recover).toBeEnabled()
    await userEvent.click(recover)
    await expect
      .poll(() => exportMocks.recoverMinutesExport.mock.calls.length)
      .toBe(1)
    expect(exportMocks.createMinutesExport).toHaveBeenCalledOnce()
    expect(exportMocks.createMinutesExport.mock.calls[0]).toEqual(
      exportMocks.recoverMinutesExport.mock.calls[0]
    )
  })

  it('does not automatically create an export after an unavailable recovery receipt', async () => {
    exportMocks.createMinutesExport.mockRejectedValueOnce(
      new CoreApiError({
        message: 'Connection interrupted',
        code: 'EXPORT_ADMISSION_UNCERTAIN',
        kind: 'network',
        recoveryOutcome: 'uncertain',
      })
    )
    exportMocks.recoverMinutesExport.mockResolvedValueOnce(null)
    const screen = await renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Generate PDF' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Recover PDF request' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Confirm new PDF request' }))
      .toBeEnabled()
    expect(exportMocks.createMinutesExport).toHaveBeenCalledOnce()
    await userEvent.click(
      screen.getByRole('button', { name: 'Confirm new PDF request' })
    )
    await expect
      .poll(() => exportMocks.createMinutesExport.mock.calls.length)
      .toBe(2)
    expect(exportMocks.createMinutesExport.mock.calls[1][2]).not.toBe(
      exportMocks.createMinutesExport.mock.calls[0][2]
    )
  })

  it('records admission after the presentation unmounts without replaying POST', async () => {
    const receipt = deferred<{ exportId: string }>()
    exportMocks.createMinutesExport.mockReturnValue(receipt.promise)
    const screen = await renderContextHarness()

    await userEvent.click(screen.getByRole('button', { name: 'Generate PDF' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Toggle export panel' })
    )
    receipt.resolve({ exportId })
    const key =
      'sme:meeting-minutes-export:v3:99999999-9999-4999-8999-999999999999:88888888-8888-4888-8888-888888888888:11111111-1111-4111-8111-111111111111'
    await expect.poll(() => sessionStorage.getItem(key)).toContain(exportId)
    await userEvent.click(
      screen.getByRole('button', { name: 'Toggle export panel' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Download' }))
      .toBeInTheDocument()
    expect(exportMocks.createMinutesExport).toHaveBeenCalledOnce()
  })

  it('retires an admission on content denial with the same identity and no presentation', async () => {
    const receipt = deferred<{ exportId: string }>()
    exportMocks.createMinutesExport.mockReturnValue(receipt.promise)
    const screen = await renderContextHarness()

    await userEvent.click(screen.getByRole('button', { name: 'Generate PDF' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Toggle export panel' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke export access' })
    )
    const key =
      'sme:meeting-minutes-export:v3:99999999-9999-4999-8999-999999999999:88888888-8888-4888-8888-888888888888:11111111-1111-4111-8111-111111111111'
    await expect.poll(() => sessionStorage.getItem(key)).toBeNull()
    receipt.resolve({ exportId })
    await userEvent.click(
      screen.getByRole('button', { name: 'Restore export access' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Toggle export panel' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Generate PDF' }))
      .toBeEnabled()
    expect(sessionStorage.getItem(key)).toBeNull()
    expect(exportMocks.createMinutesExport).toHaveBeenCalledOnce()
  })

  it('shows definitive admission failure instead of silently returning to idle', async () => {
    exportMocks.createMinutesExport.mockRejectedValueOnce(
      new CoreApiError({
        message: 'Minutes changed before export admission.',
        code: 'EXPORT_CONFLICT',
        status: 409,
        kind: 'http',
      })
    )
    const screen = await renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Generate PDF' }))
    await expect
      .element(screen.getByText('PDF export request failed'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Minutes changed before export admission.'))
      .toBeInTheDocument()
  })

  it('does not offer export operations without meeting-content access', async () => {
    const screen = await renderPanel(false)

    await expect
      .element(
        screen.getByText(
          'Export is unavailable for the current meeting access.'
        )
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Generate PDF' }))
      .not.toBeInTheDocument()
    expect(exportMocks.createMinutesExport).not.toHaveBeenCalled()
  })

  it('discards a download capability when authorization is revoked while it is pending', async () => {
    const pending = deferred<typeof exportCapability>()
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    exportMocks.accessMinutesExport.mockReturnValue(pending.promise)
    const screen = await renderContextHarness()

    await userEvent.click(screen.getByRole('button', { name: 'Generate PDF' }))
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await expect
      .poll(() => exportMocks.accessMinutesExport.mock.calls.length)
      .toBe(1)

    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke export access' })
    )
    pending.resolve(exportCapability)

    await expect.poll(() => clickSpy.mock.calls.length).toBe(0)
  })

  it('discards a download capability when the originating context unmounts while it is pending', async () => {
    const pending = deferred<typeof exportCapability>()
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    exportMocks.accessMinutesExport.mockReturnValue(pending.promise)
    const screen = await renderPanel(true)

    await userEvent.click(screen.getByRole('button', { name: 'Generate PDF' }))
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await expect
      .poll(() => exportMocks.accessMinutesExport.mock.calls.length)
      .toBe(1)

    screen.unmount()
    pending.resolve(exportCapability)

    await expect.poll(() => clickSpy.mock.calls.length).toBe(0)
  })

  it('invalidates pending downloads when the meeting changes and does not leak the old operation', async () => {
    const first = deferred<typeof exportCapability>()
    const second = deferred<typeof exportCapability>()
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    exportMocks.accessMinutesExport
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    exportMocks.createMinutesExport
      .mockResolvedValueOnce({ exportId })
      .mockResolvedValueOnce({ exportId: secondExportId })
    const screen = await renderContextHarness()

    await userEvent.click(screen.getByRole('button', { name: 'Generate PDF' }))
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await expect
      .poll(() => exportMocks.accessMinutesExport.mock.calls.length)
      .toBe(1)

    await userEvent.click(
      screen.getByRole('button', { name: 'Switch meeting' })
    )
    first.resolve(exportCapability)
    await expect.poll(() => clickSpy.mock.calls.length).toBe(0)
    await expect
      .element(screen.getByRole('button', { name: 'Download' }))
      .not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Generate PDF' }))
    await expect
      .poll(() => exportMocks.createMinutesExport.mock.calls.length)
      .toBe(2)
    await expect
      .element(screen.getByRole('button', { name: 'Download' }))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    second.resolve(secondExportCapability)
    await expect.poll(() => clickSpy.mock.calls.length).toBe(1)
  })
})
