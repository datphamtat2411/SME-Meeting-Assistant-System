import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  FileAudio,
  Link2,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { CoreApiError, normalizeCoreApiError } from '@/lib/core-api'
import { i18n, useUiTranslation } from '@/lib/i18n'
import {
  featureValidationMessage,
  localizedValidationMessage,
  operationErrorFormMessage,
  UiPresentationError,
} from '@/lib/i18n/presentation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RegionalTimestamp } from '@/components/regional-timestamp'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import {
  meetingDetailQueryOptions,
  meetingParticipantsQueryOptions,
} from '@/features/meetings/data/detail-api'
import {
  MeetingSessionBoundary,
  useMeetingSession,
} from '../media/meeting-session-context'
import { PlaybackControls } from '../media/playback-controls'
import {
  presentProcessingStage,
  presentProcessingStatus,
} from '../media/processing-status-presentation'
import { useOptionalMeetingAuthorization } from '../meeting-authorization-context'
import type { EvidenceReferenceIssue } from '../meeting-workspace-navigation'
import { invalidateMeetingArtifacts } from './query-invalidation'
import {
  correctTranscriptSegment,
  mapSpeaker,
  reviewCoverageQuery,
  reviewSpeakersQuery,
  timecode,
  transcriptReviewQuery,
  type Speaker,
  type Transcript,
  type TranscriptCoverage,
  type TranscriptReview,
} from './transcript-api'
import {
  useOptionalTranscriptReviewGate,
  type TranscriptReviewDigestSegment,
} from './transcript-review-gate'
import {
  useTranscriptReviewOperation,
  type ReviewExecution,
} from './use-transcript-review-operation'

type TranscriptSegment = Transcript['segments'][number]

type SegmentDraft = {
  transcriptId: string
  baseVersion: number
  baseEtag: string | undefined
  originalText: string
  text: string
  reason: string
}

type MappingDraft = {
  transcriptId: string
  etag: string
  speakerId: string
  originalUserId: string | null
  userId?: string | null
}

type SpeakerCandidate = {
  id: string
  displayName: string
}

type CorrectionNotice =
  | {
      kind: 'conflict'
      segmentId: string
      attemptedVersion: number
      currentVersion: number | null
    }
  | {
      kind: 'uncertain' | 'error'
      segmentId: string
      message: string
    }

type MappingNotice =
  | {
      kind: 'conflict'
      speakerId: string
    }
  | {
      kind: 'uncertain' | 'error'
      speakerId: string
      message: string
    }

class LocalTranscriptConflictError extends Error {
  readonly status = 412

  constructor(message = 'The transcript changed while it was being edited.') {
    super(message)
    this.name = 'LocalTranscriptConflictError'
  }
}

function isConflict(error: unknown): boolean {
  if (error instanceof LocalTranscriptConflictError) return true
  const normalized = normalizeCoreApiError(error)
  return normalized.status === 409 || normalized.status === 412
}

function isUncertainMutation(error: unknown): boolean {
  if (!(error instanceof CoreApiError)) return false
  const normalized = normalizeCoreApiError(error)
  return (
    normalized.recoveryOutcome === 'uncertain' ||
    normalized.kind === 'network' ||
    normalized.kind === 'malformed' ||
    (typeof normalized.status === 'number' && normalized.status >= 500)
  )
}

function sortSegments(
  segments: readonly TranscriptSegment[]
): TranscriptSegment[] {
  return [...segments].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.ordinal - right.ordinal ||
      left.id.localeCompare(right.id)
  )
}

function timelineDuration(
  transcript: Transcript,
  coverage: readonly TranscriptCoverage[]
): number {
  if (transcript.durationMs !== null && transcript.durationMs > 0) {
    return transcript.durationMs
  }
  return Math.max(
    1,
    ...transcript.segments.map((segment) => segment.endMs),
    ...coverage.map((region) => region.endMs)
  )
}

function sortCoverageRegions(
  regions: readonly TranscriptCoverage[]
): TranscriptCoverage[] {
  return [...regions].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      left.id.localeCompare(right.id)
  )
}

function statusBadgeVariant(
  status: string
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (status === 'READY') return 'default'
  if (status === 'READY_WITH_WARNINGS') return 'secondary'
  if (status === 'FAILED' || status === 'UNRESOLVED_ERROR') {
    return 'destructive'
  }
  return 'outline'
}

function coverageStatusLabel(
  status: TranscriptCoverage['coverageStatus'],
  t: (key: string) => string
) {
  switch (status) {
    case 'COVERED':
      return t('transcript:review_covered')
    case 'SUSPICIOUS':
      return t('transcript:review_suspicious')
    case 'UNRESOLVED_ERROR':
      return t('transcript:review_unresolvedError')
  }
}

function speakerName(
  segment: TranscriptSegment,
  speakers: Speaker[],
  unknownSpeaker = 'Unknown speaker'
): string {
  const speaker = segment.speakerClusterId
    ? speakers.find((item) => item.id === segment.speakerClusterId)
    : undefined
  return (
    speaker?.displayName ??
    segment.speakerLabel ??
    speaker?.label ??
    unknownSpeaker
  )
}

function sourcePositionLabel(
  sourceAvailable: boolean,
  sourceLoading: boolean,
  t: (key: string) => string
): string {
  if (sourceAvailable) return t('transcript:review_playSource')
  if (sourceLoading) return t('transcript:review_checkingSource')
  return t('transcript:review_sourceUnavailable')
}

function operationErrorMessage(error: unknown, fallback: string): string {
  const normalized = normalizeCoreApiError(error)
  return normalized.status === 403
    ? featureValidationMessage('transcript:review_operationUnauthorized')
    : normalized.status === 404
      ? featureValidationMessage('transcript:review_canonicalUnavailable')
      : error instanceof CoreApiError || error instanceof UiPresentationError
        ? operationErrorFormMessage(error)
        : fallback
}

export function TranscriptReviewWorkspace({
  meetingId,
  canReadMeetingContent,
  canCorrectTranscript,
  canMapSpeakers,
  canReadMedia,
  evidenceTranscriptId,
  evidenceSegmentId,
  evidenceContentRevision,
  evidenceReferenceIssue,
}: {
  meetingId: string
  canReadMeetingContent: boolean
  canCorrectTranscript: boolean
  canMapSpeakers: boolean
  canReadMedia: boolean
  evidenceTranscriptId?: string
  evidenceSegmentId?: string
  evidenceContentRevision?: number
  evidenceReferenceIssue?: EvidenceReferenceIssue
}) {
  const authorization = useOptionalMeetingAuthorization()
  const denied = Boolean(
    authorization?.isConfirmedAccessLoss ||
    authorization?.capabilities.authorizationResolution === 'denied' ||
    (!authorization && !canReadMeetingContent)
  )
  const scopeKey = `${meetingId}:${authorization?.identity?.userId ?? 'standalone'}:${denied}`
  return (
    <MeetingSessionBoundary
      meetingId={meetingId}
      fallbackCapabilities={{ canReadMedia }}
    >
      <TranscriptReviewWorkspaceContent
        key={scopeKey}
        evidenceTranscriptId={evidenceTranscriptId}
        evidenceSegmentId={evidenceSegmentId}
        evidenceContentRevision={evidenceContentRevision}
        evidenceReferenceIssue={evidenceReferenceIssue}
        meetingId={meetingId}
        canReadMeetingContent={canReadMeetingContent}
        canCorrectTranscript={canCorrectTranscript}
        canMapSpeakers={canMapSpeakers}
      />
    </MeetingSessionBoundary>
  )
}

