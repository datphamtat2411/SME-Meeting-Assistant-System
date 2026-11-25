import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Columns2, FileText, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { useOptionalMeetingSession } from '../media/meeting-session-context'
import { useOptionalMeetingAuthorization } from '../meeting-authorization-context'
import {
  intelligenceReadAllowed,
  useIntelligenceDraftProtection,
  useIntelligenceOperationScope,
} from './intelligence-operation-scope'
import { invalidateMeetingArtifacts } from './query-invalidation'
import {
  activateSummary,
  editSummary,
  summaryQuery,
  summaryVersionPageLabel,
  summaryVersionsQuery,
  type SummarySnapshot,
  type SummaryVersion,
} from './summary-api'
import { ConflictColumn, CurrentSummary, formatDate, PreviewColumn, VersionRow } from './summary-presentation'

const historyPageSize = 20
const regenerationIdentity = 'summary-regeneration'


type SummaryPanelProps = {
  meetingId: string
  canEdit: boolean
  canRegenerate: boolean
}

export function SummaryPanel(props: SummaryPanelProps) {
  const authorization = useOptionalMeetingAuthorization()
  if (!intelligenceReadAllowed(authorization)) {
    return <RequestEmpty title='Summary unavailable' description='Meeting content access must be verified.' />
  }
  return (
    <SummaryPanelContent
      key={`${props.meetingId}:${authorization?.identity?.session?.id ?? authorization?.identity?.userId ?? 'standalone'}`}
      {...props}
    />
  )
}

