import { beforeEach, describe, expect, it, vi } from 'vitest'
import { coreApi } from '@/lib/core-api'
import {
  acknowledgeTranscriptReview,
  admitMeetingIntelligence,
  type TranscriptReviewProof,
} from './transcript-review-gate-api'

const meetingId = '11111111-1111-4111-8111-111111111111'
const jobId = '22222222-2222-4222-8222-222222222222'
const sourceMediaId = '33333333-3333-4333-8333-333333333333'
const transcriptId = '44444444-4444-4444-8444-444444444444'
const reviewId = '55555555-5555-4555-8555-555555555555'
const digest = 'a'.repeat(64)

const proof: TranscriptReviewProof = {
  meetingId,
  processingJobId: jobId,
  sourceMediaId,
  transcriptId,
  versionNumber: 2,
  contentRevision: 8,
  transcriptStatus: 'READY_WITH_WARNINGS',
  finalizedAt: '2026-11-25T09:00:00Z',
  correctionDigest: digest,
}

const receipt = {
  reviewId,
  processingJobId: jobId,
  meetingId,
  transcriptId,
  contentRevision: 8,
  correctionDigest: digest,
  transcriptStatus: 'READY_WITH_WARNINGS' as const,
  acknowledgedByUserId: '66666666-6666-4666-8666-666666666666',
  acknowledgedAt: '2026-11-25T09:01:00Z',
  admittedByUserId: null,
  admittedAt: null,
}

function job() {
  return {
    id: jobId,
    meetingId,
    sourceMediaId,
    jobType: 'OFFLINE_MEETING_PROCESSING',
    status: 'RUNNING',
    requestedByUserId: '77777777-7777-4777-8777-777777777777',
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
}

describe('ordinary transcript review gate API', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends the exact acknowledgement proof and accepts Core attribution', async () => {
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue(receipt)

    await expect(
      acknowledgeTranscriptReview(jobId, proof, 'ack-key')
    ).resolves.toEqual(receipt)
    expect(post).toHaveBeenCalledWith(
      `/processing-jobs/${jobId}/transcript-review/acknowledge`,
      {
        transcriptId,
        contentRevision: 8,
        correctionDigest: digest,
      },
      { headers: { 'Idempotency-Key': 'ack-key' } }
    )
  })

  it('does not accept an unbound receipt', async () => {
    vi.spyOn(coreApi, 'post').mockResolvedValue({
      ...receipt,
      contentRevision: 9,
    })

    await expect(
      acknowledgeTranscriptReview(jobId, proof, 'ack-key')
    ).rejects.toMatchObject({
      code: 'REVIEW_PROOF_BINDING_NOT_CONFIRMED',
      recoveryOutcome: 'uncertain',
    })
  })

  it('treats malformed mutation responses as uncertain', async () => {
    vi.spyOn(coreApi, 'post').mockResolvedValue({})

    await expect(
      acknowledgeTranscriptReview(jobId, proof, 'ack-key')
    ).rejects.toMatchObject({ recoveryOutcome: 'uncertain' })
    await expect(
      admitMeetingIntelligence(jobId, proof, receipt, 'admit-key')
    ).rejects.toMatchObject({ recoveryOutcome: 'uncertain' })
  })

  it('admits with the receipt proof without assuming the original requester is the actor', async () => {
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue(job())

    await expect(
      admitMeetingIntelligence(jobId, proof, receipt, 'admit-key')
    ).resolves.toMatchObject({
      id: jobId,
      requestedByUserId: '77777777-7777-4777-8777-777777777777',
    })
    expect(post).toHaveBeenCalledWith(
      `/processing-jobs/${jobId}/meeting-intelligence/admit`,
      {
        reviewId,
        transcriptId,
        contentRevision: 8,
        correctionDigest: digest,
      },
      { headers: { 'Idempotency-Key': 'admit-key' } }
    )
  })
})