function TranscriptReviewWorkspaceContent({
  meetingId,
  canReadMeetingContent,
  canCorrectTranscript,
  canMapSpeakers,
  evidenceTranscriptId,
  evidenceSegmentId,
  evidenceContentRevision,
  evidenceReferenceIssue,
}: {
  meetingId: string
  canReadMeetingContent: boolean
  canCorrectTranscript: boolean
  canMapSpeakers: boolean
  evidenceTranscriptId?: string
  evidenceSegmentId?: string
  evidenceContentRevision?: number
  evidenceReferenceIssue?: EvidenceReferenceIssue
}) {
  const { t } = useUiTranslation()
  const queryClient = useQueryClient()
  const session = useMeetingSession()
  const authorization = useOptionalMeetingAuthorization()
  const protectedScopeReady =
    !authorization ||
    (authorization.scopeReady &&
      authorization.canReadProtectedData &&
      authorization.capabilities.canReadMeetingContent &&
      !authorization.isConfirmedAccessLoss)
  const canRead = canReadMeetingContent && protectedScopeReady
  const confirmedAccessLoss = Boolean(
    authorization?.isConfirmedAccessLoss ||
    authorization?.capabilities.authorizationResolution === 'denied' ||
    (!authorization && !canReadMeetingContent)
  )
  const canCorrect =
    canCorrectTranscript &&
    canRead &&
    (!authorization ||
      (authorization.canPerformProtectedOperation &&
        authorization.capabilities.canCorrectTranscript))
  const canMap =
    canMapSpeakers &&
    canRead &&
    (!authorization ||
      (authorization.canPerformProtectedOperation &&
        authorization.capabilities.canMapSpeakers))

  const transcriptReview = useQuery({
    ...transcriptReviewQuery(meetingId),
    enabled: canRead,
  })
  const transcriptSnapshot = transcriptReview.data ?? null
  const transcriptValue = transcriptSnapshot?.transcript
  const isFinalized = Boolean(
    transcriptValue &&
    ['READY', 'READY_WITH_WARNINGS'].includes(transcriptValue.status) &&
    transcriptValue.finalizedAt
  )
  const canEditCanonicalTranscript = canCorrect && isFinalized
  const canMapCanonicalSpeakers =
    canMap && isFinalized && Boolean(transcriptReview.data?.etag)

  const coverage = useQuery({
    ...reviewCoverageQuery(meetingId, transcriptReview.data),
    enabled: canRead && transcriptReview.isSuccess,
  })
  const speakers = useQuery({
    ...reviewSpeakersQuery(meetingId, transcriptReview.data),
    enabled: canRead && transcriptReview.isSuccess,
  })

  const [searchInput, setSearchInput] = useState('')
  const [speakerFilter, setSpeakerFilter] = useState('all')
  const [qualityFilter, setQualityFilter] = useState('all')
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null
  )
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, SegmentDraft>>({})
  const [storedCorrectionNotice, setCorrectionNotice] =
    useState<CorrectionNotice | null>(null)
  const [mappingDraft, setMappingDraft] = useState<MappingDraft | null>(null)
  const mappingSpeakerId = mappingDraft?.speakerId ?? null
  const [followPlayback, setFollowPlayback] = useState(false)
  const [candidateSearchInput, setCandidateSearchInput] = useState('')
  const [candidateSearch, setCandidateSearch] = useState('')
  const [storedMappingNotice, setMappingNotice] =
    useState<MappingNotice | null>(null)
  const segmentNodes = useRef<Record<string, HTMLDivElement | null>>({})
  const transcriptRef = useRef<TranscriptReview | null>(null)
  const canCorrectRef = useRef(canEditCanonicalTranscript)
  const canMapRef = useRef(canMapCanonicalSpeakers)
  const operation = useTranscriptReviewOperation(
    {
      meetingId,
      actorId: authorization?.identity?.userId ?? null,
      transcriptId: transcriptValue?.id ?? null,
      canRead,
      confirmedAccessLoss,
      canCorrect: canEditCanonicalTranscript,
      canMap: canMapCanonicalSpeakers,
    },
    session.processing.claimReviewCommand,
    session.processing.releaseReviewCommand
  )
  const reviewGate = useOptionalTranscriptReviewGate()
  const { acquire, isCurrent, release, interrupted, clearInterrupted } =
    operation
  const correctionNotice: CorrectionNotice | null =
    interrupted?.kind === 'correction' && editingSegmentId
      ? {
          kind: 'uncertain',
          segmentId: editingSegmentId,
          message: featureValidationMessage('transcript:review_interrupted'),
        }
      : storedCorrectionNotice
  const mappingNotice: MappingNotice | null =
    interrupted?.kind === 'mapping' && mappingSpeakerId
      ? {
          kind: 'uncertain',
          speakerId: mappingSpeakerId,
          message: featureValidationMessage('transcript:review_interrupted'),
        }
      : storedMappingNotice
  const hasUncertainty =
    correctionNotice?.kind === 'uncertain' ||
    mappingNotice?.kind === 'uncertain'
  const replacementDraft =
    Object.values(drafts).some(
      (draft) => draft.transcriptId !== transcriptValue?.id
    ) ||
    Boolean(mappingDraft && mappingDraft.transcriptId !== transcriptValue?.id)
  const gateWriteBlocked =
    reviewGate?.acknowledgement.status === 'pending' ||
    reviewGate?.acknowledgement.status === 'uncertain' ||
    reviewGate?.admission.status === 'pending' ||
    reviewGate?.admission.status === 'uncertain'
  const blocked =
    operation.pending || hasUncertainty || replacementDraft || gateWriteBlocked
  const setReviewGateBlocked = reviewGate?.setMutationBlocked
  const setReviewDirty = session.setTranscriptReviewDirty
  const reviewDirty =
    Object.keys(drafts).length > 0 ||
    Boolean(mappingDraft) ||
    operation.pending ||
    hasUncertainty ||
    replacementDraft

  useLayoutEffect(() => {
    transcriptRef.current = transcriptSnapshot
    canCorrectRef.current = canEditCanonicalTranscript
    canMapRef.current = canMapCanonicalSpeakers
  }, [transcriptSnapshot, canEditCanonicalTranscript, canMapCanonicalSpeakers])

  useLayoutEffect(() => {
    setReviewDirty?.(!confirmedAccessLoss && reviewDirty)
    return () => setReviewDirty?.(false)
  }, [confirmedAccessLoss, reviewDirty, setReviewDirty])

  useLayoutEffect(() => {
    if (!setReviewGateBlocked) return
    setReviewGateBlocked(!confirmedAccessLoss && reviewDirty)
    return () => setReviewGateBlocked(false)
  }, [confirmedAccessLoss, reviewDirty, setReviewGateBlocked])

  useEffect(() => {
    if (!selectedSegmentId) return
    segmentNodes.current[selectedSegmentId]?.scrollIntoView?.({
      block: 'nearest',
    })
  }, [selectedSegmentId, searchInput, speakerFilter, qualityFilter])

  const orderedSegments = useMemo(
    () => sortSegments(transcriptValue?.segments ?? []),
    [transcriptValue?.segments]
  )
  const availableSpeakers = useMemo(
    () => (speakers.isSuccess && !speakers.isFetching ? speakers.data : []),
    [speakers.data, speakers.isFetching, speakers.isSuccess]
  )
  const qualityOptions = useMemo(
    () =>
      Array.from(
        new Set(orderedSegments.map((segment) => segment.qualityStatus))
      ).sort(),
    [orderedSegments]
  )
  const speakerOptions = useMemo(() => {
    const options = new Map<string, string>()
    for (const segment of orderedSegments) {
      const key = segment.speakerClusterId ?? `label:${segment.speakerLabel}`
      options.set(
        key,
        speakerName(
          segment,
          availableSpeakers,
          t('transcript:review_unknownSpeaker')
        )
      )
    }
    return Array.from(options.entries()).sort((left, right) =>
      left[1].localeCompare(right[1])
    )
  }, [availableSpeakers, orderedSegments, t])
  const filteredSegments = useMemo(() => {
    const search = searchInput.trim().toLocaleLowerCase()
    return orderedSegments.filter((segment) => {
      const matchesSearch =
        !search ||
        segment.text.toLocaleLowerCase().includes(search) ||
        speakerName(
          segment,
          availableSpeakers,
          t('transcript:review_unknownSpeaker')
        )
          .toLocaleLowerCase()
          .includes(search)
      const key = segment.speakerClusterId ?? `label:${segment.speakerLabel}`
      return (
        matchesSearch &&
        (speakerFilter === 'all' || key === speakerFilter) &&
        (qualityFilter === 'all' || segment.qualityStatus === qualityFilter)
      )
    })
  }, [
    availableSpeakers,
    orderedSegments,
    qualityFilter,
    searchInput,
    speakerFilter,
    t,
  ])
  const coverageRegions =
    coverage.isSuccess && !coverage.isFetching ? coverage.data : []
  const durationMs = transcriptValue
    ? timelineDuration(transcriptValue, coverageRegions)
    : 1
  const sourceMediaId = transcriptValue?.sourceMediaId ?? null
  const sourceMedia = sourceMediaId
    ? session.media.data?.find(
        (media) =>
          media.id === sourceMediaId &&
          media.meetingId === meetingId &&
          media.status === 'AVAILABLE'
      )
    : undefined
  const sourceLoading = session.media.isPending || session.media.isFetching
  const selectedJob = transcriptValue
    ? session.processing.jobs.data?.find(
        (job) =>
          job.id === transcriptValue.processingJobId &&
          job.meetingId === meetingId &&
          job.sourceMediaId === transcriptValue.sourceMediaId
      )
    : undefined
  const meetingJobs =
    session.processing.jobs.data?.filter(
      (job) => job.meetingId === meetingId
    ) ?? []
  const activeJobs = meetingJobs.filter((job) =>
    ['PENDING', 'QUEUED', 'RUNNING', 'WAITING_FOR_REVIEW'].includes(job.status)
  )
  const pendingJob =
    (activeJobs.length === 1 ? activeJobs[0] : undefined) ??
    (meetingJobs.length === 1 ? meetingJobs[0] : undefined)
  const detail = useQuery({
    ...meetingDetailQueryOptions(meetingId),
    enabled: canMap && !authorization && Boolean(mappingSpeakerId),
  })
  const participants = useQuery({
    ...meetingParticipantsQueryOptions(meetingId),
    enabled: canMap && !authorization && Boolean(mappingSpeakerId),
  })
  const membershipQuery = authorization?.participantsQuery ?? participants
  const candidateMeeting = authorization?.meeting ?? detail.data?.meeting
  const candidateParticipants = authorization?.participants ?? participants.data
  const candidateIdentity = authorization?.identity
  const eligibleCandidates = useMemo(() => {
    const members = new Map<string, SpeakerCandidate>()
    if (!canMap || candidateMeeting?.id !== meetingId) return []
    const organizerId = candidateMeeting.organizerUserId
    members.set(organizerId, {
      id: organizerId,
      displayName:
        candidateIdentity?.userId === organizerId
          ? candidateIdentity.displayName
          : organizerId,
    })
    if (membershipQuery.isSuccess && !membershipQuery.isFetching) {
      for (const member of candidateParticipants ?? []) {
        if (member.meetingId !== meetingId || member.removedAt !== null) {
          continue
        }
        members.set(member.userId, {
          id: member.userId,
          displayName: member.displayName ?? member.userId,
        })
      }
    }
    return [...members.values()]
  }, [
    candidateIdentity,
    canMap,
    candidateMeeting,
    candidateParticipants,
    meetingId,
    membershipQuery.isFetching,
    membershipQuery.isSuccess,
  ])
  const canReapplyMapping = Boolean(
    mappingDraft &&
    mappingDraft.userId !== undefined &&
    mappingDraft.transcriptId === transcriptValue?.id &&
    availableSpeakers.some(
      (speaker) => speaker.id === mappingDraft.speakerId
    ) &&
    (mappingDraft.userId === null ||
      eligibleCandidates.some((member) => member.id === mappingDraft.userId))
  )
  const candidateResults = eligibleCandidates.filter((candidate) =>
    `${candidate.displayName} ${candidate.id}`
      .toLocaleLowerCase()
      .includes(candidateSearch.toLocaleLowerCase())
  )

  async function refreshEvidence() {
    const refreshed = await transcriptReview.refetch()
    return refreshed.isSuccess ? refreshed.data : undefined
  }

  const correctionMutation = useMutation({
    mutationFn: async (payload: {
      execution: ReviewExecution
      draft: SegmentDraft
      segmentId: string
    }) => {
      const { execution, draft, segmentId } = payload
      if (!isCurrent(execution) || !canCorrectRef.current) {
        throw new UiPresentationError(
          'transcript:review_correctionUnauthorized'
        )
      }
      const snapshot = transcriptRef.current
      const observed = snapshot?.transcript.segments.find(
        (segment) => segment.id === segmentId
      )
      if (
        snapshot?.transcript.id !== draft.transcriptId ||
        !observed ||
        observed.version !== draft.baseVersion ||
        !draft.baseEtag ||
        observed.etag !== draft.baseEtag ||
        observed.text !== draft.originalText
      ) {
        throw new LocalTranscriptConflictError()
      }
      return correctTranscriptSegment(
        meetingId,
        { id: segmentId, etag: draft.baseEtag },
        draft.text,
        draft.reason,
        execution.controller.signal
      )
    },
    onSuccess: async (_, payload) => {
      if (!isCurrent(payload.execution)) return
      invalidateMeetingArtifacts(queryClient, meetingId, {
        transcript: true,
        actions: true,
      })
      const refreshed = await refreshEvidence()
      if (!isCurrent(payload.execution)) return
      setDrafts((current) => {
        const next = { ...current }
        delete next[payload.segmentId]
        return next
      })
      setEditingSegmentId(null)
      setCorrectionNotice(null)
      toast.success(i18n.t('transcript:review_saved'), {
        description: refreshed ? undefined : i18n.t('transcript:review_reload'),
      })
    },
    onError: async (error, payload) => {
      if (!isCurrent(payload.execution)) return
      if (isConflict(error)) {
        const refreshed = await refreshEvidence()
        if (!isCurrent(payload.execution)) return
        const currentVersion =
          refreshed?.transcript.segments.find(
            (segment) => segment.id === payload.segmentId
          )?.version ?? null
        setCorrectionNotice({
          kind: 'conflict',
          segmentId: payload.segmentId,
          attemptedVersion: payload.draft.baseVersion,
          currentVersion,
        })
        return
      }
      const uncertain = isUncertainMutation(error)
      if (uncertain) {
        invalidateMeetingArtifacts(queryClient, meetingId, {
          transcript: true,
          actions: true,
        })
      }
      setCorrectionNotice({
        kind: uncertain ? 'uncertain' : 'error',
        segmentId: payload.segmentId,
        message: operationErrorMessage(
          error,
          featureValidationMessage('transcript:review_saveFailed')
        ),
      })
    },
    onSettled: (_, __, payload) => release(payload.execution),
  })

  const mappingMutation = useMutation({
    mutationFn: async (payload: {
      execution: ReviewExecution
      draft: MappingDraft
      userId: string | null
    }) => {
      if (!isCurrent(payload.execution) || !canMapRef.current) {
        throw new UiPresentationError('transcript:review_mappingUnauthorized')
      }
      const snapshot = transcriptRef.current
      if (
        snapshot?.transcript.id !== payload.draft.transcriptId ||
        snapshot.etag !== payload.draft.etag
      ) {
        throw new LocalTranscriptConflictError()
      }
      return mapSpeaker(
        meetingId,
        payload.draft.speakerId,
        payload.userId,
        payload.draft.etag,
        payload.execution.controller.signal
      )
    },
    onSuccess: async (_, payload) => {
      if (!isCurrent(payload.execution)) return
      invalidateMeetingArtifacts(queryClient, meetingId, {
        transcript: true,
        actions: true,
      })
      await refreshEvidence()
      if (!isCurrent(payload.execution)) return
      setMappingDraft(null)
      setCandidateSearch('')
      setCandidateSearchInput('')
      setMappingNotice(null)
      toast.success(i18n.t('transcript:review_speakerUpdated'))
    },
    onError: async (error, payload) => {
      if (!isCurrent(payload.execution)) return
      if (isConflict(error)) {
        await refreshEvidence()
        if (!isCurrent(payload.execution)) return
        setMappingNotice({
          kind: 'conflict',
          speakerId: payload.draft.speakerId,
        })
        return
      }
      const uncertain = isUncertainMutation(error)
      if (uncertain) {
        invalidateMeetingArtifacts(queryClient, meetingId, {
          transcript: true,
          actions: true,
        })
      }
      setMappingNotice({
        kind: uncertain ? 'uncertain' : 'error',
        speakerId: payload.draft.speakerId,
        message: operationErrorMessage(
          error,
          featureValidationMessage('transcript:review_mappingFailed')
        ),
      })
    },
    onSettled: (_, __, payload) => release(payload.execution),
  })

  function beginCorrection(segment: TranscriptSegment) {
    if (
      blocked ||
      !canEditCanonicalTranscript ||
      !transcriptValue ||
      !segment.etag ||
      (editingSegmentId && editingSegmentId !== segment.id) ||
      mappingDraft
    ) {
      return
    }
    setSelectedSegmentId(segment.id)
    setEditingSegmentId(segment.id)
    setDrafts((current) => ({
      ...current,
      [segment.id]: current[segment.id] ?? {
        transcriptId: transcriptValue.id,
        baseVersion: segment.version,
        baseEtag: segment.etag,
        originalText: segment.text,
        text: segment.text,
        reason: '',
      },
    }))
    setCorrectionNotice(null)
  }

  function updateDraft(
    segmentId: string,
    field: 'text' | 'reason',
    value: string
  ) {
    setDrafts((current) => {
      const draft = current[segmentId]
      if (!draft || operation.pending) return current
      return { ...current, [segmentId]: { ...draft, [field]: value } }
    })
  }

  function submitCorrection(
    event: React.FormEvent<HTMLFormElement>,
    segment: TranscriptSegment
  ) {
    event.preventDefault()
    const draft = drafts[segment.id]
    if (
      blocked ||
      correctionNotice?.kind === 'conflict' ||
      !draft?.baseEtag ||
      !draft.text.trim() ||
      !canEditCanonicalTranscript
    ) {
      return
    }
    const execution = acquire('correction')
    if (!execution) return
    correctionMutation.mutate({
      execution,
      segmentId: segment.id,
      draft: { ...draft, text: draft.text.trim(), reason: draft.reason.trim() },
    })
  }

  const seekOwnerKey = `${meetingId}:${transcriptValue?.id ?? ''}:${transcriptValue?.contentRevision ?? ''}`
  const cancelPendingSeek = session.cancelPendingSeek
  useEffect(
    () => () => cancelPendingSeek?.(seekOwnerKey),
    [cancelPendingSeek, seekOwnerKey]
  )

  const activeSegmentId =
    canRead &&
    sourceMediaId &&
    session.playback.kind === 'remote' &&
    session.playback.sourceMediaId === sourceMediaId &&
    ['playing', 'paused', 'seeking', 'ready'].includes(session.playback.status)
      ? orderedSegments.find(
          (segment) =>
            segment.startMs <= session.playback.currentTimeMs &&
            session.playback.currentTimeMs < segment.endMs
        )?.id
      : undefined

  useEffect(() => {
    if (
      followPlayback &&
      !editingSegmentId &&
      !mappingDraft &&
      activeSegmentId
    ) {
      segmentNodes.current[activeSegmentId]?.scrollIntoView?.({
        block: 'nearest',
      })
    }
  }, [activeSegmentId, editingSegmentId, followPlayback, mappingDraft])

  const requestedEvidence =
    !evidenceReferenceIssue &&
    evidenceTranscriptId === transcriptValue?.id &&
    (evidenceContentRevision === undefined ||
      evidenceContentRevision === transcriptValue?.contentRevision) &&
    evidenceSegmentId &&
    orderedSegments.some((segment) => segment.id === evidenceSegmentId)
      ? `${evidenceTranscriptId}:${evidenceSegmentId}:${evidenceContentRevision ?? 'current'}`
      : null
  const [handledEvidence, setHandledEvidence] = useState<string | null>(null)
  if (requestedEvidence !== handledEvidence) {
    setHandledEvidence(requestedEvidence)
    if (requestedEvidence && evidenceSegmentId) {
      setSearchInput('')
      setSpeakerFilter('all')
      setQualityFilter('all')
      setSelectedSegmentId(evidenceSegmentId)
    }
  }

  useEffect(() => {
    if (!reviewGate || reviewGate.ownsEvidenceObservation) return
    if (
      !canRead ||
      !transcriptReview.isSuccess ||
      !coverage.isSuccess ||
      !speakers.isSuccess ||
      !transcriptSnapshot ||
      !transcriptValue ||
      !isFinalized ||
      !transcriptValue.finalizedAt
    ) {
      reviewGate.clearEvidence()
      return
    }
    const digestSegments: TranscriptReviewDigestSegment[] =
      transcriptValue.segments.map((segment) => ({
        ordinal: segment.ordinal,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
      }))
    reviewGate.observeEvidence(
      {
        meetingId: transcriptValue.meetingId,
        processingJobId: transcriptValue.processingJobId,
        sourceMediaId: transcriptValue.sourceMediaId,
        transcriptId: transcriptValue.id,
        versionNumber: transcriptValue.versionNumber,
        contentRevision: transcriptValue.contentRevision,
        transcriptStatus: transcriptValue.status,
        finalizedAt: transcriptValue.finalizedAt,
        etag: transcriptSnapshot.etag,
      },
      digestSegments
    )
  }, [
    canRead,
    coverage.isSuccess,
    speakers.isSuccess,
    transcriptReview.isSuccess,
    reviewGate?.clearEvidence,
    reviewGate?.observeEvidence,
    isFinalized,
    orderedSegments,
    reviewGate,
    transcriptSnapshot,
    transcriptValue,
  ])

  function playFrom(positionMs: number) {
    if (!canRead || !sourceMediaId || (!sourceMedia && !sourceLoading)) return
    void session.seekToSource(sourceMediaId, positionMs, seekOwnerKey)
  }

  function reviewPosition(positionMs: number) {
    const target = orderedSegments.find(
      (segment) => segment.startMs <= positionMs && positionMs <= segment.endMs
    )
    const nearest =
      target ??
      orderedSegments.reduce<TranscriptSegment | undefined>(
        (current, segment) => {
          if (!current) return segment
          return Math.abs(segment.startMs - positionMs) <
            Math.abs(current.startMs - positionMs)
            ? segment
            : current
        },
        undefined
      )
    if (nearest) {
      setSearchInput('')
      setSpeakerFilter('all')
      setQualityFilter('all')
      setSelectedSegmentId(nearest.id)
    }
    playFrom(positionMs)
  }

  function submitCandidateSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCandidateSearch(candidateSearchInput.trim())
  }

  function submitMapping(draft: MappingDraft, userId: string | null) {
    if (
      blocked ||
      !canMapCanonicalSpeakers ||
      editingSegmentId ||
      (userId !== null &&
        !eligibleCandidates.some((member) => member.id === userId))
    ) {
      return
    }
    const execution = acquire('mapping')
    if (!execution) return
    const intended = { ...draft, userId }
    setMappingDraft(intended)
    mappingMutation.mutate({ execution, draft: intended, userId })
  }

  function beginMapping(speaker: Speaker) {
    if (
      blocked ||
      editingSegmentId ||
      !transcriptSnapshot ||
      !canMapCanonicalSpeakers
    ) {
      return null
    }
    return {
      transcriptId: transcriptSnapshot.transcript.id,
      etag: transcriptSnapshot.etag,
      speakerId: speaker.id,
      originalUserId: speaker.userId,
    }
  }

  function mapToCandidate(speakerId: string, candidate: SpeakerCandidate) {
    if (
      mappingDraft?.speakerId !== speakerId ||
      mappingNotice?.kind === 'conflict'
    ) {
      return
    }
    submitMapping(mappingDraft, candidate.id)
  }

  function unmapSpeaker(speaker: Speaker) {
    if (mappingDraft) return
    const draft = beginMapping(speaker)
    if (draft) submitMapping(draft, null)
  }

  function reapplyMapping() {
    if (
      !mappingDraft ||
      mappingDraft.userId === undefined ||
      !transcriptSnapshot
    ) {
      return
    }
    const speaker = availableSpeakers.find(
      (item) => item.id === mappingDraft.speakerId
    )
    if (
      !speaker ||
      mappingDraft.transcriptId !== transcriptSnapshot.transcript.id
    ) {
      return
    }
    const updated = {
      ...mappingDraft,
      etag: transcriptSnapshot.etag,
      originalUserId: speaker.userId,
    }
    if (
      mappingDraft.userId !== null &&
      !eligibleCandidates.some((member) => member.id === mappingDraft.userId)
    ) {
      return
    }
    setMappingNotice(null)
    submitMapping(updated, mappingDraft.userId)
  }

  if (!canRead) {
    return (
      <div
        role='status'
        className='rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground'
      >
        {t('transcript:review_membershipRequired')}
      </div>
    )
  }

  if (transcriptReview.isPending) {
    return <RequestLoading label={t('transcript:review_loading')} />
  }

  if (transcriptReview.isError) {
    const normalized = normalizeCoreApiError(transcriptReview.error)
    if (normalized.status === 404) {
      return (
        <div className='space-y-4'>
          <RequestEmpty
            title={t('transcript:review_unavailable')}
            description={t('transcript:review_notPublished')}
          />
          <ProcessingAvailability job={pendingJob} />
        </div>
      )
    }
    return (
      <RequestError
        error={transcriptReview.error}
        retry={() => void transcriptReview.refetch()}
      />
    )
  }

  if (!transcriptValue) {
    return <RequestEmpty title={t('transcript:review_unavailable')} />
  }

  const hasCoverageWarnings = coverageRegions.some(
    (region) => region.coverageStatus !== 'COVERED'
  )
  return (
    <div className='grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]'>
      <main className='min-w-0 space-y-5'>
        <Card>
          <CardHeader className='border-b pb-5'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div>
                <CardTitle className='flex items-center gap-2'>
                  <FileAudio className='size-5' />
                  {t('transcript:review_heading')}
                </CardTitle>
                <CardDescription className='mt-2'>
                  {t('transcript:review_description')}
                </CardDescription>
              </div>
              <div className='flex flex-wrap gap-2'>
                <Badge variant={statusBadgeVariant(transcriptValue.status)}>
                  {t(`transcript:status_${transcriptValue.status}`, {
                    defaultValue: transcriptValue.status,
                  })}
                </Badge>
                <Badge variant='outline'>
                  {transcriptValue.languageCode?.toUpperCase() ??
                    t('transcript:review_unknownLanguage')}
                </Badge>
              </div>
            </div>
            <div className='flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground'>
              <span>
                {t('transcript:review_version', {
                  version: transcriptValue.versionNumber,
                })}
              </span>
              <span>
                {t('transcript:review_revision', {
                  revision: transcriptValue.contentRevision,
                })}
              </span>
              <span>
                {t('transcript:review_segmentCount', {
                  count: orderedSegments.length,
                })}
              </span>
            </div>
          </CardHeader>
          <CardContent className='space-y-4 pt-5'>
            {transcriptValue.languageCode !== 'vi' && (
              <div
                role='status'
                className='flex gap-2 rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200'
              >
                <AlertTriangle className='mt-0.5 size-4 shrink-0' />
                {t('transcript:review_languageMismatch', {
                  language:
                    transcriptValue.languageCode ??
                    t('transcript:review_unknown'),
                })}
              </div>
            )}
            {!isFinalized && (
              <div
                role='status'
                className='flex gap-2 rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200'
              >
                <CircleHelp className='mt-0.5 size-4 shrink-0' />
                {t('transcript:review_notFinalized')}
              </div>
            )}
            <Button
              type='button'
              size='sm'
              variant='outline'
              onClick={() => void refreshEvidence()}
            >
              <RefreshCw className='size-3.5' />
              {t('transcript:review_refresh')}
            </Button>
            {replacementDraft && (
              <div
                role='alert'
                className='space-y-2 rounded-lg border p-3 text-sm'
              >
                <p>{t('transcript:review_replaced')}</p>
                {Object.entries(drafts).map(([id, draft]) => (
                  <p key={id} className='whitespace-pre-wrap'>
                    {draft.text}
                  </p>
                ))}
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => {
                    clearInterrupted()
                    setDrafts({})
                    setEditingSegmentId(null)
                    setMappingDraft(null)
                    setCorrectionNotice(null)
                    setMappingNotice(null)
                  }}
                >
                  {t('transcript:review_discardPrevious')}
                </Button>
              </div>
            )}
            {hasUncertainty && (
              <div
                role='alert'
                className='space-y-2 rounded-lg border p-3 text-sm'
              >
                <p>{t('transcript:review_uncertainWrite')}</p>
                <Button
                  type='button'
                  variant='outline'
                  onClick={async () => {
                    const refreshed = await refreshEvidence()
                    if (
                      refreshed &&
                      window.confirm(
                        t('transcript:review_discardUnresolvedConfirm')
                      )
                    ) {
                      clearInterrupted()
                      setDrafts({})
                      setEditingSegmentId(null)
                      setMappingDraft(null)
                      setCorrectionNotice(null)
                      setMappingNotice(null)
                    }
                  }}
                >
                  {t('transcript:review_refreshDiscard')}
                </Button>
              </div>
            )}
            {selectedJob?.status === 'WAITING_FOR_REVIEW' && (
              <p role='status' className='text-sm text-muted-foreground'>
                {t('transcript:review_humanReviewRequired')}
              </p>
            )}
            {evidenceSegmentId &&
              (evidenceTranscriptId !== transcriptValue.id ||
                !orderedSegments.some(
                  (segment) => segment.id === evidenceSegmentId
                )) && (
                <p role='status' className='text-sm text-muted-foreground'>
                  {t('transcript:review_evidenceMissing')}
                </p>
              )}
            {evidenceSegmentId &&
              evidenceTranscriptId === transcriptValue.id &&
              evidenceContentRevision !== undefined &&
              evidenceContentRevision !== transcriptValue.contentRevision && (
                <p role='status' className='text-sm text-muted-foreground'>
                  {t('transcript:review_staleEvidence', {
                    cited: evidenceContentRevision,
                    current: transcriptValue.contentRevision,
                  })}
                </p>
              )}
            {evidenceReferenceIssue && (
              <p role='status' className='text-sm text-muted-foreground'>
                {evidenceReferenceIssue === 'incomplete'
                  ? t('transcript:review_incompleteLink')
                  : t('transcript:review_malformedLink')}
              </p>
            )}
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={followPlayback}
                onChange={(event) => setFollowPlayback(event.target.checked)}
              />
              {t('transcript:review_followPlayback')}
            </label>
            {hasCoverageWarnings && (
              <div
                role='status'
                className='flex gap-2 rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200'
              >
                <AlertTriangle className='mt-0.5 size-4 shrink-0' />
                {t('transcript:review_coverageWarning')}
              </div>
            )}
            <div className='grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_12rem]'>
              <div className='relative'>
                <Search className='absolute top-2.5 left-2.5 size-4 text-muted-foreground' />
                <Input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder={t('transcript:review_search')}
                  aria-label={t('transcript:review_search')}
                  className='pl-8'
                />
              </div>
              <SelectField
                label={t('transcript:review_speakerFilter')}
                value={speakerFilter}
                onChange={setSpeakerFilter}
                options={[
                  ['all', t('transcript:review_allSpeakers')],
                  ...speakerOptions,
                ]}
              />
              <SelectField
                label={t('transcript:review_qualityFilter')}
                value={qualityFilter}
                onChange={setQualityFilter}
                options={[
                  ['all', t('transcript:review_allQuality')],
                  ...qualityOptions.map(
                    (status) =>
                      [
                        status,
                        t(`transcript:status_${status}`, {
                          defaultValue: status,
                        }),
                      ] as const
                  ),
                ]}
              />
            </div>
            <div className='flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground'>
              <span>
                {t('transcript:review_showing', {
                  shown: filteredSegments.length,
                  total: orderedSegments.length,
                })}
              </span>
              {(searchInput ||
                speakerFilter !== 'all' ||
                qualityFilter !== 'all') && (
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  onClick={() => {
                    setSearchInput('')
                    setSpeakerFilter('all')
                    setQualityFilter('all')
                  }}
                >
                  <X className='size-3.5' />
                  {t('transcript:review_clearFilters')}
                </Button>
              )}
            </div>
            {editingSegmentId &&
              !filteredSegments.some(
                (segment) => segment.id === editingSegmentId
              ) && (
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => {
                    setSearchInput('')
                    setSpeakerFilter('all')
                    setQualityFilter('all')
                    setSelectedSegmentId(editingSegmentId)
                  }}
                >
                  {t('transcript:review_returnDraft')}
                </Button>
              )}
            {filteredSegments.length === 0 ? (
              <RequestEmpty
                title={t('transcript:review_noMatches')}
                description={t('transcript:review_noMatchesHint')}
              />
            ) : (
              <div
                className='max-h-[min(70vh,54rem)] space-y-3 overflow-auto pr-1'
                aria-label={t('transcript:review_chronological')}
                onWheel={() => setFollowPlayback(false)}
                onTouchStart={() => setFollowPlayback(false)}
              >
                {filteredSegments.map((segment) => {
                  const draft = drafts[segment.id]
                  const isEditing = editingSegmentId === segment.id
                  const isSelected = selectedSegmentId === segment.id
                  const isPlayingSegment = activeSegmentId === segment.id
                  const segmentSourceAvailable = Boolean(sourceMedia)
                  return (
                    <div
                      key={segment.id}
                      ref={(node) => {
                        segmentNodes.current[segment.id] = node
                      }}
                      className={`rounded-xl border p-3 transition-colors ${
                        isSelected || isPlayingSegment
                          ? 'border-primary bg-primary/5 shadow-sm'
                          : 'bg-card'
                      }`}
                      data-segment-id={segment.id}
                      data-playback-active={isPlayingSegment || undefined}
                    >
                      <div className='flex flex-wrap items-start justify-between gap-2'>
                        <div className='flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground'>
                          <button
                            type='button'
                            className='rounded px-1 py-0.5 font-mono tabular-nums underline-offset-2 hover:bg-muted hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                            onClick={() => {
                              setSelectedSegmentId(segment.id)
                              playFrom(segment.startMs)
                            }}
                            disabled={!segmentSourceAvailable && !sourceLoading}
                            aria-label={t('transcript:review_playFrom', {
                              time: timecode(segment.startMs),
                            })}
                            title={sourcePositionLabel(
                              segmentSourceAvailable,
                              sourceLoading,
                              t
                            )}
                          >
                            {timecode(segment.startMs)}–
                            {timecode(segment.endMs)}
                          </button>
                          <span className='text-border'>•</span>
                          <span className='font-medium text-foreground'>
                            {speakerName(
                              segment,
                              availableSpeakers,
                              t('transcript:review_unknownSpeaker')
                            )}
                          </span>
                          <Badge
                            variant={statusBadgeVariant(segment.qualityStatus)}
                          >
                            {t(`transcript:status_${segment.qualityStatus}`, {
                              defaultValue: segment.qualityStatus,
                            })}
                          </Badge>
                        </div>
                        <div className='flex flex-wrap items-center gap-1'>
                          <Button
                            type='button'
                            size='sm'
                            variant='ghost'
                            disabled={!segmentSourceAvailable && !sourceLoading}
                            onClick={() => {
                              setSelectedSegmentId(segment.id)
                              playFrom(segment.startMs)
                            }}
                          >
                            <Play className='size-3.5' />
                            {sourcePositionLabel(
                              segmentSourceAvailable,
                              sourceLoading,
                              t
                            )}
                          </Button>
                          {canEditCanonicalTranscript && (
                            <Button
                              type='button'
                              size='sm'
                              variant='outline'
                              disabled={
                                blocked ||
                                Boolean(mappingDraft) ||
                                !segment.etag ||
                                Boolean(editingSegmentId)
                              }
                              onClick={() => beginCorrection(segment)}
                            >
                              {t('transcript:review_correct')}
                            </Button>
                          )}
                        </div>
                      </div>
                      {isEditing && canEditCanonicalTranscript ? (
                        <form
                          className='mt-3 space-y-3 rounded-lg border bg-muted/10 p-3'
                          onSubmit={(event) => submitCorrection(event, segment)}
                        >
                          <div className='space-y-1.5'>
                            <Label htmlFor={`correction-text-${segment.id}`}>
                              {t('transcript:review_correctedText')}
                            </Label>
                            <Textarea
                              id={`correction-text-${segment.id}`}
                              value={draft?.text ?? ''}
                              disabled={
                                operation.pending ||
                                hasUncertainty ||
                                replacementDraft
                              }
                              maxLength={20_000}
                              required
                              onChange={(event) =>
                                updateDraft(
                                  segment.id,
                                  'text',
                                  event.target.value
                                )
                              }
                              aria-describedby={`correction-help-${segment.id}`}
                            />
                            <p
                              id={`correction-help-${segment.id}`}
                              className='text-xs text-muted-foreground'
                            >
                              {t('transcript:review_groundedWording')}
                              {` ${(draft?.text ?? '').length}/20,000`}
                            </p>
                          </div>
                          <div className='space-y-1.5'>
                            <Label htmlFor={`correction-reason-${segment.id}`}>
                              {t('transcript:review_optionalReason')}
                            </Label>
                            <Input
                              id={`correction-reason-${segment.id}`}
                              value={draft?.reason ?? ''}
                              disabled={
                                operation.pending ||
                                hasUncertainty ||
                                replacementDraft
                              }
                              maxLength={1_000}
                              onChange={(event) =>
                                updateDraft(
                                  segment.id,
                                  'reason',
                                  event.target.value
                                )
                              }
                            />
                          </div>
                          <div className='flex flex-wrap gap-2'>
                            <Button
                              type='submit'
                              size='sm'
                              disabled={
                                blocked ||
                                correctionNotice?.kind === 'conflict' ||
                                !draft?.baseEtag ||
                                !draft.text.trim()
                              }
                            >
                              {operation.pending
                                ? t('transcript:review_saving')
                                : t('transcript:review_saveCorrection')}
                            </Button>
                            <Button
                              type='button'
                              size='sm'
                              variant='outline'
                              disabled={operation.pending || hasUncertainty}
                              onClick={() => {
                                setDrafts((current) => {
                                  const next = { ...current }
                                  delete next[segment.id]
                                  return next
                                })
                                setEditingSegmentId(null)
                                setCorrectionNotice(null)
                              }}
                            >
                              {t('transcript:review_cancel')}
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <button
                          type='button'
                          className='mt-3 block w-full text-left text-sm leading-6 whitespace-pre-wrap focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                          onClick={() => setSelectedSegmentId(segment.id)}
                          aria-label={t('transcript:review_selectSegment', {
                            number: segment.ordinal + 1,
                          })}
                        >
                          {segment.text}
                        </button>
                      )}
                      {correctionNotice?.segmentId === segment.id && (
                        <CorrectionNoticeView
                          notice={correctionNotice}
                          currentSegment={segment}
                          draftExists={Boolean(drafts[segment.id])}
                          onUseCurrent={() => {
                            setDrafts((current) => {
                              const next = { ...current }
                              delete next[segment.id]
                              return next
                            })
                            setEditingSegmentId(null)
                            setCorrectionNotice(null)
                          }}
                          onKeepDraft={() => {
                            if (
                              transcriptValue.id !==
                                drafts[segment.id]?.transcriptId ||
                              transcriptReview.isFetching
                            ) {
                              return
                            }
                            setDrafts((current) => ({
                              ...current,
                              [segment.id]: {
                                ...current[segment.id],
                                baseVersion: segment.version,
                                baseEtag: segment.etag,
                                originalText: segment.text,
                              },
                            }))
                            setCorrectionNotice(null)
                            setEditingSegmentId(segment.id)
                          }}
                          onRefresh={() => void transcriptReview.refetch()}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
      <aside className='min-w-0 space-y-5'>
        {sourceMedia ? (
          session.playback.kind === 'remote' &&
          session.playback.sourceMediaId === sourceMedia.id ? (
            <PlaybackControls />
          ) : (
            <Button
              type='button'
              variant='outline'
              onClick={() => void session.selectRemoteSource(sourceMedia.id)}
            >
              {t('transcript:review_loadAudio')}
            </Button>
          )
        ) : (
          <p
            role='status'
            className='rounded-lg border border-dashed p-3 text-sm text-muted-foreground'
          >
            {sourceLoading
              ? t('transcript:review_checkingAudio')
              : t('transcript:review_audioUnavailable')}
          </p>
        )}
        <CoverageCard
          coverage={coverage}
          durationMs={durationMs}
          sourceAvailable={Boolean(sourceMedia)}
          sourceLoading={sourceLoading}
          onReviewRegion={reviewPosition}
        />
        <SpeakerMappingCard
          speakers={speakers}
          canMap={canMapCanonicalSpeakers}
          activeSpeakerId={mappingSpeakerId}
          onSelectSpeaker={(speakerId) => {
            if (
              blocked ||
              editingSegmentId ||
              (mappingDraft && mappingDraft.speakerId !== speakerId)
            ) {
              return
            }
            if (mappingSpeakerId === speakerId) {
              setMappingDraft(null)
            } else {
              const speaker = availableSpeakers.find(
                (item) => item.id === speakerId
              )
              if (!speaker) return
              setMappingDraft(beginMapping(speaker))
            }
            setMappingNotice(null)
          }}
          onUnmap={unmapSpeaker}
          searchInput={candidateSearchInput}
          onSearchInput={setCandidateSearchInput}
          onSearch={submitCandidateSearch}
          candidates={candidateResults}
          candidatesLoading={
            membershipQuery.isPending || membershipQuery.isFetching
          }
          candidatesError={membershipQuery.isError}
          onRetryCandidates={() => void membershipQuery.refetch()}
          onCandidate={(candidate) => {
            if (mappingSpeakerId) mapToCandidate(mappingSpeakerId, candidate)
          }}
          mutationPending={blocked || Boolean(editingSegmentId)}
          onReapply={reapplyMapping}
          canReapply={canReapplyMapping}
          intendedUserId={mappingDraft?.userId}
          notice={mappingNotice}
          onDismissNotice={() => {
            if (hasUncertainty) return
            setMappingNotice(null)
            setMappingDraft(null)
          }}
        />
        <ProvenanceCard
          transcript={transcriptValue}
          sourceMedia={sourceMedia}
          sourceLoading={sourceLoading}
          selectedJob={selectedJob}
        />
      </aside>
    </div>
  )
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: readonly (readonly [string, string])[]
}) {
  return (
    <label className='space-y-1.5 text-xs text-muted-foreground'>
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className='h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring'
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  )
}

function ProcessingAvailability({
  job,
}: {
  job:
    | {
        status: string
        currentStage: string | null
        errorSummary: string | null
        warningSummary: string | null
      }
    | undefined
}) {
  const { t } = useUiTranslation()
  if (!job) {
    return (
      <p className='text-sm text-muted-foreground'>
        {t('transcript:review_noProcessing')}
      </p>
    )
  }
  const presentation = presentProcessingStatus(job.status, t)
  return (
    <div className='rounded-lg border p-4 text-sm'>
      <div className='flex items-center gap-2 font-medium'>
        <span>{presentation.label}</span>
        <Badge variant='outline'>
          {t(`transcript:review_status_${job.status}`, {
            defaultValue: job.status,
          })}
        </Badge>
      </div>
      {job.currentStage && (
        <p className='mt-1 text-muted-foreground'>
          {t('transcript:review_currentStage', {
            stage: presentProcessingStage(job.currentStage, t),
          })}
        </p>
      )}
      {job.errorSummary && (
        <p className='mt-2 text-destructive'>{job.errorSummary}</p>
      )}
      {job.warningSummary && (
        <p className='mt-2 text-amber-700 dark:text-amber-300'>
          {job.warningSummary}
        </p>
      )}
    </div>
  )
}

function CoverageCard({
  coverage,
  durationMs,
  sourceAvailable,
  sourceLoading,
  onReviewRegion,
}: {
  coverage: UseQueryResult<TranscriptCoverage[], unknown>
  durationMs: number
  sourceAvailable: boolean
  sourceLoading: boolean
  onReviewRegion: (positionMs: number) => void
}) {
  const { t } = useUiTranslation()
  const orderedCoverage = useMemo(
    () => sortCoverageRegions(coverage.data ?? []),
    [coverage.data]
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-base'>
          <ShieldCheck className='size-4' />
          {t('transcript:review_coverage')}
        </CardTitle>
        <CardDescription>
          {t('transcript:review_coverageDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-3'>
        {coverage.isPending || coverage.isFetching ? (
          <RequestLoading label={t('transcript:review_loadingCoverage')} />
        ) : coverage.isError ? (
          <RequestError
            error={coverage.error}
            retry={() => void coverage.refetch()}
          />
        ) : orderedCoverage.length === 0 ? (
          <RequestEmpty
            title={t('transcript:review_noCoverage')}
            description={t('transcript:review_noCoverageHint')}
          />
        ) : (
          <>
            <div className='relative h-3 overflow-hidden rounded-full bg-muted'>
              {orderedCoverage.map((region) => {
                const left = (region.startMs / durationMs) * 100
                const width = Math.max(
                  0.5,
                  ((region.endMs - region.startMs) / durationMs) * 100
                )
                return (
                  <button
                    key={region.id}
                    type='button'
                    className={`absolute top-0 h-full border-r border-background ${
                      region.coverageStatus === 'COVERED'
                        ? 'bg-emerald-500'
                        : region.coverageStatus === 'SUSPICIOUS'
                          ? 'bg-amber-400'
                          : 'bg-destructive'
                    }`}
                    style={{
                      left: `${Math.max(0, left)}%`,
                      width: `${width}%`,
                    }}
                    onClick={() => onReviewRegion(region.startMs)}
                    disabled={!sourceAvailable && !sourceLoading}
                    aria-label={t('transcript:review_coverageRange', {
                      status: coverageStatusLabel(region.coverageStatus, t),
                      from: timecode(region.startMs),
                      to: timecode(region.endMs),
                    })}
                    title={sourcePositionLabel(
                      sourceAvailable,
                      sourceLoading,
                      t
                    )}
                  />
                )
              })}
            </div>
            <div className='space-y-2'>
              {orderedCoverage.map((region) => (
                <button
                  type='button'
                  key={`${region.id}-detail`}
                  className='flex w-full items-start justify-between gap-3 rounded-lg border p-2 text-left text-xs hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                  onClick={() => onReviewRegion(region.startMs)}
                  disabled={!sourceAvailable && !sourceLoading}
                >
                  <span className='min-w-0'>
                    <span className='block font-medium'>
                      {coverageStatusLabel(region.coverageStatus, t)}
                    </span>
                    <span className='text-muted-foreground'>
                      {timecode(region.startMs)}–{timecode(region.endMs)}
                    </span>
                  </span>
                  <span className='shrink-0 text-right'>
                    {region.recovered && (
                      <span className='block text-emerald-700 dark:text-emerald-300'>
                        {t('transcript:review_recovered')}
                      </span>
                    )}
                    <span className='text-muted-foreground'>
                      {t('transcript:review_retryCount', {
                        count: region.retryCount,
                      })}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function SpeakerMappingCard({
  speakers,
  canMap,
  activeSpeakerId,
  onSelectSpeaker,
  onUnmap,
  searchInput,
  onSearchInput,
  onSearch,
  candidates,
  candidatesLoading,
  candidatesError,
  onRetryCandidates,
  onCandidate,
  mutationPending,
  notice,
  onDismissNotice,
  onReapply,
  canReapply,
  intendedUserId,
}: {
  speakers: UseQueryResult<Speaker[], unknown>
  canMap: boolean
  activeSpeakerId: string | null
  onSelectSpeaker: (speakerId: string) => void
  onUnmap: (speaker: Speaker) => void
  searchInput: string
  onSearchInput: (value: string) => void
  onSearch: (event: React.FormEvent<HTMLFormElement>) => void
  candidates: SpeakerCandidate[]
  candidatesLoading: boolean
  candidatesError: boolean
  onRetryCandidates: () => void
  onCandidate: (candidate: SpeakerCandidate) => void
  mutationPending: boolean
  notice: MappingNotice | null
  onDismissNotice: () => void
  onReapply: () => void
  canReapply: boolean
  intendedUserId?: string | null
}) {
  const { t } = useUiTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-base'>
          <UserRound className='size-4' />
          {t('transcript:review_mapping')}
        </CardTitle>
        <CardDescription>
          {t('transcript:review_mappingDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-3'>
        {speakers.isPending || speakers.isFetching ? (
          <RequestLoading label={t('transcript:review_loadingSpeakers')} />
        ) : speakers.isError ? (
          <RequestError
            error={speakers.error}
            retry={() => void speakers.refetch()}
          />
        ) : speakers.data.length === 0 ? (
          <RequestEmpty title={t('transcript:review_noSpeakers')} />
        ) : (
          speakers.data.map((speaker) => {
            const active = activeSpeakerId === speaker.id
            return (
              <div key={speaker.id} className='rounded-lg border p-3'>
                <div className='flex items-start justify-between gap-2'>
                  <div className='min-w-0'>
                    <p className='font-medium'>{speaker.label}</p>
                    <p className='truncate text-xs text-muted-foreground'>
                      {speaker.displayName ??
                        t('transcript:review_identityUnconfirmed')}
                    </p>
                  </div>
                  {canMap && (
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      disabled={
                        mutationPending || (activeSpeakerId !== null && !active)
                      }
                      onClick={() => onSelectSpeaker(speaker.id)}
                    >
                      {active
                        ? t('transcript:review_close')
                        : t('transcript:review_map')}
                    </Button>
                  )}
                </div>
                {speaker.userId && (
                  <div className='mt-2 flex items-center justify-between gap-2 text-xs'>
                    <span className='text-emerald-700 dark:text-emerald-300'>
                      <CheckCircle2 className='mr-1 inline size-3.5' />
                      {t('transcript:review_mappedTo', {
                        name: speaker.displayName ?? speaker.userId,
                      })}
                    </span>
                    {canMap && (
                      <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        disabled={mutationPending || activeSpeakerId !== null}
                        onClick={() => onUnmap(speaker)}
                      >
                        {t('transcript:review_unmap')}
                      </Button>
                    )}
                  </div>
                )}
                {active && canMap && (
                  <div className='mt-3 space-y-2 border-t pt-3'>
                    <form className='flex gap-2' onSubmit={onSearch}>
                      <Input
                        value={searchInput}
                        onChange={(event) => onSearchInput(event.target.value)}
                        placeholder={t('transcript:review_searchEligible')}
                        aria-label={t('transcript:review_searchFor', {
                          speaker: speaker.label,
                        })}
                      />
                      <Button
                        type='submit'
                        size='sm'
                        variant='secondary'
                        disabled={mutationPending}
                      >
                        {t('transcript:review_searchButton')}
                      </Button>
                    </form>
                    {candidatesLoading && (
                      <RequestLoading
                        label={t('transcript:review_loadingParticipants')}
                      />
                    )}
                    {candidatesError && (
                      <Button
                        type='button'
                        variant='outline'
                        onClick={onRetryCandidates}
                      >
                        {t('transcript:review_retryParticipants')}
                      </Button>
                    )}
                    {candidates.map((candidate) => (
                      <Button
                        type='button'
                        key={candidate.id}
                        variant='ghost'
                        className='h-auto w-full justify-start py-2 text-left'
                        disabled={mutationPending}
                        onClick={() => onCandidate(candidate)}
                      >
                        <span className='min-w-0 truncate'>
                          {candidate.displayName}
                        </span>
                      </Button>
                    ))}
                    {!candidatesLoading &&
                      !candidatesError &&
                      candidates.length === 0 && (
                        <p className='text-sm text-muted-foreground'>
                          {t('transcript:review_noEligible')}
                        </p>
                      )}
                  </div>
                )}
              </div>
            )
          })
        )}
        {notice && (
          <div
            role='alert'
            className='rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200'
          >
            <div className='flex items-start justify-between gap-2'>
              <span className='flex gap-2'>
                <AlertTriangle className='mt-0.5 size-4 shrink-0' />
                {notice.kind === 'conflict'
                  ? t('transcript:review_mappingConflict')
                  : notice.kind === 'uncertain'
                    ? t('transcript:review_mappingUncertain', {
                        message: localizedValidationMessage(notice.message, t),
                      })
                    : localizedValidationMessage(notice.message, t)}
              </span>
              <Button
                type='button'
                variant='ghost'
                size='icon'
                disabled={notice.kind === 'uncertain' || mutationPending}
                onClick={onDismissNotice}
                aria-label={t('transcript:review_dismissMapping')}
              >
                <X />
              </Button>
            </div>
            {notice.kind === 'conflict' && intendedUserId !== undefined && (
              <div className='mt-2 space-y-2'>
                <p>
                  {t('transcript:review_intended', {
                    name: intendedUserId ?? t('transcript:review_unmapped'),
                  })}
                </p>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={mutationPending || !canReapply}
                  onClick={onReapply}
                >
                  {t('transcript:review_reapply')}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function CorrectionNoticeView({
  notice,
  currentSegment,
  draftExists,
  onUseCurrent,
  onKeepDraft,
  onRefresh,
}: {
  notice: CorrectionNotice
  currentSegment: TranscriptSegment
  draftExists: boolean
  onUseCurrent: () => void
  onKeepDraft: () => void
  onRefresh: () => void
}) {
  const { t } = useUiTranslation()
  return (
    <div
      role='alert'
      className='mt-3 rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200'
    >
      <div className='flex items-start gap-2'>
        <AlertTriangle className='mt-0.5 size-4 shrink-0' />
        <div className='min-w-0 space-y-2'>
          {notice.kind === 'conflict' ? (
            <>
              <p>
                {t('transcript:review_segmentConflict', {
                  attempted: notice.attemptedVersion,
                  current: notice.currentVersion ?? currentSegment.version,
                })}
              </p>
              <p className='whitespace-pre-wrap'>
                {t('transcript:review_currentText', {
                  text: currentSegment.text,
                })}
              </p>
              {draftExists && (
                <div className='flex flex-wrap gap-2'>
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    onClick={onKeepDraft}
                  >
                    {t('transcript:review_rebaseDraft')}
                  </Button>
                  <Button
                    type='button'
                    size='sm'
                    variant='ghost'
                    onClick={onUseCurrent}
                  >
                    {t('transcript:review_useCurrent')}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              <p>
                {notice.kind === 'uncertain'
                  ? t('transcript:review_writeUncertain', {
                      message: localizedValidationMessage(notice.message, t),
                    })
                  : localizedValidationMessage(notice.message, t)}
              </p>
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={onRefresh}
              >
                <RefreshCw className='size-3.5' />
                {t('transcript:review_refreshCanonical')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ProvenanceCard({
  transcript,
  sourceMedia,
  sourceLoading,
  selectedJob,
}: {
  transcript: Transcript
  sourceMedia:
    | {
        id: string
        originalFilename: string
        durationMs: number | null
      }
    | undefined
  sourceLoading: boolean
  selectedJob:
    | {
        id: string
        status: string
        currentStage: string | null
      }
    | undefined
}) {
  const { t } = useUiTranslation()
  const job = selectedJob
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-base'>
          <Link2 className='size-4' />
          {t('transcript:review_provenance')}
        </CardTitle>
        <CardDescription>
          {t('transcript:review_provenanceDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className='space-y-3 text-sm'>
          <ProvenanceRow
            label={t('transcript:review_sourceMedia')}
            value={
              sourceMedia
                ? sourceMedia.originalFilename
                : sourceLoading
                  ? t('transcript:review_checkingMedia')
                  : transcript.sourceMediaId
            }
          />
          <ProvenanceRow
            label={t('transcript:review_sourceMediaId')}
            value={transcript.sourceMediaId}
            mono
          />
          <ProvenanceRow
            label={t('transcript:review_processingJob')}
            value={
              job
                ? `${presentProcessingStatus(job.status, t).label}${job.currentStage ? ` · ${presentProcessingStage(job.currentStage, t)}` : ''}`
                : transcript.processingJobId
            }
          />
          <ProvenanceRow
            label={t('transcript:review_processingJobId')}
            value={transcript.processingJobId}
            mono
          />
          <ProvenanceRow
            label={t('transcript:review_finalized')}
            value={
              transcript.finalizedAt ? (
                <RegionalTimestamp value={transcript.finalizedAt} />
              ) : (
                t('transcript:review_notFinalizedByCore')
              )
            }
          />
          <ProvenanceRow
            label={t('transcript:review_contentRevision')}
            value={String(transcript.contentRevision)}
          />
        </dl>
      </CardContent>
    </Card>
  )
}

function ProvenanceRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className='grid gap-1'>
      <dt className='text-xs text-muted-foreground'>{label}</dt>
      <dd className={`break-words ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </dd>
    </div>
  )
}
