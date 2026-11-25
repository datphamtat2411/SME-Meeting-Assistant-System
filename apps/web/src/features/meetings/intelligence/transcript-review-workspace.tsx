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
import { presentProcessingStatus } from '../media/processing-status-presentation'
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

function displayDate(value: string | null): string {
  if (!value) return 'Not finalized by Core'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
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

function coverageStatusLabel(status: TranscriptCoverage['coverageStatus']) {
  switch (status) {
    case 'COVERED':
      return 'Covered'
    case 'SUSPICIOUS':
      return 'Suspicious'
    case 'UNRESOLVED_ERROR':
      return 'Unresolved error'
  }
}

function speakerName(segment: TranscriptSegment, speakers: Speaker[]): string {
  const speaker = segment.speakerClusterId
    ? speakers.find((item) => item.id === segment.speakerClusterId)
    : undefined
  return (
    speaker?.displayName ??
    segment.speakerLabel ??
    speaker?.label ??
    'Unknown speaker'
  )
}

function sourcePositionLabel(
  sourceAvailable: boolean,
  sourceLoading: boolean
): string {
  if (sourceAvailable) return 'Play source'
  if (sourceLoading) return 'Checking source…'
  return 'Source unavailable'
}

function operationErrorMessage(error: unknown, fallback: string): string {
  const normalized = normalizeCoreApiError(error)
  return normalized.status === 403
    ? 'This operation is no longer authorized.'
    : normalized.status === 404
      ? 'The canonical transcript is no longer available.'
      : normalized.message || fallback
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
          message: 'Authorization was interrupted while the write was pending.',
        }
      : storedCorrectionNotice
  const mappingNotice: MappingNotice | null =
    interrupted?.kind === 'mapping' && mappingSpeakerId
      ? {
          kind: 'uncertain',
          speakerId: mappingSpeakerId,
          message: 'Authorization was interrupted while the write was pending.',
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
      options.set(key, speakerName(segment, availableSpeakers))
    }
    return Array.from(options.entries()).sort((left, right) =>
      left[1].localeCompare(right[1])
    )
  }, [availableSpeakers, orderedSegments])
  const filteredSegments = useMemo(() => {
    const search = searchInput.trim().toLocaleLowerCase()
    return orderedSegments.filter((segment) => {
      const matchesSearch =
        !search ||
        segment.text.toLocaleLowerCase().includes(search) ||
        speakerName(segment, availableSpeakers)
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
        throw new Error('Transcript correction is no longer authorized.')
      }
      const snapshot = transcriptRef.current
      const observed = snapshot?.transcript.segments.find(
        (segment) => segment.id === segmentId
      )
      if (
        snapshot?.transcript.id !== draft.transcriptId ||
        !observed ||
        observed.version !== draft.baseVersion ||
        observed.text !== draft.originalText
      ) {
        throw new LocalTranscriptConflictError()
      }
      return correctTranscriptSegment(
        meetingId,
        { id: segmentId, version: draft.baseVersion },
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
      toast.success('Correction saved', {
        description: refreshed ? undefined : 'Reload the canonical transcript.',
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
        message: operationErrorMessage(error, 'Unable to save the correction.'),
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
        throw new Error('Speaker mapping is no longer authorized.')
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
      toast.success('Speaker identity updated')
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
          'Unable to update speaker identity.'
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
      !draft?.text.trim() ||
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
        Meeting membership must be verified before transcript data can be
        loaded.
      </div>
    )
  }

  if (transcriptReview.isPending) {
    return <RequestLoading label='Loading canonical transcript…' />
  }

  if (transcriptReview.isError) {
    const normalized = normalizeCoreApiError(transcriptReview.error)
    if (normalized.status === 404) {
      return (
        <div className='space-y-4'>
          <RequestEmpty
            title='Transcript not available yet'
            description='Core has not published a transcript for this meeting.'
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
    return <RequestEmpty title='Transcript not available yet' />
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
                  Vietnamese transcript review
                </CardTitle>
                <CardDescription className='mt-2'>
                  Review the chronological transcript published by Core. No
                  translation or inferred speaker identity is applied here.
                </CardDescription>
              </div>
              <div className='flex flex-wrap gap-2'>
                <Badge variant={statusBadgeVariant(transcriptValue.status)}>
                  {transcriptValue.status}
                </Badge>
                <Badge variant='outline'>
                  {transcriptValue.languageCode?.toUpperCase() ??
                    'Language unknown'}
                </Badge>
              </div>
            </div>
            <div className='flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground'>
              <span>Transcript v{transcriptValue.versionNumber}</span>
              <span>Revision {transcriptValue.contentRevision}</span>
              <span>{orderedSegments.length} segments</span>
            </div>
          </CardHeader>
          <CardContent className='space-y-4 pt-5'>
            {transcriptValue.languageCode !== 'vi' && (
              <div
                role='status'
                className='flex gap-2 rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200'
              >
                <AlertTriangle className='mt-0.5 size-4 shrink-0' />
                Core returned language{' '}
                <strong>{transcriptValue.languageCode ?? 'unknown'}</strong>.
                The workspace does not translate transcript text.
              </div>
            )}
            {!isFinalized && (
              <div
                role='status'
                className='flex gap-2 rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200'
              >
                <CircleHelp className='mt-0.5 size-4 shrink-0' />
                Corrections and speaker mapping stay unavailable until Core
                marks this transcript finalized and review-ready.
              </div>
            )}
            <Button
              type='button'
              size='sm'
              variant='outline'
              onClick={() => void refreshEvidence()}
            >
              <RefreshCw className='size-3.5' />
              Refresh transcript
            </Button>
            {replacementDraft && (
              <div
                role='alert'
                className='space-y-2 rounded-lg border p-3 text-sm'
              >
                <p>
                  Core replaced the transcript. Previous drafts cannot be
                  applied to this new evidence.
                </p>
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
                  Discard previous review drafts
                </Button>
              </div>
            )}
            {hasUncertainty && (
              <div
                role='alert'
                className='space-y-2 rounded-lg border p-3 text-sm'
              >
                <p>
                  A previous write has an uncertain outcome. Matching server
                  data alone cannot confirm it.
                </p>
                <Button
                  type='button'
                  variant='outline'
                  onClick={async () => {
                    const refreshed = await refreshEvidence()
                    if (
                      refreshed &&
                      window.confirm(
                        'The original outcome is not confirmed. Discard the unresolved local intent?'
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
                  Refresh and discard unresolved intent
                </Button>
              </div>
            )}
            {selectedJob?.status === 'WAITING_FOR_REVIEW' && (
              <p role='status' className='text-sm text-muted-foreground'>
                Core requires explicit human review of this transcript.
              </p>
            )}
            {evidenceSegmentId &&
              (evidenceTranscriptId !== transcriptValue.id ||
                !orderedSegments.some(
                  (segment) => segment.id === evidenceSegmentId
                )) && (
                <p role='status' className='text-sm text-muted-foreground'>
                  The requested evidence is not part of the current transcript.
                </p>
              )}
            {evidenceSegmentId &&
              evidenceTranscriptId === transcriptValue.id &&
              evidenceContentRevision !== undefined &&
              evidenceContentRevision !== transcriptValue.contentRevision && (
                <p role='status' className='text-sm text-muted-foreground'>
                  The cited evidence belongs to transcript revision{' '}
                  {evidenceContentRevision}. The current transcript is revision{' '}
                  {transcriptValue.contentRevision}. Its content is not the
                  original cited evidence.
                </p>
              )}
            {evidenceReferenceIssue && (
              <p role='status' className='text-sm text-muted-foreground'>
                {evidenceReferenceIssue === 'incomplete'
                  ? 'The evidence link is incomplete. Both a transcript and segment identifier are required.'
                  : 'The evidence link is malformed and cannot be trusted.'}
              </p>
            )}
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={followPlayback}
                onChange={(event) => setFollowPlayback(event.target.checked)}
              />
              Follow playback
            </label>
            {hasCoverageWarnings && (
              <div
                role='status'
                className='flex gap-2 rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200'
              >
                <AlertTriangle className='mt-0.5 size-4 shrink-0' />
                Some source intervals are suspicious or unresolved. Review the
                coverage evidence before relying on the transcript.
              </div>
            )}
            <div className='grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_12rem]'>
              <div className='relative'>
                <Search className='absolute top-2.5 left-2.5 size-4 text-muted-foreground' />
                <Input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder='Search transcript or speaker'
                  aria-label='Search transcript or speaker'
                  className='pl-8'
                />
              </div>
              <SelectField
                label='Filter by speaker'
                value={speakerFilter}
                onChange={setSpeakerFilter}
                options={[['all', 'All speakers'], ...speakerOptions]}
              />
              <SelectField
                label='Filter by quality'
                value={qualityFilter}
                onChange={setQualityFilter}
                options={[
                  ['all', 'All quality states'],
                  ...qualityOptions.map((status) => [status, status] as const),
                ]}
              />
            </div>
            <div className='flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground'>
              <span>
                Showing {filteredSegments.length} of {orderedSegments.length}{' '}
                segments
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
                  Clear filters
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
                  Return to unsaved correction
                </Button>
              )}
            {filteredSegments.length === 0 ? (
              <RequestEmpty
                title='No matching transcript segments'
                description='Try a different search term or filter.'
              />
            ) : (
              <div
                className='max-h-[min(70vh,54rem)] space-y-3 overflow-auto pr-1'
                aria-label='Chronological transcript'
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
                            aria-label={`Play source from ${timecode(segment.startMs)}`}
                            title={sourcePositionLabel(
                              segmentSourceAvailable,
                              sourceLoading
                            )}
                          >
                            {timecode(segment.startMs)}–
                            {timecode(segment.endMs)}
                          </button>
                          <span className='text-border'>•</span>
                          <span className='font-medium text-foreground'>
                            {speakerName(segment, availableSpeakers)}
                          </span>
                          <Badge
                            variant={statusBadgeVariant(segment.qualityStatus)}
                          >
                            {segment.qualityStatus}
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
                              sourceLoading
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
                                Boolean(editingSegmentId)
                              }
                              onClick={() => beginCorrection(segment)}
                            >
                              Correct
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
                              Corrected text
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
                              Keep the wording grounded in the source audio.
                              {` ${(draft?.text ?? '').length}/20,000`}
                            </p>
                          </div>
                          <div className='space-y-1.5'>
                            <Label htmlFor={`correction-reason-${segment.id}`}>
                              Reason (optional)
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
                                !(draft?.text.trim() ?? '')
                              }
                            >
                              {operation.pending
                                ? 'Saving…'
                                : 'Save correction'}
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
                              Cancel
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <button
                          type='button'
                          className='mt-3 block w-full text-left text-sm leading-6 whitespace-pre-wrap focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                          onClick={() => setSelectedSegmentId(segment.id)}
                          aria-label={`Select transcript segment ${segment.ordinal + 1}`}
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
              Load transcript source audio
            </Button>
          )
        ) : (
          <p
            role='status'
            className='rounded-lg border border-dashed p-3 text-sm text-muted-foreground'
          >
            {sourceLoading
              ? 'Checking the transcript source audio…'
              : 'The transcript source audio is unavailable or has been superseded. Playback evidence is disabled.'}
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
  if (!job) {
    return (
      <p className='text-sm text-muted-foreground'>
        No matching processing state is available in this workspace.
      </p>
    )
  }
  const presentation = presentProcessingStatus(job.status)
  return (
    <div className='rounded-lg border p-4 text-sm'>
      <div className='flex items-center gap-2 font-medium'>
        <span>{presentation.label}</span>
        <Badge variant='outline'>{job.status}</Badge>
      </div>
      {job.currentStage && (
        <p className='mt-1 text-muted-foreground'>
          Current stage: {job.currentStage}
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
  const orderedCoverage = useMemo(
    () => sortCoverageRegions(coverage.data ?? []),
    [coverage.data]
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-base'>
          <ShieldCheck className='size-4' />
          Source coverage
        </CardTitle>
        <CardDescription>
          Coverage status is separate from recovery status.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-3'>
        {coverage.isPending || coverage.isFetching ? (
          <RequestLoading label='Loading coverage…' />
        ) : coverage.isError ? (
          <RequestError
            error={coverage.error}
            retry={() => void coverage.refetch()}
          />
        ) : orderedCoverage.length === 0 ? (
          <RequestEmpty
            title='No coverage evidence'
            description='Core did not return coverage intervals for this transcript.'
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
                    aria-label={`${coverageStatusLabel(region.coverageStatus)} from ${timecode(region.startMs)} to ${timecode(region.endMs)}`}
                    title={sourcePositionLabel(sourceAvailable, sourceLoading)}
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
                      {coverageStatusLabel(region.coverageStatus)}
                    </span>
                    <span className='text-muted-foreground'>
                      {timecode(region.startMs)}–{timecode(region.endMs)}
                    </span>
                  </span>
                  <span className='shrink-0 text-right'>
                    {region.recovered && (
                      <span className='block text-emerald-700 dark:text-emerald-300'>
                        Recovered
                      </span>
                    )}
                    <span className='text-muted-foreground'>
                      {region.retryCount} retries
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-base'>
          <UserRound className='size-4' />
          Speaker mapping
        </CardTitle>
        <CardDescription>
          AI labels remain distinct from eligible meeting participants.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-3'>
        {speakers.isPending || speakers.isFetching ? (
          <RequestLoading label='Loading speakers…' />
        ) : speakers.isError ? (
          <RequestError
            error={speakers.error}
            retry={() => void speakers.refetch()}
          />
        ) : speakers.data.length === 0 ? (
          <RequestEmpty title='No speakers detected' />
        ) : (
          speakers.data.map((speaker) => {
            const active = activeSpeakerId === speaker.id
            return (
              <div key={speaker.id} className='rounded-lg border p-3'>
                <div className='flex items-start justify-between gap-2'>
                  <div className='min-w-0'>
                    <p className='font-medium'>{speaker.label}</p>
                    <p className='truncate text-xs text-muted-foreground'>
                      {speaker.displayName ?? 'Identity not confirmed'}
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
                      {active ? 'Close' : 'Map'}
                    </Button>
                  )}
                </div>
                {speaker.userId && (
                  <div className='mt-2 flex items-center justify-between gap-2 text-xs'>
                    <span className='text-emerald-700 dark:text-emerald-300'>
                      <CheckCircle2 className='mr-1 inline size-3.5' />
                      Mapped to {speaker.displayName ?? speaker.userId}
                    </span>
                    {canMap && (
                      <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        disabled={mutationPending || activeSpeakerId !== null}
                        onClick={() => onUnmap(speaker)}
                      >
                        Unmap
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
                        placeholder='Search eligible participants'
                        aria-label={`Search eligible participants for ${speaker.label}`}
                      />
                      <Button
                        type='submit'
                        size='sm'
                        variant='secondary'
                        disabled={mutationPending}
                      >
                        Search
                      </Button>
                    </form>
                    {candidatesLoading && (
                      <RequestLoading label='Loading meeting participants…' />
                    )}
                    {candidatesError && (
                      <Button
                        type='button'
                        variant='outline'
                        onClick={onRetryCandidates}
                      >
                        Retry meeting participants
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
                          No eligible participants match that search.
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
                  ? 'The speaker list changed. The current canonical mapping was reloaded; review it before trying again.'
                  : notice.kind === 'uncertain'
                    ? `The mapping outcome is uncertain. ${notice.message} Do not resubmit until the canonical list is refreshed.`
                    : notice.message}
              </span>
              <Button
                type='button'
                variant='ghost'
                size='icon'
                disabled={notice.kind === 'uncertain' || mutationPending}
                onClick={onDismissNotice}
                aria-label='Dismiss speaker mapping notice'
              >
                <X />
              </Button>
            </div>
            {notice.kind === 'conflict' && intendedUserId !== undefined && (
              <div className='mt-2 space-y-2'>
                <p>Intended mapping: {intendedUserId ?? 'Unmapped'}</p>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={mutationPending || !canReapply}
                  onClick={onReapply}
                >
                  Reapply intended mapping
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
                This segment changed from version {notice.attemptedVersion} to
                the current canonical version{' '}
                {notice.currentVersion ?? currentSegment.version}. Your draft
                remains local and was not applied.
              </p>
              <p className='whitespace-pre-wrap'>
                Current text: {currentSegment.text}
              </p>
              {draftExists && (
                <div className='flex flex-wrap gap-2'>
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    onClick={onKeepDraft}
                  >
                    Rebase draft after review
                  </Button>
                  <Button
                    type='button'
                    size='sm'
                    variant='ghost'
                    onClick={onUseCurrent}
                  >
                    Use current transcript
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              <p>
                {notice.kind === 'uncertain'
                  ? `The write may have reached Core, but the browser did not receive a confirmed result. ${notice.message}`
                  : notice.message}
              </p>
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={onRefresh}
              >
                <RefreshCw className='size-3.5' />
                Refresh canonical transcript
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
  const job = selectedJob
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-base'>
          <Link2 className='size-4' />
          Provenance
        </CardTitle>
        <CardDescription>
          Read-only lineage from the current Core response.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className='space-y-3 text-sm'>
          <ProvenanceRow
            label='Source media'
            value={
              sourceMedia
                ? sourceMedia.originalFilename
                : sourceLoading
                  ? 'Checking Core media…'
                  : transcript.sourceMediaId
            }
          />
          <ProvenanceRow
            label='Source media ID'
            value={transcript.sourceMediaId}
            mono
          />
          <ProvenanceRow
            label='Processing job'
            value={
              job
                ? `${job.status}${job.currentStage ? ` · ${job.currentStage}` : ''}`
                : transcript.processingJobId
            }
          />
          <ProvenanceRow
            label='Processing job ID'
            value={transcript.processingJobId}
            mono
          />
          <ProvenanceRow
            label='Finalized'
            value={displayDate(transcript.finalizedAt)}
          />
          <ProvenanceRow
            label='Content revision'
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
  value: string
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
