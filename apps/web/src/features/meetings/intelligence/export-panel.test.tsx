import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ExportPanel } from './export-panel'

const exportMocks = vi.hoisted(() => ({
  createMinutesExport: vi.fn(),
  accessMinutesExport: vi.fn(),
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
  accessMinutesExport: exportMocks.accessMinutesExport,
  exportStatusQuery: (exportId: string) => ({
    queryKey: ['export', exportId],
    queryFn: async () => {
      throw new Error('No export status should be fetched before admission.')
    },
    retry: false,
  }),
}))

describe('ExportPanel proposal boundary', () => {
  it('does not admit a durable export when Core marks proposals as included', async () => {
    const screen = await render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <ExportPanel meetingId='11111111-1111-4111-8111-111111111111' />
      </QueryClientProvider>
    )

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
})
