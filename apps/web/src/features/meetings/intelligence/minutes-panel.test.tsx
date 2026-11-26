import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'
import { MinutesPanel } from './minutes-panel'

const meetingId = '11111111-1111-4111-8111-111111111111'

function validMinutes() {
  return {
    schemaVersion: 1,
    assembledAt: '2026-11-23T00:00:00Z',
    sourceFingerprint: 'a'.repeat(64),
    completeness: 'COMPLETE',
    proposalsIncluded: false,
    warnings: [],
    meeting: {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Reviewed planning meeting',
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
      processingJobId: null,
      languageCode: 'vi',
      contentRevision: 1,
      durationMs: 1000,
      suspiciousSegments: 0,
      unresolvedSegments: 0,
      unresolvedCoverageRegions: 0,
    },
  }
}

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}))

async function renderPanel(
  snapshot: unknown,
  callbacks: Partial<React.ComponentProps<typeof MinutesPanel>> = {}
) {
  vi.spyOn(coreApi, 'get').mockImplementation(async (url) => {
    if (url === '/me/preferences') {
      return {
        timezone: 'Asia/Ho_Chi_Minh',
        locale: 'en-US',
        meetingEmailEnabled: true,
        actionItemEmailEnabled: true,
      } as never
    }
    if (url === '/meetings/' + meetingId + '/minutes') {
      return snapshot as never
    }
    throw new Error('Unexpected Core GET ' + url)
  })
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <MinutesPanel meetingId={meetingId} {...callbacks} />
    </QueryClientProvider>
  )
}

describe('MinutesPanel canonical document experience', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('does not present a snapshot containing proposals as official minutes', async () => {
    const screen = await renderPanel({
      ...validMinutes(),
      proposalsIncluded: true,
    })
    await expect
      .element(
        screen.getByText(
          'This snapshot contains unconfirmed AI proposals and is not official minutes.'
        )
      )
      .toBeVisible()
    await expect
      .element(screen.getByText('Not ready for a new official export'))
      .toBeVisible()
  })

  it('uses presentation preferences and exposes provenance only on demand', async () => {
    const screen = await renderPanel(validMinutes())
    await expect
      .element(screen.getByText('Times shown in Asia/Ho_Chi_Minh.'))
      .toBeVisible()
    const expectedEnd = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Ho_Chi_Minh',
    }).format(new Date('2026-11-23T00:00:00Z'))
    await expect
      .element(screen.getByText('Not recorded – ' + expectedEnd))
      .toBeVisible()
    await expect.element(screen.getByText('Minutes are complete')).toBeVisible()
    const fingerprint = screen.getByText(
      'Source fingerprint: ' + 'a'.repeat(64)
    )
    await expect.element(fingerprint).not.toBeVisible()
    await userEvent.click(screen.getByText('Advanced source details'))
    await expect.element(fingerprint).toBeVisible()
  })

  it('preserves material warnings and invokes the existing review actions', async () => {
    const onOpenSummary = vi.fn()
    const onOpenDecisions = vi.fn()
    const onOpenTranscript = vi.fn()
    const onOpenActions = vi.fn()
    const valid = validMinutes()
    const screen = await renderPanel(
      {
        ...valid,
        completeness: 'NEEDS_REVIEW',
        warnings: ['TRANSCRIPT_INCOMPLETE_COVERAGE'],
        transcript: {
          ...valid.transcript,
          availability: 'NEEDS_REVIEW',
          status: 'READY_WITH_WARNINGS',
          unresolvedCoverageRegions: 1,
        },
      },
      { onOpenSummary, onOpenDecisions, onOpenTranscript, onOpenActions }
    )
    await expect
      .element(screen.getByText('Not ready for a new official export'))
      .toBeVisible()
    await expect
      .element(
        screen.getByText(
          'Some detected speech has not been represented in the transcript.'
        )
      )
      .toBeVisible()
    await expect
      .element(screen.getByText('Unresolved speech regions'))
      .toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Review Summary' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Review Decisions' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Review transcript' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Review meeting Action Items' })
    )
    expect(onOpenSummary).toHaveBeenCalledTimes(1)
    expect(onOpenDecisions).toHaveBeenCalledTimes(1)
    expect(onOpenTranscript).toHaveBeenCalledTimes(1)
    expect(onOpenActions).toHaveBeenCalledTimes(1)
  })

  it('does not portray unavailable transcript counters as successful coverage', async () => {
    const valid = validMinutes()
    const screen = await renderPanel({
      ...valid,
      completeness: 'PARTIAL',
      warnings: ['TRANSCRIPT_NOT_AVAILABLE'],
      transcript: {
        ...valid.transcript,
        availability: 'NOT_AVAILABLE',
        id: null,
        status: null,
        versionNumber: null,
        languageCode: null,
        contentRevision: null,
        durationMs: null,
      },
    })
    await expect
      .element(screen.getByText('Partial', { exact: true }))
      .toBeVisible()
    await expect
      .element(
        screen.getByText(
          'No current transcript is available to assess speech coverage or quality.'
        )
      )
      .toBeVisible()
    await expect
      .element(screen.getByText('Unresolved speech regions'))
      .not.toBeInTheDocument()
  })

  it('fails closed when a malformed snapshot claims completeness', async () => {
    const valid = validMinutes()
    const screen = await renderPanel({
      ...valid,
      summary: { ...valid.summary, availability: 'UNKNOWN' },
    })
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('invalid canonical Minutes snapshot')
    await expect
      .element(screen.getByText('Minutes are complete'))
      .not.toBeInTheDocument()
  })
})
