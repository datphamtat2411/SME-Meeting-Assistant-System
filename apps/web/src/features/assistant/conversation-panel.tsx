import { localizedValidationMessage } from '@/lib/i18n/presentation'
import { useUiTranslation } from '@/lib/i18n'
import {
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Link } from '@tanstack/react-router'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import type { CoreApiError } from '@/lib/core-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RegionalTimestamp } from '@/components/regional-timestamp'
import { RequestLoading } from '@/components/request-state'
import {
  ASSISTANT_QUESTION_LIMIT,
  isBlankAssistantQuestion,
  type AssistantConversation,
} from './assistant-api'
import { AssistantError } from './assistant-error'
import { canRetryAssistantSubmission } from './assistant-error-policy'
import { chronologicalHistoryMessages } from './assistant-history'
import type { TurnWorkflow } from './assistant-turn-workflow'
import type { ConversationHistoryQuery } from './assistant-types'
import {
  ConversationHistory,
  type HistoryScrollPosition,
} from './message-history'

export function ConversationPanel({
  listAccessError,
  detailAccessError,
  onDetailAccessRetry,
  selectedMeetingTitle,
  selectedConversationId,
  selectedConversation,
  detailQuery,
  historyAccessReady,
  historyRefreshError,
  historyRefreshing,
  onLoadOlderMessages,
  question,
  questionCount,
  questionValidationError,
  onQuestionChange,
  onQuestionSubmit,
  onQuestionRetry,
  questionBusy,
  workflow,
  onRecover,
  inactive,
  onRefresh,
  onResumePolling,
  turnActions,
}: {
  listAccessError?: CoreApiError
  detailAccessError?: CoreApiError
  onDetailAccessRetry: () => void
  selectedMeetingTitle?: string
  selectedConversationId?: string
  selectedConversation?: AssistantConversation
  detailQuery: ConversationHistoryQuery
  historyAccessReady: boolean
  historyRefreshError: unknown
  historyRefreshing: boolean
  onLoadOlderMessages: () => void
  question: string
  questionCount: number
  questionValidationError?: string
  onQuestionChange: (question: string) => void
  onQuestionSubmit: (event: FormEvent<HTMLFormElement>) => void
  onQuestionRetry: () => void
  questionBusy: boolean
  workflow?: TurnWorkflow
  onRecover: () => void
  inactive: boolean
  onRefresh: () => void
  onResumePolling: () => void
  turnActions: {
    recover: boolean
    resume: boolean
    retry: boolean
    blockedUntil?: number
  }
}) {
  const { t } = useUiTranslation()
  const form = useRef<HTMLFormElement>(null)
  const position = useRef<HistoryScrollPosition>({ following: true })
  const readPosition = useCallback(() => position.current, [])
  const writePosition = useCallback((next: HistoryScrollPosition) => {
    position.current = next
  }, [])
  const [showLatest, setShowLatest] = useState(false)
  if (!selectedConversationId || listAccessError) return null
  if (detailAccessError) {
    return (
      <AssistantError error={detailAccessError} onRetry={onDetailAccessRetry} />
    )
  }

  if (!historyAccessReady || !selectedConversation) {
    return detailQuery.isError ? (
      <AssistantError error={detailQuery.error} onRetry={onRefresh} />
    ) : (
      <RequestLoading label={t('assistant:loadingHistory')} />
    )
  }

  return (
    <div className='flex h-full min-h-0 flex-col gap-3'>
      <div className='flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-3 py-3 sm:px-6'>
        <div>
          <h3 className='font-semibold'>
            {selectedConversation.title || t('assistant:untitled')}
          </h3>
          <p className='text-sm text-muted-foreground'>
            {selectedMeetingTitle || t('assistant:authorizedMeeting')} · {t('assistant:oneMeeting')}
          </p>
        </div>
        {selectedMeetingTitle && (
          <Button asChild type='button' size='sm' variant='ghost'>
            <Link
              to='/meetings/$meetingId'
              params={{ meetingId: selectedConversation.meetingId }}
            >
              {t('assistant:openMeeting')}
            </Link>
          </Button>
        )}
        <Button
          type='button'
          size='sm'
          variant='outline'
          onClick={onRefresh}
          disabled={detailQuery.isFetching || historyRefreshing}
        >
          <RefreshCw className='size-4' /> {t('assistant:refreshHistory')}
        </Button>
      </div>
      {detailQuery.data ? (
        <ConversationHistory
          key={selectedConversationId}
          readPosition={readPosition}
          writePosition={writePosition}
          showLatest={showLatest}
          onShowLatestChange={setShowLatest}
          conversationId={selectedConversationId}
          meetingId={selectedConversation.meetingId}
          onSuggestion={onQuestionChange}
          suggestionsEnabled={!questionBusy}
          messages={chronologicalHistoryMessages(detailQuery.data.pages)}
          hasMore={Boolean(detailQuery.hasNextPage)}
          loadingOlder={detailQuery.isFetchingNextPage}
          olderPageError={
            detailQuery.isFetchNextPageError ? detailQuery.error : undefined
          }
          onLoadOlder={onLoadOlderMessages}
        />
      ) : null}
      <div className='max-h-[30%] shrink-0 space-y-2 overflow-y-auto px-3 sm:px-6'>
        {historyRefreshError !== undefined && historyRefreshError !== null && (
          <AssistantError error={historyRefreshError} />
        )}

        {workflow && workflow.phase !== 'settled' && (
          <Alert>
            <AlertTitle>
              {workflow.phase === 'submitting'
                ? t('assistant:sending')
                : workflow.phase === 'recovering'
                  ? t('assistant:resuming')
                  : workflow.phase === 'recoverable'
                    ? t('assistant:recoverable')
                    : workflow.phase === 'paused'
                      ? t('assistant:paused')
                      : workflow.phase === 'uncertain' ||
                          workflow.phase === 'lookup'
                        ? workflow.conflict
                          ? t('assistant:conflict')
                          : t('assistant:uncertain')
                        : workflow.conflict
                          ? t('assistant:existingTurn')
                          : t('assistant:processingQuestion')}
            </AlertTitle>
            <AlertDescription>
              {workflow.phase === 'recoverable'
                ? t('assistant:resumeExisting')
                : workflow.phase === 'paused'
                  ? t('assistant:resumeReadOnly')
                  : workflow.phase === 'uncertain' ||
                      workflow.phase === 'lookup'
                    ? workflow.conflict
                      ? t('assistant:rejectedHint')
                      : t('assistant:identityRetained')
                    : t('assistant:checkWithoutSubmit')}
              {workflow.phase === 'recoverable' && (
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={onRecover}
                  disabled={!turnActions.recover}
                >
                  {t('assistant:recoverTurn')}
                </Button>
              )}
              {(workflow.phase === 'paused' ||
                workflow.phase === 'uncertain') && (
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={onResumePolling}
                  disabled={!turnActions.resume}
                >
                  {t('assistant:resumeChecks')}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        {workflow?.conflict && <AssistantError error={workflow.conflict} />}
        {workflow?.error != null && (
          <AssistantError
            error={workflow.error}
            retryDisabled={!turnActions.retry}
            onRetry={
              workflow.phase === 'uncertain' &&
              !workflow.conflict &&
              canRetryAssistantSubmission(workflow.error)
                ? onQuestionRetry
                : undefined
            }
          />
        )}
        {turnActions.blockedUntil != null && (
          <p className='text-sm text-muted-foreground' role='status'>
            {t('assistant:retryAfter')}{' '}
            <RegionalTimestamp
              value={new Date(turnActions.blockedUntil).toJSON()}
            />
            .
          </p>
        )}
        {inactive && (
          <p className='text-sm text-muted-foreground'>
            {t('assistant:inactive')}
          </p>
        )}
      </div>
      <form
        ref={form}
        className='shrink-0 space-y-2 border-t bg-background p-3 sm:px-6'
        onSubmit={onQuestionSubmit}
      >
        <label className='space-y-1.5 text-sm font-medium'>
          <span>{t('assistant:askThisMeeting')}</span>
          <Textarea
            aria-label={t('assistant:question')}
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            placeholder={t('assistant:questionPlaceholder')}
            disabled={questionBusy}
            aria-invalid={
              questionCount > ASSISTANT_QUESTION_LIMIT ||
              Boolean(questionValidationError)
            }
            className='max-h-36 min-h-16 resize-y'
            onKeyDown={(event) => {
              if (
                event.key !== 'Enter' ||
                event.shiftKey ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229
              )
                return
              event.preventDefault()
              if (
                !questionBusy &&
                !isBlankAssistantQuestion(question) &&
                questionCount <= ASSISTANT_QUESTION_LIMIT
              )
                form.current?.requestSubmit()
            }}
          />
        </label>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <span className='text-xs text-muted-foreground'>
            {t('assistant:questionCount', { count: questionCount })}
          </span>
          {(questionValidationError ||
            questionCount > ASSISTANT_QUESTION_LIMIT) && (
            <span role='alert' className='text-sm text-destructive'>
              {questionValidationError ? localizedValidationMessage(questionValidationError, t) : t('assistant:questionLimit')}
            </span>
          )}
          <Button
            type='submit'
            disabled={
              questionBusy ||
              isBlankAssistantQuestion(question) ||
              questionCount > ASSISTANT_QUESTION_LIMIT
            }
          >
            {questionMutationLabel(t, questionBusy, workflow)}
          </Button>
        </div>
      </form>
    </div>
  )
}

function questionMutationLabel(
  t: (key: string) => string,
  busy: boolean,
  workflow?: TurnWorkflow
): ReactNode {
  if (workflow && workflow.phase !== 'settled') return t('assistant:processing')
  if (busy) return <LoaderCircle className='size-4 animate-spin' />
  return t('assistant:askAssistant')
}
