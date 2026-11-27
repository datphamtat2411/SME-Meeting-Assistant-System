import { useState } from 'react'
import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
import { localizedValidationMessage } from '@/lib/i18n/presentation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { presentProcessingStatus } from '../media/processing-status-presentation'
import {
  useOptionalTranscriptReviewGate,
  useTranscriptReviewGate,
} from './transcript-review-gate'

export function TranscriptReviewAdmissionPanel({
  onNavigateToIntelligence,
}: {
  onNavigateToIntelligence?: () => void
}) {
  const { t } = useUiTranslation()
  const gate = useTranscriptReviewGate()
  const [acknowledgementIntent, setAcknowledgementIntent] = useState<{
    fingerprint: string | null
    checked: boolean
  }>({ fingerprint: null, checked: false })
  const acknowledgementChecked =
    acknowledgementIntent.fingerprint === gate.evidence?.fingerprint &&
    acknowledgementIntent.checked

  const evidenceReady = Boolean(
    !gate.eligibilityMessage &&
    gate.evidence &&
    gate.digestStatus === 'ready' &&
    ['READY', 'READY_WITH_WARNINGS'].includes(gate.evidence.transcriptStatus) &&
    gate.evidence.finalizedAt
  )
  const acknowledgementConfirmed = Boolean(
    gate.receiptIsCurrent &&
    gate.receipt &&
    gate.acknowledgement.status === 'confirmed'
  )
  const admissionConfirmed = Boolean(
    gate.evidence &&
    ((gate.receipt?.processingJobId === gate.evidence.processingJobId &&
      gate.receipt.admittedAt) ||
      (gate.admission.processingJobId === gate.evidence.processingJobId &&
        gate.admission.status === 'confirmed'))
  )
  const recovering =
    gate.acknowledgement.status === 'uncertain' ||
    gate.admission.status === 'uncertain'

  async function acknowledge() {
    try {
      const result = await gate.acknowledge(
        acknowledgementIntent.fingerprint ?? ''
      )
      if (result === 'confirmed') {
        setAcknowledgementIntent({
          fingerprint: gate.evidence?.fingerprint ?? null,
          checked: false,
        })
      }
    } catch {
      // The gate retains the truthful rejected or uncertain state for review.
    }
  }

  async function recoverAcknowledgement() {
    try {
      await gate.recoverAcknowledgement()
    } catch {
      // The gate retains the truthful recovery state.
    }
  }

  async function admit() {
    try {
      await gate.admit(gate.evidence?.fingerprint ?? '')
    } catch {
      // The gate retains the truthful rejected or uncertain state.
    }
  }

  async function recoverAdmission() {
    try {
      await gate.recoverAdmission()
    } catch {
      // The gate retains the truthful recovery state.
    }
  }

  return (
    <Card data-testid='transcript-review-admission'>
      <CardHeader className='border-b'>
        <CardTitle className='flex items-center gap-2'>
          <ShieldCheck className='size-5' />
          {t('transcript:reviewGate_heading')}
        </CardTitle>
        <CardDescription>
          {t('transcript:reviewGate_description')}
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4 pt-5'>
        {gate.proofInvalidated && gate.proofInvalidationMessage && (
          <div
            role='alert'
            className='flex gap-2 rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200'
          >
            <AlertTriangle className='mt-0.5 size-4 shrink-0' />
            <span>
              {localizedValidationMessage(gate.proofInvalidationMessage, t)}
            </span>
          </div>
        )}

        {gate.digestStatus === 'computing' && (
          <p role='status' className='text-sm text-muted-foreground'>
            {t('transcript:reviewGate_computingDigest')}
          </p>
        )}
        {gate.digestStatus === 'error' && (
          <p role='alert' className='text-sm text-destructive'>
            {gate.digestError
              ? localizedValidationMessage(gate.digestError, t)
              : t('transcript:reviewGate_digestUnverified')}
          </p>
        )}
        {!gate.isAuthorized && (
          <p role='status' className='text-sm text-muted-foreground'>
            {t('transcript:reviewGate_unauthorized')}
          </p>
        )}
        {gate.mutationBlocked && (
          <p role='status' className='text-sm text-muted-foreground'>
            {t('transcript:reviewGate_mutationBlocked')}
          </p>
        )}

        <TranscriptReviewWorkflowStatus />
        {gate.eligibilityMessage && !admissionConfirmed && (
          <p role='status' className='text-sm text-muted-foreground'>
            {localizedValidationMessage(gate.eligibilityMessage, t)}
          </p>
        )}
        {recovering && (
          <div role='status' className='space-y-2 rounded-lg border p-3'>
            <p className='text-sm'>{t('transcript:reviewGate_uncertain')}</p>
            <p className='text-sm text-muted-foreground'>
              {localizedValidationMessage(
                (gate.admission.status === 'uncertain'
                  ? gate.admission.message
                  : gate.acknowledgement.message) ?? '',
                t
              )}
            </p>
            <Button
              type='button'
              variant='outline'
              disabled={!gate.isAuthorized || gate.mutationBlocked}
              onClick={() =>
                void (gate.admission.status === 'uncertain'
                  ? recoverAdmission()
                  : recoverAcknowledgement())
              }
            >
              {gate.admission.status === 'uncertain'
                ? t('transcript:reviewGate_recoverAdmission')
                : t('transcript:reviewGate_recoverAcknowledgement')}
            </Button>
          </div>
        )}
        {gate.receipt && !gate.receiptIsCurrent && (
          <p className='text-sm text-muted-foreground'>
            {t('transcript:reviewGate_receiptRevision', {
              revision: gate.receipt.contentRevision,
            })}
          </p>
        )}
        {gate.admission.status === 'confirmed' && !admissionConfirmed && (
          <p className='text-sm text-muted-foreground'>
            {t('transcript:reviewGate_previousAdmission')}
          </p>
        )}
        {gate.evidence && (
          <div className='flex flex-wrap gap-2 text-xs'>
            <Badge variant='outline'>
              {t('transcript:reviewGate_revision', {
                revision: gate.evidence.contentRevision,
              })}
            </Badge>
            <Badge variant='outline'>
              {t('transcript:reviewGate_source', {
                source: gate.evidence.sourceMediaId.slice(0, 8),
              })}
            </Badge>
            <Badge variant='outline'>
              {t(
                `transcript:reviewGate_status_${gate.evidence.transcriptStatus}`,
                { defaultValue: gate.evidence.transcriptStatus }
              )}
            </Badge>
          </div>
        )}

        {gate.receiptIsCurrent && gate.receipt && (
          <div className='rounded-lg border bg-muted/10 p-3 text-sm'>
            <p className='flex items-center gap-2 font-medium'>
              <CheckCircle2 className='size-4 text-emerald-600' />
              {t('transcript:reviewGate_acknowledgementConfirmed')}
            </p>
            <p className='mt-1 text-muted-foreground'>
              {t('transcript:reviewGate_attributed', {
                user: gate.receipt.acknowledgedByUserId,
                time: gate.receipt.acknowledgedAt,
              })}
            </p>
          </div>
        )}

        {!recovering && !acknowledgementConfirmed && !admissionConfirmed && (
          <div className='space-y-3 rounded-lg border p-3'>
            <label className='flex items-start gap-2 text-sm'>
              <input
                type='checkbox'
                checked={acknowledgementChecked}
                disabled={
                  !evidenceReady ||
                  !gate.isAuthorized ||
                  gate.mutationBlocked ||
                  gate.acknowledgement.status === 'pending' ||
                  gate.acknowledgement.status === 'uncertain'
                }
                onChange={(event) =>
                  setAcknowledgementIntent({
                    fingerprint: gate.evidence?.fingerprint ?? null,
                    checked: event.target.checked,
                  })
                }
              />
              <span>{t('transcript:reviewGate_acknowledgementStatement')}</span>
            </label>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                type='button'
                onClick={() => void acknowledge()}
                disabled={
                  !acknowledgementChecked ||
                  !evidenceReady ||
                  !gate.isAuthorized ||
                  gate.mutationBlocked ||
                  gate.acknowledgement.status === 'pending'
                }
              >
                {gate.acknowledgement.status === 'pending'
                  ? t('transcript:reviewGate_acknowledging')
                  : t('transcript:reviewGate_acknowledge')}
              </Button>
              {gate.acknowledgement.status === 'rejected' &&
                gate.acknowledgement.message && (
                  <span role='alert' className='text-sm text-destructive'>
                    {localizedValidationMessage(
                      gate.acknowledgement.message,
                      t
                    )}
                  </span>
                )}
            </div>
          </div>
        )}

        {!recovering && acknowledgementConfirmed && !admissionConfirmed && (
          <div className='space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-3'>
            <p className='text-sm'>
              {t('transcript:reviewGate_receiptCurrent')}
            </p>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                type='button'
                onClick={() => void admit()}
                disabled={
                  !gate.isAuthorized ||
                  !evidenceReady ||
                  gate.mutationBlocked ||
                  gate.admission.status === 'pending'
                }
              >
                {gate.admission.status === 'pending'
                  ? t('transcript:reviewGate_admitting')
                  : t('transcript:reviewGate_admit')}
              </Button>
              {gate.admission.status === 'rejected' &&
                gate.admission.message && (
                  <span role='alert' className='text-sm text-destructive'>
                    {localizedValidationMessage(gate.admission.message, t)}
                  </span>
                )}
            </div>
          </div>
        )}

        {admissionConfirmed && (
          <div className='flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-300/70 bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-200'>
            <span className='flex items-center gap-2'>
              <CheckCircle2 className='size-4' />
              {t('transcript:reviewGate_admissionConfirmed')}
            </span>
            {onNavigateToIntelligence && (
              <Button
                type='button'
                variant='outline'
                onClick={onNavigateToIntelligence}
              >
                {t('transcript:reviewGate_openIntelligence')}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function TranscriptReviewWorkflowStatus({
  onReview,
}: {
  onReview?: () => void
}) {
  const { t } = useUiTranslation()
  const gate = useOptionalTranscriptReviewGate()
  if (!gate?.isAuthorized) return null
  const job = gate.observedJob
  if (!job && !gate.hasUnresolvedOperation) return null

  return (
    <div role='status' className='space-y-2 rounded-lg border p-3 text-sm'>
      {job && (
        <>
          <p className='font-medium'>
            {t('transcript:reviewGate_processing', {
              status: presentProcessingStatus(job.status).label,
            })}
          </p>
          {job.currentStage && (
            <p>
              {t('transcript:reviewGate_stage', { stage: job.currentStage })}
            </p>
          )}
          {job.warningSummary && (
            <p className='text-muted-foreground'>{job.warningSummary}</p>
          )}
          {job.errorSummary && (
            <p className='text-muted-foreground'>{job.errorSummary}</p>
          )}
        </>
      )}
      {gate.hasUnresolvedOperation && (
        <p>{t('transcript:reviewGate_requestUnresolved')}</p>
      )}
      {onReview && (
        <Button type='button' variant='outline' onClick={onReview}>
          {t('transcript:reviewGate_openReview')}
        </Button>
      )}
    </div>
  )
}
