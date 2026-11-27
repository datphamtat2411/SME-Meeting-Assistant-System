import { useUiTranslation } from '@/lib/i18n'
import { useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, ShieldAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { RegionalTimestamp } from '@/components/regional-timestamp'
import {
  assistantHistoryEpoch,
  captureAssistantAccess,
  isAssistantAccessCurrent,
  useAssistantAccessRevision,
  type AssistantAccessToken,
} from './assistant-access'
import type { AssistantMessage } from './assistant-api'
import { AssistantError } from './assistant-error'
import { EvidenceInspector } from './evidence-inspector'

const suggestions = [
  'Tóm tắt những nội dung chính của cuộc họp.',
  'Cuộc họp đã thống nhất những quyết định nào?',
  'Ai được giao phụ trách các đầu việc?',
  'Những thời hạn nào đã được thống nhất?',
]

// Presentation metadata only; no protected message bodies survive a history read.
export type HistoryScrollPosition = {
  following: boolean
  reading?: { id: string; offset: number }
  scrollTop?: number
}

type Inspection = {
  messageId: string
  citationId?: string
  epoch: number
  access: AssistantAccessToken
  trigger: HTMLElement
}

export function ConversationHistory({
  conversationId,
  meetingId,
  messages,
  hasMore,
  loadingOlder,
  olderPageError,
  onLoadOlder,
  onSuggestion,
  suggestionsEnabled,
  readPosition,
  writePosition,
  showLatest,
  onShowLatestChange,
}: {
  conversationId: string
  meetingId: string
  messages: AssistantMessage[]
  hasMore: boolean
  loadingOlder: boolean
  olderPageError: unknown
  onLoadOlder: () => void
  onSuggestion: (question: string) => void
  suggestionsEnabled: boolean
  readPosition: () => HistoryScrollPosition
  writePosition: (position: HistoryScrollPosition) => void
  showLatest: boolean
  onShowLatestChange: (show: boolean) => void
}) {
  const { t } = useUiTranslation()
  const client = useQueryClient()
  useAssistantAccessRevision(client)
  const [inspection, setInspection] = useState<Inspection>()
  const viewport = useRef<HTMLDivElement>(null)
  const epoch = assistantHistoryEpoch(client, conversationId)
  const inspected =
    inspection &&
    inspection.epoch === epoch &&
    isAssistantAccessCurrent(client, inspection.access)
      ? messages.find(
          (message) =>
            message.id === inspection.messageId &&
            message.role === 'ASSISTANT' &&
            message.visibility === 'VISIBLE' &&
            message.citations.length > 0
        )
      : undefined

  function rememberPosition(forceReading = false) {
    const node = viewport.current
    if (!node || !node.clientHeight) return
    const following =
      !forceReading &&
      node.scrollHeight - node.scrollTop - node.clientHeight < 80
    onShowLatestChange(!following)
    const top = node.getBoundingClientRect().top
    const first = Array.from(
      node.querySelectorAll<HTMLElement>('[data-message-id]')
    ).find((item) => item.getBoundingClientRect().bottom > top)
    writePosition({
      following,
      scrollTop: node.scrollTop,
      reading: first?.dataset.messageId
        ? {
            id: first.dataset.messageId,
            offset: first.getBoundingClientRect().top - top,
          }
        : undefined,
    })
  }

  useLayoutEffect(() => {
    const node = viewport.current
    if (!node || !node.clientHeight) return
    const { following, reading, scrollTop } = readPosition()
    if (following) {
      node.scrollTop = node.scrollHeight
    } else {
      const anchor = reading
        ? Array.from(
            node.querySelectorAll<HTMLElement>('[data-message-id]')
          ).find((item) => item.dataset.messageId === reading.id)
        : undefined
      if (anchor && reading)
        node.scrollTop +=
          anchor.getBoundingClientRect().top -
          node.getBoundingClientRect().top -
          reading.offset
      else node.scrollTop = scrollTop ?? 0
    }
  }, [messages, readPosition])

  function inspect(
    messageId: string,
    trigger: HTMLElement,
    citationId?: string
  ) {
    const access = captureAssistantAccess(client, conversationId)
    if (!isAssistantAccessCurrent(client, access)) return
    setInspection({ messageId, citationId, epoch, access, trigger })
  }

  return (
    <div className='relative flex min-h-0 flex-1 flex-col'>
      <div
        ref={viewport}
        onScroll={() => rememberPosition()}
        className='min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4 [overflow-anchor:none] sm:px-6'
        aria-label={t('assistant:history')}
        tabIndex={0}
      >
        {olderPageError != null && <AssistantError error={olderPageError} />}
        {hasMore && (
          <div className='flex justify-center'>
            <Button
              type='button'
              variant='outline'
              disabled={loadingOlder}
              onClick={() => {
                rememberPosition(true)
                onLoadOlder()
              }}
            >
              {loadingOlder && <LoaderCircle className='size-4 animate-spin' />}
              {olderPageError
                ? t('assistant:retryOlderMessages')
                : t('assistant:olderMessages')}
            </Button>
          </div>
        )}
        {!messages.length && (
          <div className='mx-auto max-w-lg space-y-4 py-8 text-center'>
            <h3 className='text-lg font-semibold'>
              {t('assistant:ready')}
            </h3>
            <p className='text-sm text-muted-foreground'>
              {t('assistant:explore')}
            </p>
            <div className='grid gap-2 sm:grid-cols-2'>
              {suggestions.map((question) => (
                <Button
                  key={question}
                  type='button'
                  variant='outline'
                  disabled={!suggestionsEnabled}
                  className='h-auto justify-start text-start whitespace-normal'
                  onClick={() => onSuggestion(question)}
                >
                  {question}
                </Button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <AssistantMessageCard
            key={message.id}
            message={message}
            onInspect={inspect}
          />
        ))}
      </div>
      {showLatest && (
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm'
          onClick={() => {
            writePosition({ following: true })
            if (viewport.current)
              viewport.current.scrollTop = viewport.current.scrollHeight
            onShowLatestChange(false)
          }}
        >
          {t('assistant:jumpLatest')}
        </Button>
      )}
      {inspection && inspected && (
        <EvidenceInspector
          key={inspection.messageId + ':' + inspection.epoch}
          conversationId={conversationId}
          meetingId={meetingId}
          message={inspected}
          citationId={inspection.citationId}
          access={inspection.access}
          epoch={inspection.epoch}
          onClose={() => setInspection(undefined)}
          returnFocus={inspection.trigger}
        />
      )}
    </div>
  )
}

const answerLabels = {
  GROUNDED: 'assistant:GROUNDED',
  PARTIAL: 'assistant:PARTIAL',
  INSUFFICIENT_EVIDENCE: 'assistant:INSUFFICIENT_EVIDENCE',
  FAILED: 'assistant:FAILED',
}

const supportLabels: Record<string, string> = {
  SUPPORTED: 'assistant:SUPPORTED',
  UNSUPPORTED: 'assistant:UNSUPPORTED',
  CONFLICTED: 'assistant:CONFLICTED',
}

function AssistantMessageCard({
  message,
  onInspect,
}: {
  message: AssistantMessage
  onInspect: (id: string, trigger: HTMLElement, citationId?: string) => void
}) {
  const { t } = useUiTranslation()
  const isUser = message.role === 'USER'
  const sourceUnavailable = message.visibility !== 'VISIBLE'
  return (
    <article
      data-message-id={message.id}
      className={
        isUser
          ? 'ms-auto max-w-[90%] rounded-2xl bg-primary/10 px-4 py-3 sm:max-w-[75%]'
          : 'me-auto w-full max-w-3xl space-y-2 rounded-2xl border bg-card p-4'
      }
    >
      <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
        <span className='font-medium text-foreground'>
          {isUser ? t('assistant:you') : t('assistant:meetingAssistant')}
        </span>
        <time dateTime={message.createdAt}>
          <RegionalTimestamp value={message.createdAt} />
        </time>
      </div>
      {sourceUnavailable ? (
        <Alert>
          <ShieldAlert />
          <AlertTitle>{t('assistant:sourceUnavailable')}</AlertTitle>
          <AlertDescription>
            {t('assistant:sourceWithheld')}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {!isUser && message.answerStatus && (
            <p className='text-xs font-medium text-muted-foreground'>
              {t(answerLabels[message.answerStatus])}
            </p>
          )}
          {message.content && (
            <p className='text-sm leading-7 wrap-anywhere whitespace-pre-wrap'>
              {message.content}
            </p>
          )}
          {!isUser &&
            message.answerStatus === 'INSUFFICIENT_EVIDENCE' &&
            message.citations.length === 0 && (
              <p className='text-sm text-muted-foreground'>
                {t('assistant:noCitations')}
              </p>
            )}
          {!isUser && message.claims.length > 0 && (
            <details
              className='rounded-lg border px-3 py-2'
              open={
                message.answerStatus === 'PARTIAL' ||
                message.claims.some((claim) => claim.support !== 'SUPPORTED')
              }
            >
              <summary className='cursor-pointer text-sm font-medium'>
                {t('assistant:claims', { count: message.claims.length })}
              </summary>
              <div className='mt-3 space-y-2'>
                {message.claims.map((claim) => (
                  <div
                    key={claim.claimId}
                    className='space-y-1 rounded-md bg-muted/40 p-3 text-sm wrap-anywhere'
                  >
                    <p className='whitespace-pre-wrap'>{claim.text}</p>
                    <p className='text-xs text-muted-foreground'>
                      {supportLabels[claim.support] ? t(supportLabels[claim.support]) : t('assistant:supportUnknown')}
                    </p>
                    <div className='flex flex-wrap gap-1'>
                      {message.citations.map((citation, index) =>
                        claim.citationIds.includes(citation.citationId) &&
                        citation.claimIds.includes(claim.claimId) ? (
                          <Button
                            key={citation.citationId}
                            type='button'
                            variant='outline'
                            size='sm'
                            aria-label={t('assistant:inspectCitation', { number: index + 1 })}
                            onClick={(event) =>
                              onInspect(
                                message.id,
                                event.currentTarget,
                                citation.citationId
                              )
                            }
                          >
                            [{index + 1}]
                          </Button>
                        ) : null
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
          {!isUser && message.citations.length > 0 && (
            <Button
              type='button'
              size='sm'
              variant='outline'
              onClick={(event) => onInspect(message.id, event.currentTarget)}
            >
              {t('assistant:citations', { count: message.citations.length })}
            </Button>
          )}
        </>
      )}
    </article>
  )
}
