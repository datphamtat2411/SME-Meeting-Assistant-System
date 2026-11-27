import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useUiTranslation } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { RequestEmpty, RequestLoading } from '@/components/request-state'
import {
  assistantHistoryEpoch,
  isAssistantAccessCurrent,
  useAssistantAccessRevision,
  type AssistantAccessToken,
} from './assistant-access'
import type { AssistantMessage } from './assistant-api'
import { AssistantError } from './assistant-error'
import {
  evidenceWorkspaceSearch,
  readAssistantMessageEvidence,
  type AssistantMessageEvidence,
} from './assistant-evidence-api'

type Result =
  | { kind: 'loading' }
  | {
      kind: 'ready'
      evidence: AssistantMessageEvidence
      message: AssistantMessage
    }
  | { kind: 'error'; error: unknown; message: AssistantMessage }

const destinationLabels = {
  TRANSCRIPT: 'assistant:destination_TRANSCRIPT',
  SUMMARY: 'assistant:destination_SUMMARY',
  DECISION: 'assistant:destination_DECISION',
  ACTION_ITEM: 'assistant:destination_ACTION_ITEM',
  MEETING: 'assistant:destination_MEETING',
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
  const { t } = useUiTranslation()
  const client = useQueryClient()
  useAssistantAccessRevision(client)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<Result>({ kind: 'loading' })
  const current = () =>
    isAssistantAccessCurrent(client, access) &&
    assistantHistoryEpoch(client, conversationId) === epoch
  useEffect(() => {
    const controller = new AbortController()
    const owned = () =>
      !controller.signal.aborted &&
      isAssistantAccessCurrent(client, access) &&
      assistantHistoryEpoch(client, conversationId) === epoch
    if (owned())
      void readAssistantMessageEvidence(
        client,
        conversationId,
        meetingId,
        message,
        controller.signal
      )
        .then((evidence) => {
          if (owned()) setResult({ kind: 'ready', evidence, message })
        })
        .catch((error: unknown) => {
          if (owned()) setResult({ kind: 'error', error, message })
        })
    return () => controller.abort()
  }, [client, conversationId, meetingId, message, access, epoch, attempt])

  if (!current() || message.visibility !== 'VISIBLE') return null
  const visibleResult: Result =
    result.kind === 'loading' || result.message === message
      ? result
      : { kind: 'loading' }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent
        className='w-full overflow-hidden sm:max-w-md'
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocus.isConnected) returnFocus.focus()
        }}
      >
        <SheetHeader>
          <SheetTitle>{t('assistant:supportingEvidence')}</SheetTitle>
          <SheetDescription>
            {t('assistant:evidenceDescription')}
          </SheetDescription>
        </SheetHeader>
        <div className='min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4'>
          {visibleResult.kind === 'loading' && (
            <RequestLoading label={t('assistant:resolvingEvidence')} />
          )}
          {visibleResult.kind === 'error' && (
            <AssistantError
              error={visibleResult.error}
              onRetry={() => {
                if (!current()) return
                setResult({ kind: 'loading' })
                setAttempt((previous) => previous + 1)
              }}
            />
          )}
          {visibleResult.kind === 'ready' &&
            !visibleResult.evidence.evidence.length && (
              <RequestEmpty title={t('assistant:noEvidence')} />
            )}
          {visibleResult.kind === 'ready' &&
            visibleResult.evidence.evidence.map((entry, index) => (
              <section
                key={entry.citationId}
                className={
                  'space-y-2 rounded-lg border p-3 wrap-anywhere ' +
                  (entry.citationId === citationId
                    ? 'border-primary ring-1 ring-primary'
                    : '')
                }
              >
                <h3 className='font-medium'>
                  [{index + 1}] {entry.label}
                </h3>
                <p className='text-xs text-muted-foreground'>
                  {entry.meetingTitle} ·{' '}
                  {t('assistant:revision', { revision: entry.sourceRevision })}
                </p>
                {entry.claimIds.length > 0 && (
                  <p className='text-xs text-muted-foreground'>
                    {entry.claimIds.length === 1
                      ? t('assistant:relatedClaim')
                      : t('assistant:relatedClaims')}{' '}
                    {message.claims
                      .flatMap((claim, claimIndex) =>
                        entry.claimIds.includes(claim.claimId)
                          ? [claimIndex + 1]
                          : []
                      )
                      .join(', ')}
                  </p>
                )}
                {entry.preview !== null ? (
                  <div className='space-y-1'>
                    <p className='text-xs text-muted-foreground'>
                      {t('assistant:canonicalPreview')}
                    </p>
                    <p className='text-sm leading-6 whitespace-pre-wrap'>
                      {entry.preview}
                    </p>
                  </div>
                ) : (
                  <p className='text-sm text-muted-foreground'>
                    {entry.sourceType === 'TRANSCRIPT'
                      ? t('assistant:transcriptLevel')
                      : t('assistant:noPreview')}
                  </p>
                )}
                <Button asChild variant='outline' size='sm'>
                  <Link
                    to='/meetings/$meetingId'
                    params={{ meetingId }}
                    search={evidenceWorkspaceSearch(entry)}
                    onClick={(event) => {
                      if (!current()) event.preventDefault()
                    }}
                  >
                    {t(destinationLabels[entry.sourceType])}
                  </Link>
                </Button>
              </section>
            ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