function SummaryPanelContent({
  meetingId,
  canEdit,
  canRegenerate,
}: SummaryPanelProps) {
  const queryClient = useQueryClient()
  const session = useOptionalMeetingSession()
  const authorization = useOptionalMeetingAuthorization()
  const canEditRef = useRef(canEdit)
  const canRegenerateRef = useRef(canRegenerate)
  const authorizationRef = useRef(authorization)
  const captureScope = useIntelligenceOperationScope(meetingId, authorization, canEdit)
  const captureRegenerationScope = useIntelligenceOperationScope(meetingId, authorization, canRegenerate)
  const [historyPage, setHistoryPage] = useState(0)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    null
  )
  const [comparisonOpen, setComparisonOpen] = useState(false)
  const [editorSnapshot, setEditorSnapshot] = useState<SummarySnapshot | null>(
    null
  )
  const [draft, setDraft] = useState('')
  const [editConflict, setEditConflict] = useState<{
    reviewed: SummarySnapshot
    latest: SummarySnapshot | null
  } | null>(null)
  const [activationConflict, setActivationConflict] = useState(false)
  const [activationReview, setActivationReview] = useState<{
    candidate: SummaryVersion
    baseline: SummarySnapshot
  } | null>(null)
  const [activationLatest, setActivationLatest] =
    useState<SummarySnapshot | null>(null)

  useLayoutEffect(() => {
    canEditRef.current = canEdit
    canRegenerateRef.current = canRegenerate
    authorizationRef.current = authorization
  }, [authorization, canEdit, canRegenerate])

  const summary = useQuery(summaryQuery(meetingId))
  const versions = useQuery(
    summaryVersionsQuery(meetingId, historyPage, historyPageSize)
  )
  const selectedVersion = useMemo<SummaryVersion | undefined>(
    () =>
      versions.data?.items.find(
        (version) => version.id === selectedVersionId
      ) ??
      versions.data?.items.find((version) => !version.isCurrent) ??
      versions.data?.items[0],
    [selectedVersionId, versions.data?.items]
  )
  const regenerationInProgress = Boolean(
    session?.processing.isOperationPending(regenerationIdentity)
  )
  const regenerationUncertain = Boolean(
    session?.processing.isOperationUncertain(regenerationIdentity)
  )

  function refreshArtifacts() {
    invalidateMeetingArtifacts(queryClient, meetingId)
  }

  const save = useMutation({
    onMutate: captureScope,
    mutationFn: () => {
      const currentAuthorization = authorizationRef.current
      if (
        !canEditRef.current ||
        (currentAuthorization &&
          (!currentAuthorization.scopeReady ||
            !currentAuthorization.canPerformProtectedOperation ||
            !currentAuthorization.capabilities.canMutateIntelligence ||
            currentAuthorization.isConfirmedAccessLoss))
      ) {
        throw new Error('Summary editing is no longer authorized.')
      }
      if (!editorSnapshot || editConflict) throw new Error('Review the current summary before saving.')
      const content = draft.trim()
      if (!content || content.length > 20_000) {
        throw new Error(
          'Summary content must be between 1 and 20,000 characters.'
        )
      }
      return editSummary(meetingId, content, editorSnapshot)
    },
    onSuccess: (result, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      queryClient.setQueryData(summaryQuery(meetingId).queryKey, result)
      setEditorSnapshot(null)
      setEditConflict(null)
      refreshArtifacts()
      if (
        result.summary.versionNumber ===
          editorSnapshot?.summary.versionNumber &&
        result.summary.content === editorSnapshot.summary.content
      ) {
        toast.success('Summary is already up to date')
      } else {
        toast.success('Summary version saved')
      }
    },
    onError: (error, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      const normalized = normalizeCoreApiError(error)
      if (normalized.status === 412 && editorSnapshot) {
        const reviewed = editorSnapshot
        setEditConflict({ reviewed, latest: null })
        void summary.refetch().then((latest) => {
          if (ownsScope() && latest.isSuccess && latest.data) {
            setEditConflict({ reviewed, latest: latest.data })
          }
        })
        return
      }
      toast.error('Cannot save summary', {
        description:
          normalized.status === 403
            ? 'Your summary editing permission is no longer available.'
            : normalized.message,
      })
    },
  })

  const activate = useMutation({
    onMutate: captureScope,
    mutationFn: () => {
      const currentAuthorization = authorizationRef.current
      if (
        !canEditRef.current ||
        (currentAuthorization &&
          (!currentAuthorization.scopeReady ||
            !currentAuthorization.canPerformProtectedOperation ||
            !currentAuthorization.capabilities.canMutateIntelligence ||
            currentAuthorization.isConfirmedAccessLoss))
      ) {
        throw new Error('Summary activation is no longer authorized.')
      }
      if (!activationReview || activationConflict || editorSnapshot) {
        throw new Error(
          'Review the current summary before activating a version.'
        )
      }
      const candidate = versions.data?.items.find(
        (version) => version.id === activationReview.candidate.id
      )
      if (!candidate || candidate.isCurrent || candidate.isStale) {
        throw new Error('Only a fresh historical version can be activated.')
      }
      return activateSummary(meetingId, candidate.id, activationReview.baseline)
    },
    onSuccess: (result, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      queryClient.setQueryData(summaryQuery(meetingId).queryKey, result)
      setActivationConflict(false)
      setActivationReview(null)
      setActivationLatest(null)
      refreshArtifacts()
      toast.success('Selected summary version is now current')
    },
    onError: (error, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      const normalized = normalizeCoreApiError(error)
      if (normalized.status === 412 || normalized.status === 409) {
        setActivationConflict(true)
        setActivationLatest(null)
        void versions.refetch()
        void summary.refetch().then((latest) => {
          if (ownsScope() && latest.isSuccess && latest.data) setActivationLatest(latest.data)
        })
        return
      }
      toast.error('Could not activate version', {
        description: normalized.message,
      })
    },
  })

  const regenerate = useMutation({
    onMutate: captureRegenerationScope,
    mutationFn: async () => {
      const currentAuthorization = authorizationRef.current
      if (
        !canRegenerateRef.current ||
        (currentAuthorization &&
          (!currentAuthorization.scopeReady ||
            !currentAuthorization.canPerformProtectedOperation ||
            !currentAuthorization.capabilities.canAdmitProcessing ||
            currentAuthorization.isConfirmedAccessLoss))
      ) {
        throw new Error('Summary regeneration is no longer authorized.')
      }
      if (session) {
        return regenerationUncertain
          ? session.processing.recoverOperation(regenerationIdentity)
          : session.processing.regenerateSummary()
      }
      throw new Error('Summary regeneration requires the meeting processing owner.')
    },
    onSuccess: (result, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      if (result.status === 'blocked') {
        toast.error('Regeneration is not available', {
          description:
            'Refresh the meeting authorization and processing state before trying again.',
        })
        return
      }
      refreshArtifacts()
      toast.success('Summary regeneration admitted', {
        description:
          'Core accepted the regeneration request. Follow its processing status and review any resulting version.',
      })
    },
    onError: (error, _variables, ownsScope) => {
      if (!ownsScope?.()) return
      const normalized = normalizeCoreApiError(error)
      toast.error(normalized.recoveryOutcome === 'uncertain' ? 'Regeneration admission is uncertain' : 'Could not request regeneration', {
        description:
          normalized.status === 503
            ? 'Summary generation is currently unavailable because the worker is not ready.'
            : normalized.message,
      })
    },
  })

  useIntelligenceDraftProtection(
    'summary',
    save.isPending || activate.isPending ||
      Boolean(editorSnapshot && draft !== editorSnapshot.summary.content)
  )

  const currentSummary = summary.data?.summary
  const regenerationJob = session?.processing.summaryRegenerationJob
  const activationCandidate = versions.data?.items.find(
    (version) => version.id === activationReview?.candidate.id
  )
  const historyError = versions.isError
  const protectedScopeReady =
    !authorization ||
    (authorization.scopeReady &&
      authorization.canReadProtectedData &&
      authorization.capabilities.canReadIntelligence &&
      !authorization.isConfirmedAccessLoss)
  return (
    <Card className='overflow-hidden'>
      <CardHeader className='border-b bg-muted/20'>
        <div className='flex flex-wrap items-start justify-between gap-4'>
          <div className='space-y-1'>
            <CardTitle className='flex items-center gap-2'>
              <FileText className='size-5 text-primary' />
              Meeting summary
            </CardTitle>
            <p className='max-w-2xl text-sm text-muted-foreground'>
              Review the authoritative current version separately from AI
              candidates and human edits.
            </p>
          </div>
          <div className='flex flex-wrap gap-2'>
            {canEdit && currentSummary && (
              <Button
                size='sm'
                variant='outline'
                disabled={Boolean(editorSnapshot) || activate.isPending || !protectedScopeReady || summary.isError}
                onClick={() => {
                  setActivationReview(null)
                  setActivationConflict(false)
                  setActivationLatest(null)
                  setEditorSnapshot(summary.data ?? null)
                  setDraft(currentSummary.content)
                  setEditConflict(null)
                }}
              >
                Edit current
              </Button>
            )}
            {canRegenerate && (
              <Button
                size='sm'
                variant='secondary'
                disabled={!session || regenerate.isPending || regenerationInProgress || !protectedScopeReady}
                onClick={() => regenerate.mutate()}
              >
                <RefreshCw
                  className={regenerate.isPending ? 'animate-spin' : undefined}
                />
                {regenerationInProgress
                  ? 'Regeneration in progress'
                  : regenerationUncertain
                    ? 'Retry unresolved regeneration'
                    : 'Regenerate'}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-6 p-5'>
        {regenerationJob && (
          <div role='status' className='space-y-1 rounded-md border p-3 text-sm'>
            <p className='font-medium'>Summary regeneration: {regenerationJob.status.replaceAll('_', ' ').toLowerCase()}</p>
            {regenerationJob.warningSummary && <p>{regenerationJob.warningSummary}</p>}
            {regenerationJob.errorSummary && <p>{regenerationJob.errorSummary}</p>}
          </div>
        )}
        {summary.isPending ? (
          <RequestLoading label='Loading the current summary snapshot…' />
        ) : summary.isError ? (
          normalizeCoreApiError(summary.error).status === 404 &&
          protectedScopeReady ? (
            <RequestEmpty
              title='No summary available'
              description='No authoritative version is available yet. Eligible regeneration can create a reviewable candidate.'
            />
          ) : (
            <RequestError
              error={summary.error}
              retry={() => void summary.refetch()}
            />
          )
        ) : null}
        {(editorSnapshot || (!summary.isError && summary.data)) && (
          <CurrentSummary
            snapshot={editorSnapshot ?? summary.data!}
            editorSnapshot={editorSnapshot}
            draft={draft}
            savePending={save.isPending}
            saveBlocked={Boolean(editConflict) || !canEdit || !protectedScopeReady}
            onDraftChange={setDraft}
            onSave={() => save.mutate()}
            onCancel={() => {
              if (save.isPending) return
              if (editorSnapshot && draft !== editorSnapshot.summary.content && !window.confirm('Discard unsaved summary changes?')) return
              setEditorSnapshot(null)
              setEditConflict(null)
            }}
          />
        )}

        {editConflict && (
          <div
            role='alert'
            className='space-y-3 rounded-lg border border-amber-300/70 bg-amber-50 p-4 text-sm dark:bg-amber-950/20'
          >
            <p className='flex items-center gap-2 font-medium'>
              <AlertTriangle className='size-4' />
              This summary changed while you were editing.
            </p>
            <div className='grid gap-3 lg:grid-cols-2'>
              <ConflictColumn
                title='Your reviewed version'
                content={editConflict.reviewed.summary.content}
              />
              {editConflict.latest ? (
                <ConflictColumn
                  title='Latest server version'
                  content={editConflict.latest.summary.content}
                />
              ) : (
                <p>The latest version has not been verified. Retry before saving.</p>
              )}
            </div>
            <p className='text-muted-foreground'>
              Your pending changes remain in the editor. Review the latest
              version before establishing a new baseline.
            </p>
            <Button
              size='sm'
              variant='outline'
              onClick={() => {
                if (editConflict.latest) {
                  setEditorSnapshot(editConflict.latest)
                  setEditConflict(null)
                } else {
                  const ownsScope = captureScope()
                  void summary.refetch().then((latest) => {
                    if (ownsScope() && latest.isSuccess && latest.data) {
                      setEditConflict({ reviewed: editConflict.reviewed, latest: latest.data })
                    }
                  })
                }
              }}
            >
              {editConflict.latest ? 'Use latest as editing baseline' : 'Retry loading latest version'}
            </Button>
          </div>
        )}

        {activationConflict && (
          <div
            role='alert'
            className='rounded-lg border border-amber-300/70 bg-amber-50 p-4 text-sm dark:bg-amber-950/20'
          >
            The current summary changed before activation. Review the refreshed
            current version and explicitly select Activate again.
            {activationLatest && activationReview && (
              <div className='mt-3 grid gap-3 lg:grid-cols-2'>
                <ConflictColumn title='Previously reviewed current' content={activationReview.baseline.summary.content} />
                <ConflictColumn title='Latest current' content={activationLatest.summary.content} />
              </div>
            )}
            <Button className='mt-3' size='sm' variant='outline' onClick={() => {
              setActivationReview(null)
              setActivationConflict(false)
              setActivationLatest(null)
            }}>
              Close outdated activation review
            </Button>
          </div>
        )}

        <section className='space-y-4 border-t pt-5'>
          <div className='flex flex-wrap items-end justify-between gap-3'>
            <div>
              <h3 className='font-semibold'>Version history</h3>
              <p className='text-sm text-muted-foreground'>
                Historical versions are read-only until an eligible fresh
                version is explicitly activated.
              </p>
            </div>
            {versions.data && (
              <span className='text-xs text-muted-foreground'>
                {summaryVersionPageLabel(versions.data.page)}
              </span>
            )}
          </div>
          {versions.isPending ? (
            <RequestLoading label='Loading summary versions…' />
          ) : historyError ? (
            <RequestError
              error={versions.error}
              retry={() => void versions.refetch()}
            />
          ) : !versions.data?.items.length ? (
            <RequestEmpty
              title='No summary versions'
              description='Generated and human-reviewed versions will appear here.'
            />
          ) : (
            <>
              <div className='grid gap-2'>
                {versions.data.items.map((version) => (
                  <VersionRow
                    key={version.id}
                    version={version}
                    selected={version.id === selectedVersion?.id}
                    onSelect={() => {
                      if (activate.isPending) return
                      setSelectedVersionId(version.id)
                      setActivationReview(null)
                      setActivationLatest(null)
                      setActivationConflict(false)
                    }}
                  />
                ))}
              </div>
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={
                    !versions.data.page.hasPrevious || versions.isFetching
                  }
                  onClick={() => {
                    setActivationReview(null)
                    setActivationConflict(false)
                    setHistoryPage((page) => Math.max(0, page - 1))
                  }}
                >
                  Previous
                </Button>
                <span className='text-xs text-muted-foreground'>
                  {versions.data.page.totalElements} total version
                  {versions.data.page.totalElements === 1 ? '' : 's'}
                </span>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={!versions.data.page.hasNext || versions.isFetching}
                  onClick={() => {
                    setActivationReview(null)
                    setActivationConflict(false)
                    setHistoryPage((page) => page + 1)
                  }}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </section>

        {selectedVersion && (
          <section className='space-y-4 rounded-lg border bg-muted/10 p-4'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div>
                <h3 className='font-semibold'>
                  Version {selectedVersion.versionNumber} preview
                </h3>
                <p className='text-xs text-muted-foreground'>
                  {selectedVersion.sourceType} · created{' '}
                  {formatDate(selectedVersion.createdAt)}
                  {selectedVersion.isStale ? ' · source is stale' : ''}
                </p>
              </div>
              <Button
                size='sm'
                variant='outline'
                onClick={() => setComparisonOpen((open) => !open)}
                disabled={!currentSummary}
              >
                <Columns2 />
                {comparisonOpen ? 'Hide comparison' : 'Compare with current'}
              </Button>
            </div>
            {selectedVersion.aiWarnings?.map((warning, index) => (
              <p key={index} className='flex gap-2 text-sm text-amber-700'>
                <AlertTriangle className='mt-0.5 size-4 shrink-0' />
                {warning}
              </p>
            ))}
            {canEdit && summary.data && !summary.isError && !editorSnapshot &&
              !selectedVersion.isCurrent && !selectedVersion.isStale && !activationReview && (
                <Button size='sm' variant='outline' onClick={() => {
                  if (!summary.data) return
                  setActivationReview({ candidate: selectedVersion, baseline: summary.data })
                  setActivationConflict(false)
                }}>
                  Review activation
                </Button>
              )}
            {activationReview && (
              <section className='space-y-3 rounded-md border p-3'>
                <h4 className='font-medium'>Review activation of version {activationReview.candidate.versionNumber}</h4>
                <div className='grid gap-3 lg:grid-cols-2'>
                  <PreviewColumn title={`Reviewed current v${activationReview.baseline.summary.versionNumber}`} content={activationReview.baseline.summary.content} />
                  <PreviewColumn title={`Candidate v${activationReview.candidate.versionNumber}`} content={activationReview.candidate.content} />
                </div>
                <div className='flex flex-wrap gap-2'>
                  <Button disabled={activate.isPending || activationConflict || !canEdit || !activationCandidate || activationCandidate.isCurrent || activationCandidate.isStale} onClick={() => activate.mutate()}>
                    Activate reviewed version
                  </Button>
                  <Button variant='outline' disabled={activate.isPending} onClick={() => {
                    setActivationReview(null)
                    setActivationConflict(false)
                    setActivationLatest(null)
                  }}>Cancel activation</Button>
                </div>
              </section>
            )}
            {comparisonOpen && currentSummary ? (
              <div className='grid gap-4 lg:grid-cols-2'>
                <PreviewColumn
                  title={`Historical version ${selectedVersion.versionNumber}`}
                  content={selectedVersion.content}
                />
                <PreviewColumn
                  title={`Current version ${currentSummary.versionNumber}`}
                  content={currentSummary.content}
                />
              </div>
            ) : (
              <p className='text-sm leading-7 whitespace-pre-wrap'>
                {selectedVersion.content}
              </p>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  )
}

