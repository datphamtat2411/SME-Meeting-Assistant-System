import { useEffect, useMemo, useRef, useState } from 'react'
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
  isValidMeetingParticipantCandidateQuery,
  meetingParticipantCandidateQueryOptions,
  type MeetingParticipantCandidate,
  type MeetingParticipantCandidateResponse,
} from '@/features/meetings/data/meeting-candidates-api'
import {
  MeetingSessionBoundary,
  useMeetingSession,
} from '../media/meeting-session-context'
import { PlaybackControls } from '../media/playback-controls'
import { presentProcessingStatus } from '../media/processing-status-presentation'
import { useOptionalMeetingAuthorization } from '../meeting-authorization-context'
import { invalidateMeetingArtifacts } from './query-invalidation'
import {
  correctTranscriptSegment,
  mapSpeaker,
  speakerClustersQuery,
  timecode,
  transcriptCoverageQuery,
  transcriptQuery,
  transcriptReviewQuery,
  type Speaker,
  type Transcript,
  type TranscriptCoverage,
  type TranscriptReview,
} from './transcript-api'

type TranscriptSegment = Transcript['segments'][number]

type SegmentDraft = {
  text: string
  reason: string
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
    normalized.recoveryOutcome === 'uncertain' || normalized.kind === 'network'
  )
}

