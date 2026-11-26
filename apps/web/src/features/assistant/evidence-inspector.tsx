import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { RequestEmpty, RequestLoading } from '@/components/request-state'
import { assistantHistoryEpoch, isAssistantAccessCurrent, useAssistantAccessRevision, type AssistantAccessToken } from './assistant-access'
import type { AssistantMessage } from './assistant-api'
import { AssistantError } from './assistant-error'
import { evidenceWorkspaceSearch, readAssistantMessageEvidence, type AssistantMessageEvidence } from './assistant-evidence-api'

type Result =
  | { kind: 'loading' }
  | { kind: 'ready'; evidence: AssistantMessageEvidence; message: AssistantMessage }
  | { kind: 'error'; error: unknown; message: AssistantMessage }

const destinationLabels = {
  TRANSCRIPT: 'Open transcript',
  SUMMARY: 'Open summary',
  DECISION: 'Open decisions',
  ACTION_ITEM: 'Open action items',
}

export function EvidenceInspector({
  conversationId,
  meetingId,
  message,
  citationId,
  access,
  epoch,
  onClose,
  returnFocus,
}: {
  conversationId: string
  meetingId: string
  message: AssistantMessage
  citationId?: string
  access: AssistantAccessToken
  epoch: number
  onClose: () => void
  returnFocus: HTMLElement
}) {
  const client = useQueryClient()
  useAssistantAccessRevision(client)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<Result>({ kind: 'loading' })
  const current = () =>
    isAssistantAccessCurrent(client, access) &&
    assistantHistoryEpoch(client, conversationId) === epoch
  useEffect(() => {
    const controller = new AbortController()
    const owned = () => !controller.signal.aborted &&
      isAssistantAccessCurrent(client, access) &&
      assistantHistoryEpoch(client, conversationId) === epoch
    if (owned())
      void readAssistantMessageEvidence(client, conversationId, meetingId, message, controller.signal)
        .then((evidence) => { if (owned()) setResult({ kind: 'ready', evidence, message }) })
        .catch((error: unknown) => { if (owned()) setResult({ kind: 'error', error, message }) })
    return () => controller.abort()
  }, [client, conversationId, meetingId, message, access, epoch, attempt])

  if (!current() || message.visibility !== 'VISIBLE') return null
  const visibleResult: Result = result.kind === 'loading' || result.message === message ? result : { kind: 'loading' }
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className='w-full overflow-hidden sm:max-w-md'
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocus.isConnected) returnFocus.focus()
        }}>
        <SheetHeader>
          <SheetTitle>Supporting evidence</SheetTitle>
          <SheetDescription>Verified references for this answer. Previews are canonical source text, not necessarily exact retrieved passages.</SheetDescription>
        </SheetHeader>
        <div className='min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4'>
          {visibleResult.kind === 'loading' && <RequestLoading label='Resolving evidence…' />}
          {visibleResult.kind === 'error' && <AssistantError error={visibleResult.error} onRetry={() => {
            if (!current()) return
            setResult({ kind: 'loading' })
            setAttempt((previous) => previous + 1)
          }} />}
          {visibleResult.kind === 'ready' && !visibleResult.evidence.evidence.length && <RequestEmpty title='No supporting evidence available' />}
          {visibleResult.kind === 'ready' && visibleResult.evidence.evidence.map((entry, index) => (
            <section key={entry.citationId} className={'space-y-2 rounded-lg border p-3 wrap-anywhere ' + (entry.citationId === citationId ? 'border-primary ring-1 ring-primary' : '')}>
              <h3 className='font-medium'>[{index + 1}] {entry.label}</h3>
              <p className='text-xs text-muted-foreground'>{entry.meetingTitle} · Revision {entry.sourceRevision}</p>
              {entry.claimIds.length > 0 && (
                <p className='text-xs text-muted-foreground'>Supports {entry.claimIds.length === 1 ? 'claim' : 'claims'} {message.claims.flatMap((claim, claimIndex) => entry.claimIds.includes(claim.claimId) ? [claimIndex + 1] : []).join(', ')}</p>
              )}
              {entry.preview !== null ? (
                <div className='space-y-1'>
                  <p className='text-xs text-muted-foreground'>Canonical source preview</p>
                  <p className='text-sm leading-6 whitespace-pre-wrap'>{entry.preview}</p>
                </div>
              ) : (
                <p className='text-sm text-muted-foreground'>{entry.sourceType === 'TRANSCRIPT' ? 'Transcript-level reference. Exact passage location is unavailable.' : 'No source preview is available.'}</p>
              )}
              <Button asChild variant='outline' size='sm'>
                <Link to='/meetings/$meetingId' params={{ meetingId }} search={evidenceWorkspaceSearch(entry)}
                  onClick={(event) => { if (!current()) event.preventDefault() }}>
                  {destinationLabels[entry.sourceType]}
                </Link>
              </Button>
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
