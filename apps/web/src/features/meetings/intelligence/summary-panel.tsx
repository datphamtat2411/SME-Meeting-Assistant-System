import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Columns2, FileText, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { useOptionalMeetingSession } from '../media/meeting-session-context'
import { useOptionalMeetingAuthorization } from '../meeting-authorization-context'
import { invalidateMeetingArtifacts } from './query-invalidation'
import {
  activateSummary,
  editSummary,
  requestSummaryRegeneration,
  summaryQuery,
  summaryVersionPageLabel,
  summaryVersionsQuery,
  type SummarySnapshot,
  type SummaryVersion,
} from './summary-api'

const historyPageSize = 20
const regenerationIdentity = 'summary-regeneration'

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

export function SummaryPanel({
  meetingId,
  canEdit,
  canRegenerate,
}: {
  meetingId: string
  canEdit: boolean
  canRegenerate: boolean
}) {
  const queryClient = useQueryClient()
  const session = useOptionalMeetingSession()
  const authorization = useOptionalMeetingAuthorization()
  const canEditRef = useRef(canEdit)
  const canRegenerateRef = useRef(canRegenerate)
  const authorizationRef = useRef(authorization)
  const fallbackRegenerationKey = useRef<string | null>(null)
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
    latest: SummarySnapshot
  } | null>(null)
  const [activationConflict, setActivationConflict] = useState(false)
  const [activationSnapshot, setActivationSnapshot] =
    useState<SummarySnapshot | null>(null)
  const [activationLatest, setActivationLatest] =
    useState<SummarySnapshot | null>(null)

  useEffect(() => {
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
      if (!editorSnapshot) throw new Error('Open the current summary again.')
      const content = draft.trim()
      if (!content || content.length > 20_000) {
        throw new Error(
          'Summary content must be between 1 and 20,000 characters.'
        )
      }
      return editSummary(meetingId, content, editorSnapshot)
    },
    onSuccess: (result, _variables, _context) => {
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
    onError: (error) => {
      const normalized = normalizeCoreApiError(error)
      if (normalized.status === 412 && editorSnapshot) {
        void summary.refetch().then((latest) => {
          if (latest.data) {
            setEditConflict({ reviewed: editorSnapshot, latest: latest.data })
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
    mutationFn: (versionId: string) => {
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
      const baseline = activationSnapshot ?? summary.data
      if (!baseline) {
        throw new Error(
          'Review the current summary before activating a version.'
        )
      }
      const candidate = versions.data?.items.find(
        (version) => version.id === versionId
      )
      if (!candidate || candidate.isCurrent || candidate.isStale) {
        throw new Error('Only a fresh historical version can be activated.')
      }
      return activateSummary(meetingId, versionId, baseline)
    },
    onSuccess: (result) => {
      queryClient.setQueryData(summaryQuery(meetingId).queryKey, result)
      setActivationConflict(false)
      setActivationSnapshot(null)
      setActivationLatest(null)
      refreshArtifacts()
      toast.success('Selected summary version is now current')
    },
    onError: (error) => {
      const normalized = normalizeCoreApiError(error)
      if (normalized.status === 412) {
        setActivationConflict(true)
        void summary.refetch().then((latest) => {
          if (latest.data) setActivationLatest(latest.data)
        })
        return
      }
      toast.error('Could not activate version', {
        description: normalized.message,
      })
    },
  })

  const regenerate = useMutation({
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
      // This branch only supports isolated feature tests. The real workspace
      // always supplies the meeting-scoped coordinator above.
      fallbackRegenerationKey.current ??= crypto.randomUUID()
      return requestSummaryRegeneration(
        meetingId,
        fallbackRegenerationKey.current
      )
    },
    onSuccess: (result) => {
      if (!session) fallbackRegenerationKey.current = null
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
          'Core accepted a new AI candidate. Review it in version history before activating it.',
      })
    },
    onError: (error) => {
      const normalized = normalizeCoreApiError(error)
      toast.error('Could not request regeneration', {
        description:
          normalized.status === 503
            ? 'Summary generation is currently unavailable because the worker is not ready.'
            : normalized.message,
      })
    },
  })

  const currentSummary = summary.data?.summary
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
                disabled={Boolean(editorSnapshot)}
                onClick={() => {
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
                disabled={regenerate.isPending || regenerationInProgress}
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
        ) : currentSummary ? (
          <CurrentSummary
            snapshot={summary.data}
            editorSnapshot={editorSnapshot}
            draft={draft}
            savePending={save.isPending}
            onDraftChange={setDraft}
            onSave={() => save.mutate()}
            onCancel={() => {
              setEditorSnapshot(null)
              setEditConflict(null)
            }}
          />
        ) : null}

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
              <ConflictColumn
                title='Latest server version'
                content={editConflict.latest.summary.content}
              />
            </div>
            <p className='text-muted-foreground'>
              Your pending changes remain in the editor. Review the latest
              version before establishing a new baseline.
            </p>
            <Button
              size='sm'
              variant='outline'
              onClick={() => {
                setEditorSnapshot(editConflict.latest)
                setEditConflict(null)
              }}
            >
              Use latest as editing baseline
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
            {activationLatest && (
              <Button
                className='mt-3'
                size='sm'
                variant='outline'
                onClick={() => {
                  setActivationSnapshot(activationLatest)
                  setActivationLatest(null)
                  setActivationConflict(false)
                }}
              >
                Use refreshed current as activation baseline
              </Button>
            )}
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
                    canActivate={canEdit && Boolean(summary.data)}
                    activating={activate.isPending}
                    onSelect={() => {
                      setSelectedVersionId(version.id)
                      setActivationSnapshot(summary.data ?? null)
                      setActivationLatest(null)
                      setActivationConflict(false)
                    }}
                    onActivate={() => activate.mutate(version.id)}
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
                  onClick={() =>
                    setHistoryPage((page) => Math.max(0, page - 1))
                  }
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
                  onClick={() => setHistoryPage((page) => page + 1)}
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

function CurrentSummary({
  snapshot,
  editorSnapshot,
  draft,
  savePending,
  onDraftChange,
  onSave,
  onCancel,
}: {
  snapshot: SummarySnapshot
  editorSnapshot: SummarySnapshot | null
  draft: string
  savePending: boolean
  onDraftChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const summary = snapshot.summary
  return (
    <section className='space-y-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <Badge>Current · v{summary.versionNumber}</Badge>
        <Badge variant='outline'>{summary.sourceType}</Badge>
        <Badge variant='outline'>{summary.qualityStatus}</Badge>
        {summary.isStale && <Badge variant='destructive'>Stale source</Badge>}
      </div>
      <div className='grid gap-2 text-xs text-muted-foreground sm:grid-cols-2'>
        <span>Created {formatDate(summary.createdAt)}</span>
        <span>
          Transcript revision {summary.contentRevision ?? 'not available'}
        </span>
        {summary.aiProducer?.model && (
          <span>
            Produced by {summary.aiProducer.provider ?? 'AI'} ·{' '}
            {summary.aiProducer.model}
          </span>
        )}
      </div>
      {summary.aiWarnings?.map((warning, index) => (
        <p
          key={index}
          className='flex gap-2 rounded-md border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-200'
        >
          <AlertTriangle className='mt-0.5 size-4 shrink-0' />
          {warning}
        </p>
      ))}
      {editorSnapshot ? (
        <form
          className='space-y-3'
          onSubmit={(event) => {
            event.preventDefault()
            onSave()
          }}
        >
          <Textarea
            aria-label='Summary content'
            rows={12}
            maxLength={20_000}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
          />
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <span className='text-xs text-muted-foreground'>
              {draft.length.toLocaleString()} / 20,000 characters · editing
              version {editorSnapshot.summary.versionNumber}
            </span>
            <div className='flex gap-2'>
              <Button
                type='submit'
                disabled={savePending || !draft.trim() || draft.length > 20_000}
              >
                {savePending ? 'Saving…' : 'Save reviewed version'}
              </Button>
              <Button type='button' variant='outline' onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <p className='text-base leading-8 whitespace-pre-wrap'>
          {summary.content}
        </p>
      )}
    </section>
  )
}

function VersionRow({
  version,
  selected,
  canActivate,
  activating,
  onSelect,
  onActivate,
}: {
  version: SummaryVersion
  selected: boolean
  canActivate: boolean
  activating: boolean
  onSelect: () => void
  onActivate: () => void
}) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 ${
        selected ? 'border-primary bg-primary/5' : ''
      }`}
    >
      <button
        type='button'
        className='min-w-0 flex-1 text-left'
        onClick={onSelect}
        aria-pressed={selected}
      >
        <span className='flex flex-wrap items-center gap-2 font-medium'>
          Version {version.versionNumber}
          {version.isCurrent && <Badge>Current</Badge>}
          {!version.isCurrent && version.sourceType === 'AI_GENERATED' && (
            <Badge variant='secondary'>AI candidate</Badge>
          )}
          {version.isStale && <Badge variant='destructive'>Stale</Badge>}
        </span>
        <span className='mt-1 block text-xs text-muted-foreground'>
          {version.sourceType} · {formatDate(version.createdAt)}
        </span>
      </button>
      {canActivate && !version.isCurrent && !version.isStale && (
        <Button
          size='sm'
          variant='outline'
          disabled={activating}
          onClick={(event) => {
            event.stopPropagation()
            onActivate()
          }}
        >
          Activate
        </Button>
      )}
    </div>
  )
}

function PreviewColumn({ title, content }: { title: string; content: string }) {
  return (
    <div className='space-y-2 rounded-md border bg-background p-3'>
      <h4 className='text-sm font-medium'>{title}</h4>
      <p className='max-h-96 overflow-auto text-sm leading-7 whitespace-pre-wrap'>
        {content}
      </p>
    </div>
  )
}

function ConflictColumn({
  title,
  content,
}: {
  title: string
  content: string
}) {
  return (
    <div className='rounded-md border bg-background p-3'>
      <h4 className='mb-2 text-xs font-semibold tracking-wide uppercase'>
        {title}
      </h4>
      <p className='max-h-40 overflow-auto text-sm leading-6 whitespace-pre-wrap'>
        {content}
      </p>
    </div>
  )
}