function sortSegments(
  segments: readonly TranscriptSegment[]
): TranscriptSegment[] {
  return [...segments].sort(
    (left, right) =>
      left.ordinal - right.ordinal ||
      left.startMs - right.startMs ||
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
}: {
  meetingId: string
  canReadMeetingContent: boolean
  canCorrectTranscript: boolean
  canMapSpeakers: boolean
  canReadMedia: boolean
}) {
  return (
    <MeetingSessionBoundary
      meetingId={meetingId}
      fallbackCapabilities={{ canReadMedia }}
    >
      <TranscriptReviewWorkspaceContent
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
}: {
  meetingId: string
  canReadMeetingContent: boolean
  canCorrectTranscript: boolean
  canMapSpeakers: boolean
}) {
  const queryClient = useQueryClient()
  const session = useMeetingSession()
  const authorization = useOptionalMeetingAuthorization()
  const protectedScopeReady =
    !authorization ||
    (authorization.scopeReady &&
      authorization.canReadProtectedData &&
      !authorization.isConfirmedAccessLoss)
  const canRead = canReadMeetingContent && protectedScopeReady
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

  const transcriptBody = useQuery({
    ...transcriptQuery(meetingId),
    enabled: canRead,
  })
  const transcriptReview = useQuery({
    ...transcriptReviewQuery(meetingId),
    enabled: canRead && transcriptBody.isSuccess,
  })
  const transcriptValue =
    transcriptReview.data?.transcript ?? transcriptBody.data
  const transcriptSnapshot = useMemo(
    () =>
      transcriptReview.data ??
      (transcriptBody.data
        ? { transcript: transcriptBody.data, etag: '' }
        : null),
    [transcriptBody.data, transcriptReview.data]
  )
  const isFinalized = Boolean(
    transcriptValue &&
    ['READY', 'READY_WITH_WARNINGS'].includes(transcriptValue.status) &&
    transcriptValue.finalizedAt
  )
  const canEditCanonicalTranscript = canCorrect && isFinalized
  const canMapCanonicalSpeakers =
    canMap && isFinalized && Boolean(transcriptReview.data?.etag)

  const coverage = useQuery({
    ...transcriptCoverageQuery(meetingId),
    enabled: canRead && transcriptBody.isSuccess,
  })
  const speakers = useQuery({
    ...speakerClustersQuery(meetingId),
    enabled: canRead && transcriptBody.isSuccess,
  })

  const [searchInput, setSearchInput] = useState('')
  const [speakerFilter, setSpeakerFilter] = useState('all')
  const [qualityFilter, setQualityFilter] = useState('all')
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null
  )
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, SegmentDraft>>({})
  const [correctionNotice, setCorrectionNotice] =
    useState<CorrectionNotice | null>(null)
  const [mappingSpeakerId, setMappingSpeakerId] = useState<string | null>(null)
  const [candidateSearchInput, setCandidateSearchInput] = useState('')
  const [candidateSearch, setCandidateSearch] = useState('')
  const [mappingNotice, setMappingNotice] = useState<MappingNotice | null>(null)
  const segmentNodes = useRef<Record<string, HTMLDivElement | null>>({})
  const transcriptRef = useRef<TranscriptReview | null>(null)
  const canCorrectRef = useRef(canEditCanonicalTranscript)
  const canMapRef = useRef(canMapCanonicalSpeakers)
  const scopeRef = useRef({
    meetingId,
    identityId: authorization?.identity?.userId ?? null,
  })

  useEffect(() => {
    const identityId = authorization?.identity?.userId ?? null
    const previous = scopeRef.current
    if (
      previous.meetingId === meetingId &&
      previous.identityId === identityId
    ) {
      return
    }
    scopeRef.current = { meetingId, identityId }
    setSearchInput('')
    setSpeakerFilter('all')
    setQualityFilter('all')
    setSelectedSegmentId(null)
    setEditingSegmentId(null)
    setDrafts({})
    setCorrectionNotice(null)
    setMappingSpeakerId(null)
    setCandidateSearchInput('')
    setCandidateSearch('')
    setMappingNotice(null)
    transcriptRef.current = null
  }, [authorization?.identity?.userId, meetingId])
  useEffect(() => {
    transcriptRef.current = transcriptSnapshot
  }, [transcriptSnapshot])
  useEffect(() => {
    canCorrectRef.current = canEditCanonicalTranscript
  }, [canEditCanonicalTranscript])
  useEffect(() => {
    canMapRef.current = canMapCanonicalSpeakers
  }, [canMapCanonicalSpeakers])
  useEffect(() => {
    if (!selectedSegmentId) return
    const node = segmentNodes.current[selectedSegmentId]
    node?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedSegmentId])

  const orderedSegments = useMemo(
    () => sortSegments(transcriptValue?.segments ?? []),
    [transcriptValue?.segments]
  )
  const availableSpeakers = useMemo(() => speakers.data ?? [], [speakers.data])
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
  const coverageRegions = coverage.data ?? []
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
  const pendingJob = session.processing.jobs.data?.find(
    (job) =>
      job.meetingId === meetingId &&
      (sourceMediaId === null || job.sourceMediaId === sourceMediaId)
  )
  const correctionMutation = useMutation({
    mutationFn: async (payload: {
      segmentId: string
      version: number
      text: string
      reason: string
    }) => {
      if (!canCorrectRef.current) {
        throw new Error('Transcript correction is no longer authorized.')
      }
      const observed = transcriptRef.current?.transcript.segments.find(
        (segment) => segment.id === payload.segmentId
      )
      if (!observed || observed.version !== payload.version) {
        throw new LocalTranscriptConflictError()
      }
      return correctTranscriptSegment(
        meetingId,
        observed,
        payload.text,
        payload.reason
      )
    },
    onSuccess: async (_, payload) => {
      setDrafts((current) => {
        const next = { ...current }
        delete next[payload.segmentId]
        return next
      })
      setEditingSegmentId(null)
      setCorrectionNotice(null)
      toast.success('Correction saved')
      invalidateMeetingArtifacts(queryClient, meetingId, { transcript: true })
      await queryClient.refetchQueries({
        queryKey: ['transcript', meetingId, 'review'],
        type: 'active',
      })
    },
    onError: async (error, payload) => {
      if (isConflict(error)) {
        const refreshed = await transcriptReview.refetch()
        const currentVersion =
          refreshed.data?.transcript.segments.find(
            (segment) => segment.id === payload.segmentId
          )?.version ?? null
        setCorrectionNotice({
          kind: 'conflict',
          segmentId: payload.segmentId,
          attemptedVersion: payload.version,
          currentVersion,
        })
        toast.error('Transcript changed before the correction was saved', {
          description:
            'Your draft is preserved. Review the current canonical text before retrying.',
        })
        return
      }
      const message = operationErrorMessage(
        error,
        'Unable to save the transcript correction.'
      )
      if (isUncertainMutation(error)) {
        invalidateMeetingArtifacts(queryClient, meetingId, { transcript: true })
      }
      setCorrectionNotice({
        kind: isUncertainMutation(error) ? 'uncertain' : 'error',
        segmentId: payload.segmentId,
        message,
      })
      toast.error(
        isUncertainMutation(error)
          ? 'Correction outcome is uncertain'
          : 'Unable to correct transcript',
        { description: message }
      )
    },
  })
  const candidateOptions = meetingParticipantCandidateQueryOptions({
    q: candidateSearch,
    page: 1,
    pageSize: 20,
  })
  const candidates = useQuery({
    ...candidateOptions,
    enabled:
      canMapCanonicalSpeakers &&
      Boolean(mappingSpeakerId) &&
      candidateOptions.enabled,
  })
  const mappingMutation = useMutation({
    mutationFn: async (payload: {
      speakerId: string
      userId: string | null
      ifMatch: string
    }) => {
      if (!canMapRef.current) {
        throw new Error('Speaker mapping is no longer authorized.')
      }
      return mapSpeaker(
        meetingId,
        payload.speakerId,
        payload.userId,
        payload.ifMatch
      )
    },
    onSuccess: async () => {
      setMappingSpeakerId(null)
      setCandidateSearch('')
      setCandidateSearchInput('')
      setMappingNotice(null)
      toast.success('Speaker identity updated')
      invalidateMeetingArtifacts(queryClient, meetingId, { transcript: true })
      await Promise.all([
        queryClient.refetchQueries({
          queryKey: ['transcript', meetingId, 'review'],
          type: 'active',
        }),
        queryClient.refetchQueries({
          queryKey: ['transcript', meetingId, 'speakers'],
          type: 'active',
        }),
      ])
    },
    onError: async (error, payload) => {
      if (isConflict(error)) {
        await Promise.all([transcriptReview.refetch(), speakers.refetch()])
        setMappingNotice({ kind: 'conflict', speakerId: payload.speakerId })
        toast.error('Speaker mapping is out of date', {
          description:
            'The transcript changed. Review the current speaker list before retrying.',
        })
        return
      }
      const message = operationErrorMessage(
        error,
        'Unable to update speaker identity.'
      )
      if (isUncertainMutation(error)) {
        invalidateMeetingArtifacts(queryClient, meetingId, { transcript: true })
      }
      setMappingNotice({
        kind: isUncertainMutation(error) ? 'uncertain' : 'error',
        speakerId: payload.speakerId,
        message,
      })
      toast.error(
        isUncertainMutation(error)
          ? 'Speaker mapping outcome is uncertain'
          : 'Unable to map speaker',
        { description: message }
      )
    },
  })

  function beginCorrection(segment: TranscriptSegment) {
    setSelectedSegmentId(segment.id)
    setEditingSegmentId(segment.id)
    setDrafts((current) => ({
      ...current,
      [segment.id]: current[segment.id] ?? {
        text: segment.text,
        reason: '',
      },
    }))
    setCorrectionNotice(null)
  }

  function updateDraft(
    segmentId: string,
    field: keyof SegmentDraft,
    value: string
  ) {
    setDrafts((current) => ({
      ...current,
      [segmentId]: {
        text: current[segmentId]?.text ?? '',
        reason: current[segmentId]?.reason ?? '',
        [field]: value,
      },
    }))
  }

  function submitCorrection(
    event: React.FormEvent<HTMLFormElement>,
    segment: TranscriptSegment
  ) {
    event.preventDefault()
    const draft = drafts[segment.id]
    const text = draft?.text.trim() ?? ''
    if (!text) return
    correctionMutation.mutate({
      segmentId: segment.id,
      version: segment.version,
      text,
      reason: draft?.reason.trim() ?? '',
    })
  }

  function playFrom(positionMs: number) {
    if (!sourceMediaId) return
    void session.seekToSource(sourceMediaId, positionMs)
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

  function mapToCandidate(
    speakerId: string,
    candidate: MeetingParticipantCandidate
  ) {
    const ifMatch = transcriptRef.current?.etag
    if (!ifMatch) {
      setMappingNotice({
        kind: 'error',
        speakerId,
        message: 'Reload the canonical transcript before mapping a speaker.',
      })
      return
    }
    mappingMutation.mutate({ speakerId, userId: candidate.id, ifMatch })
  }

  function unmapSpeaker(speaker: Speaker) {
    const ifMatch = transcriptRef.current?.etag
    if (!ifMatch) {
      setMappingNotice({
        kind: 'error',
        speakerId: speaker.id,
        message: 'Reload the canonical transcript before removing a mapping.',
      })
      return
    }
    mappingMutation.mutate({
      speakerId: speaker.id,
      userId: null,
      ifMatch,
    })
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

  if (transcriptBody.isPending) {
    return <RequestLoading label='Loading canonical transcript…' />
  }

  if (transcriptBody.isError) {
    const normalized = normalizeCoreApiError(transcriptBody.error)
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
        error={transcriptBody.error}
        retry={() => void transcriptBody.refetch()}
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
            {transcriptReview.isError && (
              <div
                role='status'
                className='flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200'
              >
                <span className='flex gap-2'>
                  <CircleHelp className='mt-0.5 size-4 shrink-0' />
                  Core did not provide the transcript concurrency snapshot.
                  Speaker mapping is temporarily unavailable.
                </span>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={() => void transcriptReview.refetch()}
                >
                  <RefreshCw className='size-3.5' />
                  Reload snapshot
                </Button>
              </div>
            )}
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
            {filteredSegments.length === 0 ? (
              <RequestEmpty
                title='No matching transcript segments'
                description='Try a different search term or filter.'
              />
            ) : (
              <div
                className='max-h-[min(70vh,54rem)] space-y-3 overflow-auto pr-1'
                aria-label='Chronological transcript'
              >
                {filteredSegments.map((segment) => {
                  const draft = drafts[segment.id]
                  const isEditing = editingSegmentId === segment.id
                  const isSelected = selectedSegmentId === segment.id
                  const segmentSourceAvailable = Boolean(sourceMedia)
                  return (
                    <div
                      key={segment.id}
                      ref={(node) => {
                        segmentNodes.current[segment.id] = node
                      }}
                      className={`rounded-xl border p-3 transition-colors ${
                        isSelected
                          ? 'border-primary bg-primary/5 shadow-sm'
                          : 'bg-card'
                      }`}
                      data-segment-id={segment.id}
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
                                correctionMutation.isPending ||
                                !(draft?.text.trim() ?? '')
                              }
                            >
                              {correctionMutation.isPending
                                ? 'Saving…'
                                : 'Save correction'}
                            </Button>
                            <Button
                              type='button'
                              size='sm'
                              variant='outline'
                              onClick={() => {
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
        <PlaybackControls />
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
            setMappingSpeakerId((current) =>
              current === speakerId ? null : speakerId
            )
            setMappingNotice(null)
          }}
          onUnmap={unmapSpeaker}
          searchInput={candidateSearchInput}
          onSearchInput={setCandidateSearchInput}
          onSearch={submitCandidateSearch}
          candidates={candidates}
          onCandidate={(candidate) => {
            if (mappingSpeakerId) mapToCandidate(mappingSpeakerId, candidate)
          }}
          mutationPending={mappingMutation.isPending}
          notice={mappingNotice}
          onDismissNotice={() => setMappingNotice(null)}
        />
        <ProvenanceCard
          transcript={transcriptValue}
          sourceMedia={sourceMedia}
          sourceLoading={sourceLoading}
          selectedJob={selectedJob}
          pendingJob={pendingJob}
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
        {coverage.isPending ? (
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
  onCandidate,
  mutationPending,
  notice,
  onDismissNotice,
}: {
  speakers: UseQueryResult<Speaker[], unknown>
  canMap: boolean
  activeSpeakerId: string | null
  onSelectSpeaker: (speakerId: string) => void
  onUnmap: (speaker: Speaker) => void
  searchInput: string
  onSearchInput: (value: string) => void
  onSearch: (event: React.FormEvent<HTMLFormElement>) => void
  candidates: UseQueryResult<MeetingParticipantCandidateResponse, unknown>
  onCandidate: (candidate: MeetingParticipantCandidate) => void
  mutationPending: boolean
  notice: MappingNotice | null
  onDismissNotice: () => void
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
        {speakers.isPending ? (
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
                        disabled={mutationPending}
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
                        disabled={
                          !isValidMeetingParticipantCandidateQuery(searchInput)
                        }
                      >
                        Search
                      </Button>
                    </form>
                    {searchInput &&
                      !isValidMeetingParticipantCandidateQuery(searchInput) && (
                        <p className='text-xs text-muted-foreground'>
                          Enter at least two non-whitespace characters.
                        </p>
                      )}
                    {candidates.isPending && (
                      <RequestLoading label='Searching eligible participants…' />
                    )}
                    {candidates.isError && (
                      <RequestError
                        error={candidates.error}
                        retry={() => void candidates.refetch()}
                      />
                    )}
                    {candidates.data?.candidates.map((candidate) => (
                      <Button
                        type='button'
                        key={candidate.id}
                        variant='ghost'
                        className='h-auto w-full justify-start py-2 text-left'
                        disabled={mutationPending}
                        onClick={() => onCandidate(candidate)}
                      >
                        <span className='min-w-0 truncate'>
                          {candidate.displayName} · {candidate.email}
                        </span>
                      </Button>
                    ))}
                    {candidates.isSuccess &&
                      candidates.data.candidates.length === 0 && (
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
                onClick={onDismissNotice}
                aria-label='Dismiss speaker mapping notice'
              >
                <X />
              </Button>
            </div>
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
              {draftExists && (
                <div className='flex flex-wrap gap-2'>
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    onClick={onKeepDraft}
                  >
                    Keep draft and retry
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
  pendingJob,
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
  pendingJob:
    | {
        id: string
        status: string
        currentStage: string | null
      }
    | undefined
}) {
  const job = selectedJob ?? pendingJob
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
