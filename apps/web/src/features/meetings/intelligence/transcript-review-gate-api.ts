import { z } from 'zod'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  processingJobSchema,
  type ProcessingJob,
} from '../media/processing-api'

const reviewReceiptSchema = z.object({
  reviewId: z.string().uuid(),
  processingJobId: z.string().uuid(),
  meetingId: z.string().uuid(),
  transcriptId: z.string().uuid(),
  contentRevision: z.number().int().nonnegative(),
  correctionDigest: z.string().regex(/^[0-9a-f]{64}$/),
  transcriptStatus: z.enum(['READY', 'READY_WITH_WARNINGS']),
  acknowledgedByUserId: z.string().uuid(),
  acknowledgedAt: z.string().min(1),
  admittedByUserId: z.string().uuid().nullable(),
  admittedAt: z.string().min(1).nullable(),
})

export type TranscriptReviewReceipt = z.infer<typeof reviewReceiptSchema>

export type TranscriptReviewProof = {
  meetingId: string
  processingJobId: string
  sourceMediaId: string
  transcriptId: string
  versionNumber: number
  contentRevision: number
  transcriptStatus: string
  finalizedAt: string
  correctionDigest: string
}

function requestOptions(idempotencyKey: string, signal?: AbortSignal) {
  return {
    headers: { 'Idempotency-Key': idempotencyKey },
    ...(signal ? { signal } : {}),
  }
}

function unboundResponse(message: string): CoreApiError {
  return new CoreApiError({
    message,
    code: 'REVIEW_PROOF_BINDING_NOT_CONFIRMED',
    kind: 'malformed',
    recoveryOutcome: 'uncertain',
  })
}

function assertReceiptBinding(
  receipt: TranscriptReviewReceipt,
  jobId: string,
  proof: TranscriptReviewProof
) {
  if (
    receipt.processingJobId !== jobId ||
    receipt.meetingId !== proof.meetingId ||
    receipt.transcriptId !== proof.transcriptId ||
    receipt.contentRevision !== proof.contentRevision ||
    receipt.correctionDigest !== proof.correctionDigest ||
    receipt.transcriptStatus !== proof.transcriptStatus ||
    !['READY', 'READY_WITH_WARNINGS'].includes(receipt.transcriptStatus)
  ) {
    throw unboundResponse(
      'Core did not bind the review receipt to the exact transcript evidence.'
    )
  }
}

function assertAdmissionBinding(
  job: ProcessingJob,
  jobId: string,
  proof: TranscriptReviewProof
) {
  if (
    job.id !== jobId ||
    job.meetingId !== proof.meetingId ||
    job.sourceMediaId !== proof.sourceMediaId
  ) {
    throw unboundResponse(
      'Core did not bind Meeting Intelligence admission to the reviewed job and source.'
    )
  }
}

export async function acknowledgeTranscriptReview(
  jobId: string,
  proof: TranscriptReviewProof,
  idempotencyKey: string,
  signal?: AbortSignal
): Promise<TranscriptReviewReceipt> {
  const receipt = reviewReceiptSchema.parse(
    await coreApi.post<unknown>(
      `/processing-jobs/${encodeURIComponent(jobId)}/transcript-review/acknowledge`,
      {
        transcriptId: proof.transcriptId,
        contentRevision: proof.contentRevision,
        correctionDigest: proof.correctionDigest,
      },
      requestOptions(idempotencyKey, signal)
    )
  )
  assertReceiptBinding(receipt, jobId, proof)
  return receipt
}

export async function admitMeetingIntelligence(
  jobId: string,
  proof: TranscriptReviewProof,
  receipt: TranscriptReviewReceipt,
  idempotencyKey: string,
  signal?: AbortSignal
): Promise<ProcessingJob> {
  if (
    receipt.processingJobId !== jobId ||
    receipt.meetingId !== proof.meetingId ||
    receipt.transcriptId !== proof.transcriptId ||
    receipt.contentRevision !== proof.contentRevision ||
    receipt.correctionDigest !== proof.correctionDigest
  ) {
    throw new CoreApiError({
      message: 'The review receipt does not match the current evidence.',
      code: 'REVIEW_PROOF_STALE',
      kind: 'http',
      status: 409,
    })
  }

  const job = processingJobSchema.parse(
    await coreApi.post<unknown>(
      `/processing-jobs/${encodeURIComponent(jobId)}/meeting-intelligence/admit`,
      {
        reviewId: receipt.reviewId,
        transcriptId: proof.transcriptId,
        contentRevision: proof.contentRevision,
        correctionDigest: proof.correctionDigest,
      },
      requestOptions(idempotencyKey, signal)
    )
  )
  assertAdmissionBinding(job, jobId, proof)
  return job
}
