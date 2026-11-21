import { useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  FileAudio,
  FileCheck2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import {
  OPERATOR_MI_SUMMARY_CONTRACT,
  actionItemEtag,
  admitOperatorProcessingJob,
  applyApprovedTranscriptCorrection,
  confirmActionItem,
  confirmDecision,
  createSyntheticMeeting,
  fetchFinalizedTranscriptEvidence,
  fetchProcessingJob,
  rejectActionItem,
  rejectDecision,
  readMeetingIntelligenceResults,
  transcriptSegmentEtag,
  uploadAndFinalizeMeetingMedia,
  verifyOperatorSession,
  type ActionItemReview,
  type DecisionReview,
  type FinalizedMedia,
  type FinalizedTranscriptEvidence,
  type MeetingIntelligenceReview,
  type OperatorSession,
  type ProcessingJob,
  type SyntheticMeetingResult,
} from './data/operator-mi-e2e-workflow'

export const EXPECTED_OPERATOR_USER_ID = '46a30219-3c9f-498d-94fa-d6558f200714'
const EXPECTED_OPERATOR_DISPLAY_NAME = 'E2E-04 Local Test'

const defaultMeetingTitle = 'Synthetic Vietnamese MI E2E meeting'
const defaultMeetingDescription =
  'One bounded operator-assisted Vietnamese meeting for MI evaluation.'

type CorrectionDraft = {
  text: string
  reason: string
  approved: boolean
}

type ProposalAction = {
  kind: 'decision' | 'action-item'
  id: string
  action: 'confirm' | 'reject'
}

type WorkflowError = {
  step: string
  message: string
} | null

export function OperatorMiE2eWorkspace() {
  const [session, setSession] = useState<OperatorSession | null>(null)
  const [sessionPending, setSessionPending] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)

  const [title, setTitle] = useState(defaultMeetingTitle)
  const [description, setDescription] = useState(defaultMeetingDescription)
  const [creationStarted, setCreationStarted] = useState(false)
  const [creationPending, setCreationPending] = useState(false)
  const [creationError, setCreationError] = useState<string | null>(null)
  const [meetingResult, setMeetingResult] =
    useState<SyntheticMeetingResult | null>(null)
  const creationKey = useRef<string | null>(null)
  const [meetingApprovalOpen, setMeetingApprovalOpen] = useState(false)

  const [mediaFile, setMediaFile] = useState<File | null>(null)
  const [mediaAttempted, setMediaAttempted] = useState(false)
  const [mediaPending, setMediaPending] = useState(false)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [media, setMedia] = useState<FinalizedMedia | null>(null)
  const mediaKey = useRef<string | null>(null)

  const [jobAttempted, setJobAttempted] = useState(false)
  const [jobPending, setJobPending] = useState(false)
  const [jobError, setJobError] = useState<string | null>(null)
  const [job, setJob] = useState<ProcessingJob | null>(null)
  const jobKey = useRef<string | null>(null)

  const [transcriptPending, setTranscriptPending] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcript, setTranscript] =
    useState<FinalizedTranscriptEvidence | null>(null)
  const [corrections, setCorrections] = useState<
    Record<string, CorrectionDraft>
  >({})
  const [correctionPending, setCorrectionPending] = useState<string | null>(
    null
  )
  const [correctionMessage, setCorrectionMessage] = useState<string | null>(
    null
  )

  const [resultsPending, setResultsPending] = useState(false)
  const [resultsError, setResultsError] = useState<string | null>(null)
  const [results, setResults] = useState<MeetingIntelligenceReview | null>(null)
  const [proposalAction, setProposalAction] = useState<ProposalAction | null>(
    null
  )
  const [proposalPending, setProposalPending] = useState<string | null>(null)
  const [proposalError, setProposalError] = useState<string | null>(null)

  const [workflowError, setWorkflowError] = useState<WorkflowError>(null)

  const operatorMatchesExpected =
    session?.user.userId === EXPECTED_OPERATOR_USER_ID
  const meetingId = meetingResult?.meeting.meeting.id
  const mediaId = media?.id
  const jobIsTerminal =
    job?.status === 'COMPLETED' ||
    job?.status === 'COMPLETED_WITH_WARNINGS' ||
    job?.status === 'FAILED'
  const canCreate =
    operatorMatchesExpected &&
    !meetingResult &&
    !creationStarted &&
    !creationPending
  const canUpload =
    Boolean(meetingId && mediaFile && mediaFile.size > 0 && mediaFile.type) &&
    !media &&
    !mediaAttempted &&
    !mediaPending
  const canAdmitJob =
    Boolean(meetingId && mediaId && session?.user.userId) &&
    !job &&
    !jobAttempted &&
    !jobPending

  const verifySession = async () => {
    setSessionPending(true)
    setSessionError(null)
    setWorkflowError(null)
    try {
      setSession(await verifyOperatorSession(EXPECTED_OPERATOR_USER_ID))
    } catch (error) {
      const message = readableError(error)
      setSession(null)
      setSessionError(message)
      setWorkflowError({ step: 'Session verification', message })
    } finally {
      setSessionPending(false)
    }
  }

  const createMeetingRequest = async () => {
    if (!operatorMatchesExpected || meetingResult || creationPending) return
    setCreationStarted(true)
    setCreationPending(true)
    setCreationError(null)
    setWorkflowError(null)
    const key = creationKey.current ?? createIdempotencyKey('meeting')
    creationKey.current = key
    try {
      const created = await createSyntheticMeeting(
        { title, description },
        key,
        EXPECTED_OPERATOR_USER_ID
      )
      setSession(created.session)
      setMeetingResult(created)
      setCreationError(null)
    } catch (error) {
      const message = readableError(error)
      setCreationError(
        `${message} No replacement meeting key was generated. A replay, if offered, uses the same frozen request.`
      )
      setWorkflowError({ step: 'Meeting creation', message })
    } finally {
      setCreationPending(false)
      setMeetingApprovalOpen(false)
    }
  }

  const uploadMedia = async () => {
    if (!meetingId || !mediaFile || !canUpload) return
    setMediaAttempted(true)
    setMediaPending(true)
    setMediaError(null)
    setWorkflowError(null)
    const key = mediaKey.current ?? createIdempotencyKey('media')
    mediaKey.current = key
    try {
      const finalized = await uploadAndFinalizeMeetingMedia(
        meetingId,
        {
          originalFilename: mediaFile.name,
          contentType: mediaFile.type,
          expectedSizeBytes: mediaFile.size,
          body: mediaFile,
        },
        key
      )
      setMedia(finalized)
    } catch (error) {
      const message = readableError(error)
      setMediaError(
        `${message} No upload or finalization retry was sent by this helper.`
      )
      setWorkflowError({ step: 'Media upload and finalization', message })
    } finally {
      setMediaPending(false)
    }
  }

  const admitJob = async () => {
    if (!meetingId || !mediaId || !session || !canAdmitJob) return
    setJobAttempted(true)
    setJobPending(true)
    setJobError(null)
    setWorkflowError(null)
    const key = jobKey.current ?? createIdempotencyKey('job')
    jobKey.current = key
    try {
      setJob(
        await admitOperatorProcessingJob(
          meetingId,
          mediaId,
          key,
          session.user.userId
        )
      )
    } catch (error) {
      const message = readableError(error)
      setJobError(
        `${message} Processing-job retry is intentionally unavailable here.`
      )
      setWorkflowError({ step: 'Processing-job admission', message })
    } finally {
      setJobPending(false)
    }
  }

  const refreshJob = async () => {
    if (!job) return
    setJobPending(true)
    setJobError(null)
    try {
      const current = await fetchProcessingJob(job.id)
      if (
        current.meetingId !== job.meetingId ||
        current.sourceMediaId !== job.sourceMediaId
      ) {
        throw new Error('Core returned a job for a different meeting or media.')
      }
      setJob(current)
    } catch (error) {
      setJobError(readableError(error))
    } finally {
      setJobPending(false)
    }
  }

  const loadTranscript = async () => {
    if (!meetingId || !jobIsTerminal || job?.status === 'FAILED') return
    setTranscriptPending(true)
    setTranscriptError(null)
    setCorrectionMessage(null)
    try {
      const evidence = await fetchFinalizedTranscriptEvidence(meetingId, 'vi')
      setTranscript(evidence)
      setCorrections(
        Object.fromEntries(
          evidence.transcript.segments.map((segment) => [
            segment.id,
            { text: segment.text, reason: '', approved: false },
          ])
        )
      )
    } catch (error) {
      setTranscriptError(readableError(error))
    } finally {
      setTranscriptPending(false)
    }
  }

  const updateCorrection = (
    segmentId: string,
    update: Partial<CorrectionDraft>
  ) => {
    setCorrections((current) => ({
      ...current,
      [segmentId]: {
        text: current[segmentId]?.text ?? '',
        reason: current[segmentId]?.reason ?? '',
        approved: current[segmentId]?.approved ?? false,
        ...update,
      },
    }))
  }

  const saveCorrection = async (segmentId: string) => {
    if (!meetingId || !transcript || correctionPending) return
    const segment = transcript.transcript.segments.find(
      (candidate) => candidate.id === segmentId
    )
    const draft = corrections[segmentId]
    if (!segment || !draft?.approved || !draft.text.trim()) return
    if (draft.text.trim() === segment.text.trim()) return

    setCorrectionPending(segmentId)
    setTranscriptError(null)
    setCorrectionMessage(null)
    try {
      await applyApprovedTranscriptCorrection(
        meetingId,
        segmentId,
        transcriptSegmentEtag(segment),
        {
          text: draft.text,
          reason: draft.reason.trim() || null,
          operatorApproved: true,
        }
      )
      await loadTranscript()
      setCorrectionMessage(
        'The approved correction was saved and the finalized transcript was read back.'
      )
    } catch (error) {
      setTranscriptError(readableError(error))
    } finally {
      setCorrectionPending(null)
    }
  }

  const readResults = async () => {
    if (!meetingId || !jobIsTerminal || job?.status === 'FAILED') return
    setResultsPending(true)
    setResultsError(null)
    setWorkflowError(null)
    try {
      setResults(await readMeetingIntelligenceResults(meetingId))
    } catch (error) {
      const message = readableError(error)
      setResultsError(message)
      setWorkflowError({ step: 'Reading MI results', message })
    } finally {
      setResultsPending(false)
    }
  }

  const performProposalAction = async () => {
    if (!proposalAction || !results || !meetingId) return
    const actionKey = `${proposalAction.kind}:${proposalAction.id}:${proposalAction.action}`
    setProposalPending(actionKey)
    setProposalError(null)
    try {
      if (proposalAction.kind === 'decision') {
        const current = results.decisions.find(
          (item) => item.decision.id === proposalAction.id
        )
        if (!current) return
        const updated =
          proposalAction.action === 'confirm'
            ? await confirmDecision(
                meetingId,
                current.decision.id,
                current.etag
              )
            : await rejectDecision(meetingId, current.decision.id, current.etag)
        setResults((previous) =>
          previous
            ? {
                ...previous,
                decisions: previous.decisions.map((item) =>
                  item.decision.id === updated.decision.id ? updated : item
                ),
              }
            : previous
        )
      } else {
        const current = results.actionItems.find(
          (item) => item.actionItem.id === proposalAction.id
        )
        if (!current) return
        const updated =
          proposalAction.action === 'confirm'
            ? await confirmActionItem(
                current.actionItem.id,
                actionItemEtag(current.actionItem)
              )
            : await rejectActionItem(
                current.actionItem.id,
                actionItemEtag(current.actionItem)
              )
        setResults((previous) =>
          previous
            ? {
                ...previous,
                actionItems: previous.actionItems.map((item) =>
                  item.actionItem.id === updated.actionItem.id ? updated : item
                ),
              }
            : previous
        )
      }
    } catch (error) {
      setProposalError(readableError(error))
    } finally {
      setProposalPending(null)
      setProposalAction(null)
    }
  }

  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='flex flex-1 flex-col gap-6'>
        <div>
          <p className='text-sm font-medium text-primary'>
            Operator-assisted preparation
          </p>
          <h1 className='mt-1 text-2xl font-bold tracking-tight sm:text-3xl'>
            Vietnamese MI E2E workflow
          </h1>
          <p className='mt-2 max-w-3xl text-muted-foreground'>
            This browser-only helper prepares one future bounded run. It does
            not start workers, enable gates, call OpenRouter, or retry failed
            processing jobs.
          </p>
        </div>

        <Alert>
          <ShieldCheck />
          <AlertTitle>Preparation only</AlertTitle>
          <AlertDescription>
            The operator owns this normal Web session and every approval. Core
            requests use HttpOnly cookies plus the existing CSRF mechanism.
            Signed storage capabilities are consumed once and never displayed
            here.
          </AlertDescription>
        </Alert>

        {workflowError && (
          <Alert variant='destructive'>
            <AlertCircle />
            <AlertTitle>{workflowError.step}</AlertTitle>
            <AlertDescription>{workflowError.message}</AlertDescription>
          </Alert>
        )}

        <SessionCard
          session={session}
          pending={sessionPending}
          error={sessionError}
          onVerify={() => void verifySession()}
        />

        <MeetingCard
          title={title}
          description={description}
          setTitle={setTitle}
          setDescription={setDescription}
          disabled={creationStarted || Boolean(meetingResult)}
          canCreate={canCreate}
          pending={creationPending}
          error={creationError}
          meeting={meetingResult}
          approvalOpen={meetingApprovalOpen}
          onApprovalOpenChange={setMeetingApprovalOpen}
          onApprove={() => void createMeetingRequest()}
          onReplay={() => void createMeetingRequest()}
        />

        <MediaCard
          meetingId={meetingId}
          file={mediaFile}
          onFileChange={setMediaFile}
          canUpload={canUpload}
          attempted={mediaAttempted}
          pending={mediaPending}
          error={mediaError}
          media={media}
          onUpload={() => void uploadMedia()}
        />

        <ProcessingCard
          job={job}
          canAdmit={canAdmitJob}
          attempted={jobAttempted}
          pending={jobPending}
          error={jobError}
          onAdmit={() => void admitJob()}
          onRefresh={() => void refreshJob()}
        />

        <TranscriptCard
          job={job}
          evidence={transcript}
          pending={transcriptPending}
          error={transcriptError}
          correctionMessage={correctionMessage}
          corrections={corrections}
          correctionPending={correctionPending}
          onReview={() => void loadTranscript()}
          onCorrectionChange={updateCorrection}
          onSaveCorrection={(segmentId) => void saveCorrection(segmentId)}
        />

        <ResultsCard
          job={job}
          evidence={transcript}
          results={results}
          pending={resultsPending}
          error={resultsError}
          proposalError={proposalError}
          proposalPending={proposalPending}
          onRead={() => void readResults()}
          onProposalAction={setProposalAction}
        />
      </Main>

      <AlertDialog
        open={Boolean(proposalAction)}
        onOpenChange={(open) => {
          if (!open && !proposalPending) setProposalAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve proposal action</AlertDialogTitle>
            <AlertDialogDescription>
              This is a separate Core mutation. The helper will not confirm or
              reject anything until you approve this exact action.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(proposalPending)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void performProposalAction()}
              disabled={Boolean(proposalPending)}
            >
              {proposalPending ? 'Submitting...' : 'Approve this action'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function SessionCard({
  session,
  pending,
  error,
  onVerify,
}: {
  session: OperatorSession | null
  pending: boolean
  error: string | null
  onVerify: () => void
}) {
  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle className='flex items-center gap-2'>
          <ShieldCheck className='size-4 text-primary' />
          1. Verify the browser session
        </CardTitle>
        <CardDescription>
          Refreshes the normal Web identity through <code>/auth/me</code>.
          Browser secrets remain in the browser.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4 pt-6'>
        {session ? (
          <div className='rounded-lg border bg-muted/30 p-4 text-sm'>
            <div className='flex items-center gap-2 font-medium'>
              <CheckCircle2 className='size-4 text-emerald-600' />
              Authenticated identity verified
            </div>
            <dl className='mt-3 grid gap-2 sm:grid-cols-2'>
              <EvidenceRow
                label='Display name'
                value={session.user.displayName}
              />
              <EvidenceRow label='Role' value={session.user.globalRole} />
              <EvidenceRow label='Account' value={session.user.accountStatus} />
              <EvidenceRow
                label='Client'
                value={session.user.session.clientType}
              />
              <EvidenceRow
                label='User ID'
                value={shortIdentifier(session.user.userId)}
              />
            </dl>
            {session.user.userId !== EXPECTED_OPERATOR_USER_ID && (
              <p className='mt-3 text-sm text-destructive'>
                This is not the expected E2E-04 operator. Creation is blocked.
              </p>
            )}
          </div>
        ) : (
          <p className='text-sm text-muted-foreground'>
            Expected operator: {EXPECTED_OPERATOR_DISPLAY_NAME} (
            {shortIdentifier(EXPECTED_OPERATOR_USER_ID)}).
          </p>
        )}
        {error && <p className='text-sm text-destructive'>{error}</p>}
        <Button type='button' onClick={onVerify} disabled={pending}>
          <RefreshCw className={pending ? 'animate-spin' : undefined} />
          {pending
            ? 'Verifying...'
            : session
              ? 'Refresh Web session'
              : 'Verify Web session'}
        </Button>
      </CardContent>
    </Card>
  )
}

function MeetingCard({
  title,
  description,
  setTitle,
  setDescription,
  disabled,
  canCreate,
  pending,
  error,
  meeting,
  approvalOpen,
  onApprovalOpenChange,
  onApprove,
  onReplay,
}: {
  title: string
  description: string
  setTitle: (value: string) => void
  setDescription: (value: string) => void
  disabled: boolean
  canCreate: boolean
  pending: boolean
  error: string | null
  meeting: SyntheticMeetingResult | null
  approvalOpen: boolean
  onApprovalOpenChange: (open: boolean) => void
  onApprove: () => void
  onReplay: () => void
}) {
  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle>2. Create exactly one synthetic meeting</CardTitle>
        <CardDescription>
          Reuses the existing Core meeting-create operation. Organizer and
          creator are read back from Core; no organizer ID is supplied by the
          browser.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4 pt-6'>
        <label className='grid gap-1.5 text-sm font-medium'>
          Synthetic title
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={disabled}
          />
        </label>
        <label className='grid gap-1.5 text-sm font-medium'>
          Description
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={disabled}
            rows={3}
          />
        </label>

        {meeting ? (
          <div className='rounded-lg border bg-muted/30 p-4 text-sm'>
            <div className='flex items-center gap-2 font-medium'>
              <CheckCircle2 className='size-4 text-emerald-600' />
              Organizer verified
            </div>
            <dl className='mt-3 grid gap-2 sm:grid-cols-3'>
              <EvidenceRow
                label='Meeting'
                value={shortIdentifier(meeting.meeting.meeting.id)}
              />
              <EvidenceRow
                label='Status'
                value={meeting.meeting.meeting.status}
              />
              <EvidenceRow
                label='Organizer'
                value={shortIdentifier(meeting.detail.meeting.organizerUserId)}
              />
            </dl>
          </div>
        ) : (
          <Button
            type='button'
            onClick={() => onApprovalOpenChange(true)}
            disabled={!canCreate}
          >
            {pending ? 'Creating...' : 'Create exactly one synthetic meeting'}
          </Button>
        )}

        {error && (
          <Alert variant='destructive'>
            <AlertCircle />
            <AlertTitle>Meeting creation needs operator review</AlertTitle>
            <AlertDescription className='space-y-2'>
              <p>{error}</p>
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={onReplay}
                disabled={pending}
              >
                Replay the exact create request
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <AlertDialog open={approvalOpen} onOpenChange={onApprovalOpenChange}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Approve meeting creation</AlertDialogTitle>
              <AlertDialogDescription>
                Core will create one DRAFT meeting as the authenticated
                operator. The idempotency key is kept only in this page state.
                Approve only if this is the one intended synthetic meeting.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onApprove} disabled={pending}>
                {pending ? 'Creating...' : 'I approve meeting creation'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

function MediaCard({
  meetingId,
  file,
  onFileChange,
  canUpload,
  attempted,
  pending,
  error,
  media,
  onUpload,
}: {
  meetingId?: string
  file: File | null
  onFileChange: (file: File | null) => void
  canUpload: boolean
  attempted: boolean
  pending: boolean
  error: string | null
  media: FinalizedMedia | null
  onUpload: () => void
}) {
  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle className='flex items-center gap-2'>
          <FileAudio className='size-4 text-primary' />
          3. Upload and finalize one media source
        </CardTitle>
        <CardDescription>
          Core issues the upload intent; the browser performs one credentialless
          signed PUT and one Core finalization. Signed URLs are never rendered.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4 pt-6'>
        {!meetingId && (
          <p className='text-sm text-muted-foreground'>
            Create and verify the meeting first.
          </p>
        )}
        <label className='grid gap-1.5 text-sm font-medium'>
          Synthetic Vietnamese audio
          <Input
            type='file'
            accept='audio/*,.wav,.mp3,.m4a,.ogg,.webm'
            disabled={!meetingId || attempted}
            onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
          />
        </label>
        {file && (
          <p className='text-sm text-muted-foreground'>
            Selected {file.name} · {file.size} bytes ·{' '}
            {file.type || 'missing MIME type'}
          </p>
        )}
        <Button type='button' onClick={onUpload} disabled={!canUpload}>
          {pending ? 'Uploading and finalizing...' : 'Upload and finalize once'}
        </Button>
        {attempted && !media && !pending && !error && (
          <p className='text-sm text-muted-foreground'>
            The single upload/finalization attempt is in progress or awaiting an
            authoritative result.
          </p>
        )}
        {media && (
          <div className='rounded-lg border bg-muted/30 p-4 text-sm'>
            <div className='flex items-center gap-2 font-medium'>
              <CheckCircle2 className='size-4 text-emerald-600' />
              Media finalized as AVAILABLE
            </div>
            <dl className='mt-3 grid gap-2 sm:grid-cols-2'>
              <EvidenceRow label='Media' value={shortIdentifier(media.id)} />
              <EvidenceRow
                label='Meeting'
                value={shortIdentifier(media.meetingId)}
              />
              <EvidenceRow
                label='Size'
                value={`${media.sizeBytes ?? 0} bytes`}
              />
              <EvidenceRow
                label='SHA-256'
                value={media.sha256 ?? 'Unavailable'}
              />
            </dl>
          </div>
        )}
        {error && <p className='text-sm text-destructive'>{error}</p>}
      </CardContent>
    </Card>
  )
}

function ProcessingCard({
  job,
  canAdmit,
  attempted,
  pending,
  error,
  onAdmit,
  onRefresh,
}: {
  job: ProcessingJob | null
  canAdmit: boolean
  attempted: boolean
  pending: boolean
  error: string | null
  onAdmit: () => void
  onRefresh: () => void
}) {
  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle>4. Admit one full processing job</CardTitle>
        <CardDescription>
          This is the Core public admission endpoint with one stable
          Idempotency-Key. The helper exposes status refresh only; it never
          calls the retry endpoint.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4 pt-6'>
        {!job && !attempted && (
          <p className='text-sm text-muted-foreground'>
            Finalize media first. Only one admission is available in this page.
          </p>
        )}
        <Button type='button' onClick={onAdmit} disabled={!canAdmit}>
          {pending ? 'Admitting...' : 'Admit one processing job'}
        </Button>
        {job && (
          <div className='rounded-lg border bg-muted/30 p-4 text-sm'>
            <dl className='grid gap-2 sm:grid-cols-3'>
              <EvidenceRow label='Job' value={shortIdentifier(job.id)} />
              <EvidenceRow label='Status' value={job.status} />
              <EvidenceRow
                label='Requested by'
                value={shortIdentifier(job.requestedByUserId)}
              />
            </dl>
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='mt-4'
              onClick={onRefresh}
              disabled={pending}
            >
              <RefreshCw className={pending ? 'animate-spin' : undefined} />
              Refresh job status
            </Button>
            {job.status === 'FAILED' && (
              <p className='mt-3 text-sm text-destructive'>
                The job is FAILED. No retry control is provided by this helper.
              </p>
            )}
          </div>
        )}
        {error && <p className='text-sm text-destructive'>{error}</p>}
      </CardContent>
    </Card>
  )
}

function TranscriptCard({
  job,
  evidence,
  pending,
  error,
  correctionMessage,
  corrections,
  correctionPending,
  onReview,
  onCorrectionChange,
  onSaveCorrection,
}: {
  job: ProcessingJob | null
  evidence: FinalizedTranscriptEvidence | null
  pending: boolean
  error: string | null
  correctionMessage: string | null
  corrections: Record<string, CorrectionDraft>
  correctionPending: string | null
  onReview: () => void
  onCorrectionChange: (
    segmentId: string,
    update: Partial<CorrectionDraft>
  ) => void
  onSaveCorrection: (segmentId: string) => void
}) {
  const ready =
    job?.status === 'COMPLETED' || job?.status === 'COMPLETED_WITH_WARNINGS'
  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle className='flex items-center gap-2'>
          <FileCheck2 className='size-4 text-primary' />
          5. Review and finalize the Vietnamese transcript
        </CardTitle>
        <CardDescription>
          Each correction is an independent operator approval using the current
          segment version ETag. After every approval, the helper reads back the
          finalized revision and digest.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4 pt-6'>
        {!evidence && (
          <Button type='button' onClick={onReview} disabled={!ready || pending}>
            {pending
              ? 'Reading transcript...'
              : 'Review finalized Vietnamese transcript'}
          </Button>
        )}
        {!ready && !evidence && (
          <p className='text-sm text-muted-foreground'>
            Wait for an observed COMPLETED or COMPLETED_WITH_WARNINGS job
            status; this page does not poll automatically.
          </p>
        )}
        {evidence && (
          <>
            <div className='rounded-lg border bg-muted/30 p-4 text-sm'>
              <dl className='grid gap-2 sm:grid-cols-4'>
                <EvidenceRow
                  label='Language'
                  value={evidence.transcript.languageCode}
                />
                <EvidenceRow
                  label='Status'
                  value={evidence.transcript.status}
                />
                <EvidenceRow
                  label='Content revision'
                  value={String(evidence.transcript.contentRevision)}
                />
                <EvidenceRow label='ETag' value={evidence.etag} />
              </dl>
              <div className='mt-3'>
                <EvidenceRow
                  label='Correction digest'
                  value={evidence.digest}
                />
              </div>
            </div>
            <div className='space-y-4'>
              {evidence.transcript.segments.map((segment) => {
                const draft = corrections[segment.id] ?? {
                  text: segment.text,
                  reason: '',
                  approved: false,
                }
                const changed = draft.text.trim() !== segment.text.trim()
                return (
                  <div key={segment.id} className='rounded-lg border p-4'>
                    <div className='flex flex-wrap justify-between gap-2 text-xs text-muted-foreground'>
                      <span>
                        Segment {segment.ordinal + 1} ·{' '}
                        {formatMilliseconds(segment.startMs)}–
                        {formatMilliseconds(segment.endMs)}
                      </span>
                      <span>Version {segment.version}</span>
                    </div>
                    <Textarea
                      className='mt-3'
                      value={draft.text}
                      maxLength={20_000}
                      aria-label={`Correction for segment ${segment.ordinal + 1}`}
                      onChange={(event) =>
                        onCorrectionChange(segment.id, {
                          text: event.target.value,
                          approved: false,
                        })
                      }
                      disabled={Boolean(correctionPending)}
                    />
                    <Input
                      className='mt-3'
                      value={draft.reason}
                      maxLength={1000}
                      aria-label={`Correction reason for segment ${segment.ordinal + 1}`}
                      placeholder='Optional reason'
                      onChange={(event) =>
                        onCorrectionChange(segment.id, {
                          reason: event.target.value,
                          approved: false,
                        })
                      }
                      disabled={Boolean(correctionPending)}
                    />
                    <label className='mt-3 flex items-start gap-2 text-sm'>
                      <input
                        type='checkbox'
                        checked={draft.approved}
                        onChange={(event) =>
                          onCorrectionChange(segment.id, {
                            approved: event.target.checked,
                          })
                        }
                        disabled={!changed || Boolean(correctionPending)}
                      />
                      <span>I reviewed and approve this exact correction.</span>
                    </label>
                    <Button
                      type='button'
                      className='mt-3'
                      size='sm'
                      onClick={() => onSaveCorrection(segment.id)}
                      disabled={
                        !changed ||
                        !draft.approved ||
                        Boolean(correctionPending)
                      }
                    >
                      {correctionPending === segment.id
                        ? 'Saving correction...'
                        : 'Approve and save this correction'}
                    </Button>
                  </div>
                )
              })}
            </div>
            {correctionMessage && (
              <p className='text-sm text-emerald-700'>{correctionMessage}</p>
            )}
            {error && <p className='text-sm text-destructive'>{error}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function ResultsCard({
  job,
  evidence,
  results,
  pending,
  error,
  proposalError,
  proposalPending,
  onRead,
  onProposalAction,
}: {
  job: ProcessingJob | null
  evidence: FinalizedTranscriptEvidence | null
  results: MeetingIntelligenceReview | null
  pending: boolean
  error: string | null
  proposalError: string | null
  proposalPending: string | null
  onRead: () => void
  onProposalAction: (action: ProposalAction) => void
}) {
  const ready =
    evidence &&
    (job?.status === 'COMPLETED' || job?.status === 'COMPLETED_WITH_WARNINGS')
  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle>6. Read and evaluate generated Vietnamese results</CardTitle>
        <CardDescription>
          Summary, Decision, and Action Item projections are read-only until the
          operator separately approves a proposal action.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-5 pt-6'>
        {!results && (
          <Button type='button' onClick={onRead} disabled={!ready || pending}>
            {pending
              ? 'Reading results...'
              : 'Read Summary, Decisions, and Action Items'}
          </Button>
        )}
        {!ready && !results && (
          <p className='text-sm text-muted-foreground'>
            Finalized Vietnamese transcript and a terminal successful job are
            required before result review.
          </p>
        )}
        {results && (
          <>
            <section className='space-y-3'>
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <h3 className='font-semibold'>Summary</h3>
                <span className='text-xs text-muted-foreground'>
                  Prompt contract:{' '}
                  {OPERATOR_MI_SUMMARY_CONTRACT.extractionPromptVersion}
                </span>
              </div>
              <div className='rounded-lg border bg-muted/30 p-4 text-sm leading-6 whitespace-pre-wrap'>
                {results.summary.summary.content}
              </div>
              <Provenance
                producer={results.summary.summary.aiProducer}
                warnings={results.summary.summary.aiWarnings}
              />
            </section>

            <ProposalSection
              title='Decision proposals'
              emptyLabel='No Decision proposals returned.'
              items={results.decisions}
              kind='decision'
              pending={proposalPending}
              onAction={onProposalAction}
            />
            <ProposalSection
              title='Action Item proposals'
              emptyLabel='No Action Item proposals returned.'
              items={results.actionItems}
              kind='action-item'
              pending={proposalPending}
              onAction={onProposalAction}
            />
            {error && <p className='text-sm text-destructive'>{error}</p>}
            {proposalError && (
              <p className='text-sm text-destructive'>{proposalError}</p>
            )}
            <Alert>
              <ShieldCheck />
              <AlertTitle>Proposal authority remains separate</AlertTitle>
              <AlertDescription>
                No proposal was confirmed or rejected by reading these results.
                Each action above requires a new operator approval.
              </AlertDescription>
            </Alert>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function ProposalSection({
  title,
  emptyLabel,
  items,
  kind,
  pending,
  onAction,
}: {
  title: string
  emptyLabel: string
  items: DecisionReview[] | ActionItemReview[]
  kind: 'decision' | 'action-item'
  pending: string | null
  onAction: (action: ProposalAction) => void
}) {
  return (
    <section className='space-y-3'>
      <h3 className='font-semibold'>{title}</h3>
      {!items.length ? (
        <p className='text-sm text-muted-foreground'>{emptyLabel}</p>
      ) : (
        <div className='space-y-3'>
          {items.map((item) => {
            const id =
              kind === 'decision'
                ? (item as DecisionReview).decision.id
                : (item as ActionItemReview).actionItem.id
            const status =
              kind === 'decision'
                ? (item as DecisionReview).decision.status
                : (item as ActionItemReview).actionItem.status
            const content =
              kind === 'decision'
                ? (item as DecisionReview).decision.content
                : (item as ActionItemReview).actionItem.title
            const actionPrefix =
              kind === 'decision' ? 'decision' : 'action-item'
            return (
              <div key={id} className='rounded-lg border p-4'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <span className='text-xs text-muted-foreground'>
                    {shortIdentifier(id)}
                  </span>
                  <span className='text-xs font-medium'>{status}</span>
                </div>
                <p className='mt-2 text-sm leading-6 whitespace-pre-wrap'>
                  {content}
                </p>
                {status === 'PROPOSED' && (
                  <div className='mt-3 flex flex-wrap gap-2'>
                    <Button
                      type='button'
                      size='sm'
                      onClick={() => onAction({ kind, id, action: 'confirm' })}
                      disabled={Boolean(pending)}
                    >
                      Confirm this proposal
                    </Button>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      onClick={() => onAction({ kind, id, action: 'reject' })}
                      disabled={Boolean(pending)}
                    >
                      Reject this proposal
                    </Button>
                  </div>
                )}
                <p className='mt-2 text-xs text-muted-foreground'>
                  Evidence and provenance remain visible for Vietnamese human
                  evaluation; this control is not a bulk action.
                </p>
                <span className='sr-only'>{actionPrefix}</span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function Provenance({
  producer,
  warnings,
}: {
  producer?: {
    provider: string | null
    model: string
    promptVersion: string
  } | null
  warnings: string[]
}) {
  return (
    <div className='text-xs text-muted-foreground'>
      <p>
        Producer:{' '}
        {producer
          ? `${producer.provider ?? 'provider unavailable'} / ${producer.model} / ${producer.promptVersion}`
          : 'not returned by Core'}
      </p>
      {warnings.length > 0 && <p>Warnings: {warnings.join(', ')}</p>}
    </div>
  )
}

function EvidenceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex min-w-0 items-start justify-between gap-3'>
      <dt className='text-muted-foreground'>{label}</dt>
      <dd className='max-w-[70%] text-end font-medium break-all'>{value}</dd>
    </div>
  )
}

function readableError(error: unknown): string {
  const normalized = normalizeCoreApiError(error)
  return normalized.message || 'The Core API operation could not be verified.'
}

function createIdempotencyKey(prefix: string): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function shortIdentifier(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value
}

function formatMilliseconds(value: number): string {
  const totalSeconds = Math.floor(value / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
