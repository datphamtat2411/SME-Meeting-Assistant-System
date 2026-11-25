import { useEffect, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { TranscriptReviewAdmissionPanel } from './transcript-review-admission-panel'
import {
  TranscriptReviewGateProvider,
  useTranscriptReviewGate,
} from './transcript-review-gate'

const sessionMocks = vi.hoisted(() => ({
  session: {
    processing: {
      reconcileJob: vi.fn(),
    },
  },
}))

vi.mock('../media/meeting-session-context', () => ({
  useMeetingSession: () => sessionMocks.session,
}))

const meetingId = '11111111-1111-4111-8111-111111111111'
const jobId = '22222222-2222-4222-8222-222222222222'
const sourceMediaId = '33333333-3333-4333-8333-333333333333'
const transcriptId = '44444444-4444-4444-8444-444444444444'
const acknowledgedByUserId = '55555555-5555-4555-8555-555555555555'
const digest =
  '9949035bd21107da29e791f63b2564fa86b243d667774407a8f5413eb3f6f090'

const receipt = {
  reviewId: '66666666-6666-4666-8666-666666666666',
  processingJobId: jobId,
  meetingId,
  transcriptId,
  contentRevision: 8,
  correctionDigest: digest,
  transcriptStatus: 'READY_WITH_WARNINGS' as const,
  acknowledgedByUserId,
  acknowledgedAt: '2026-11-25T09:01:00Z',
  admittedByUserId: null,
  admittedAt: null,
}

const admittedJob = {
  id: jobId,
  meetingId,
  sourceMediaId,
  jobType: 'OFFLINE_MEETING_PROCESSING',
  status: 'RUNNING',
  requestedByUserId: acknowledgedByUserId,
  currentStage: null,
  queuedAt: null,
  startedAt: null,
  completedAt: null,
  errorCode: null,
  errorSummary: null,
  warningSummary: null,
  createdAt: '2026-11-25T09:00:00Z',
  updatedAt: '2026-11-25T09:02:00Z',
  reprocessOfJobId: null,
  retryable: false,
  retryCount: 0,
  stageRuns: [],
}

function ReviewGateProbe() {
  const gate = useTranscriptReviewGate()
  const observeEvidence = gate.observeEvidence
  const [revision, setRevision] = useState(8)

  useEffect(() => {
    const segments = [
      {
        ordinal: 0,
        startMs: 0,
        endMs: 1000,
        text: revision === 8 ? 'Original transcript' : 'Changed transcript',
      },
    ]
    observeEvidence(
      {
        meetingId,
        processingJobId: jobId,
        sourceMediaId,
        transcriptId,
        versionNumber: 2,
        contentRevision: revision,
        transcriptStatus: 'READY_WITH_WARNINGS',
        finalizedAt: '2026-11-25T09:00:00Z',
        etag: `"transcript-${revision}"`,
      },
      segments
    )
  }, [observeEvidence, revision])

  return (
    <div>
      <span data-testid='digest-status'>{gate.digestStatus}</span>
      <span data-testid='ack-status'>{gate.acknowledgement.status}</span>
      <span data-testid='admission-status'>{gate.admission.status}</span>
      <span data-testid='proof-invalidated'>
        {String(gate.proofInvalidated)}
      </span>
      <button
        type='button'
        onClick={() => void gate.acknowledge().catch(() => undefined)}
      >
        Acknowledge
      </button>
      <button
        type='button'
        onClick={() =>
          void gate.recoverAcknowledgement().catch(() => undefined)
        }
      >
        Recover acknowledgement
      </button>
      <button
        type='button'
        onClick={() => void gate.admit().catch(() => undefined)}
      >
        Admit
      </button>
      <button type='button' onClick={() => setRevision(9)}>
        Change evidence
      </button>
    </div>
  )
}

describe('transcript review gate lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    sessionMocks.session.processing.reconcileJob.mockReset()
  })

  it('replays uncertain acknowledgement with the same idempotency key, then admits separately', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValueOnce(
        new CoreApiError({
          message: 'The acknowledgement outcome is uncertain.',
          code: 'ACK_UNCERTAIN',
          kind: 'network',
          recoveryOutcome: 'uncertain',
        })
      )
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce(admittedJob)

    const screen = await render(
      <TranscriptReviewGateProvider
        meetingId={meetingId}
        fallbackCanManageReview
      >
        <ReviewGateProbe />
      </TranscriptReviewGateProvider>
    )

    await expect
      .element(screen.getByTestId('digest-status'))
      .toHaveTextContent('ready')
    await userEvent.click(
      screen.getByRole('button', { name: 'Acknowledge', exact: true })
    )
    await expect
      .element(screen.getByTestId('ack-status'))
      .toHaveTextContent('uncertain')

    await userEvent.click(
      screen.getByRole('button', { name: 'Recover acknowledgement' })
    )
    await expect
      .element(screen.getByTestId('ack-status'))
      .toHaveTextContent('confirmed')
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0]?.[2]).toEqual(post.mock.calls[1]?.[2])

    await userEvent.click(screen.getByRole('button', { name: 'Admit' }))
    await expect
      .element(screen.getByTestId('admission-status'))
      .toHaveTextContent('confirmed')
    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls[0]?.[2]).not.toEqual(post.mock.calls[2]?.[2])
    expect(sessionMocks.session.processing.reconcileJob).toHaveBeenCalledWith(
      admittedJob
    )
  })

  it('invalidates the receipt when the observed transcript proof changes', async () => {
    vi.spyOn(coreApi, 'post').mockResolvedValue(receipt)
    const screen = await render(
      <TranscriptReviewGateProvider
        meetingId={meetingId}
        fallbackCanManageReview
      >
        <ReviewGateProbe />
      </TranscriptReviewGateProvider>
    )

    await expect
      .element(screen.getByTestId('digest-status'))
      .toHaveTextContent('ready')
    await userEvent.click(
      screen.getByRole('button', { name: 'Acknowledge', exact: true })
    )
    await expect
      .element(screen.getByTestId('ack-status'))
      .toHaveTextContent('confirmed')

    await userEvent.click(
      screen.getByRole('button', { name: 'Change evidence' })
    )
    await expect
      .element(screen.getByTestId('proof-invalidated'))
      .toHaveTextContent('true')
    await expect
      .element(screen.getByTestId('ack-status'))
      .toHaveTextContent('rejected')
  })

  it('blocks acknowledgement when the fallback authorization is denied', async () => {
    const post = vi.spyOn(coreApi, 'post')
    const screen = await render(
      <TranscriptReviewGateProvider meetingId={meetingId}>
        <ReviewGateProbe />
      </TranscriptReviewGateProvider>
    )

    await expect
      .element(screen.getByTestId('digest-status'))
      .toHaveTextContent('ready')
    await userEvent.click(
      screen.getByRole('button', { name: 'Acknowledge', exact: true })
    )
    expect(post).not.toHaveBeenCalled()
    await expect
      .element(screen.getByTestId('ack-status'))
      .toHaveTextContent('idle')
  })

  it('requires a separate explicit acknowledgement before admission', async () => {
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce(admittedJob)
    const screen = await render(
      <TranscriptReviewGateProvider
        meetingId={meetingId}
        fallbackCanManageReview
      >
        <ReviewGateProbe />
        <TranscriptReviewAdmissionPanel />
      </TranscriptReviewGateProvider>
    )

    await expect
      .element(screen.getByTestId('digest-status'))
      .toHaveTextContent('ready')
    const acknowledgementButton = screen.getByRole('button', {
      name: 'Acknowledge transcript review',
      exact: true,
    })
    await expect.element(acknowledgementButton).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox'))
    await expect.element(acknowledgementButton).toBeEnabled()
    await userEvent.click(acknowledgementButton)
    await expect
      .element(screen.getByText('Core acknowledgement confirmed'))
      .toBeInTheDocument()
    await expect
      .element(
        screen.getByRole('button', {
          name: 'Admit Meeting Intelligence',
          exact: true,
        })
      )
      .toBeInTheDocument()
    expect(post).toHaveBeenCalledTimes(1)

    await userEvent.click(
      screen.getByRole('button', {
        name: 'Admit Meeting Intelligence',
        exact: true,
      })
    )
    await expect
      .element(screen.getByText(/admission confirmed by Core/i))
      .toBeInTheDocument()
    expect(post).toHaveBeenCalledTimes(2)
  })
})
