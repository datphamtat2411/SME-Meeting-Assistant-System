import { useRef, type FormEvent, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import type { CoreApiError } from '@/lib/core-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
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
import { ConversationHistory } from './message-history'

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
}) {
  const form = useRef<HTMLFormElement>(null)
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
      <RequestLoading label='Loading conversation history…' />
    )
  }

  return (
    <div className='flex h-full min-h-0 flex-col gap-3'>
      <div className='flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-3 py-3 sm:px-6'>
        <div>
          <h3 className='font-semibold'>
            {selectedConversation.title || 'Untitled conversation'}
          </h3>
          <p className='text-sm text-muted-foreground'>
            {selectedMeetingTitle || 'Authorized meeting'} · One meeting
          </p>
        </div>
        {selectedMeetingTitle && (
          <Button asChild type='button' size='sm' variant='ghost'>
            <Link to='/meetings/$meetingId' params={{ meetingId: selectedConversation.meetingId }}>Open meeting</Link>
          </Button>
        )}
        <Button
          type='button'
          size='sm'
          variant='outline'
          onClick={onRefresh}
          disabled={detailQuery.isFetching || historyRefreshing}
        >
          <RefreshCw className='size-4' /> Refresh history
        </Button>
      </div>
      {detailQuery.data ? (
        <ConversationHistory
          key={selectedConversationId}
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
              ? 'Sending your question…'
              : workflow.phase === 'recovering'
                ? 'Resuming the existing request…'
                : workflow.phase === 'recoverable'
              ? 'This request needs to be resumed'
              : workflow.phase === 'paused'
                ? 'Turn outcome is unresolved'
                : workflow.phase === 'uncertain' || workflow.phase === 'lookup'
                  ? workflow.conflict
                    ? 'Question rejected; checking the conflicting request'
                    : 'Question submission is unresolved'
                  : workflow.conflict
                    ? 'Core is processing the existing turn.'
                    : 'Core is processing this question.'}
          </AlertTitle>
          <AlertDescription>
            {workflow.phase === 'recoverable'
              ? 'Resume the existing request. This will not send another question.'
              : workflow.phase === 'paused'
                ? 'Resume read-only status checks to reconcile the durable turn.'
                : workflow.phase === 'uncertain' || workflow.phase === 'lookup'
                  ? workflow.conflict
                    ? 'This question was rejected. Status checks concern the existing request, not acceptance of this question.'
                    : 'The original request identity is retained. No automatic resubmission will occur.'
                  : 'We will check for the result without sending another question.'}
            {workflow.phase === 'recoverable' && (
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={onRecover}
                disabled={inactive}
              >
                Recover turn
              </Button>
            )}
            {(workflow.phase === 'paused' ||
              workflow.phase === 'uncertain') && (
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={onResumePolling}
              >
                Resume status checks
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {workflow?.conflict && <AssistantError error={workflow.conflict} />}
      {workflow?.error != null && (
        <AssistantError
          error={workflow.error}
          onRetry={
            workflow.phase === 'uncertain' &&
            !workflow.conflict &&
            canRetryAssistantSubmission(workflow.error)
              ? onQuestionRetry
              : undefined
          }
        />
      )}
      {workflow && 'retryAt' in workflow && workflow.retryAt != null && (
        <p className='text-sm text-muted-foreground'>
          Core requested no retry before{' '}
          {new Date(workflow.retryAt).toLocaleTimeString()}.
        </p>
      )}
      {inactive && (
        <p className='text-sm text-muted-foreground'>
          This conversation is not active.
        </p>
      )}

      </div>
      <form ref={form} className='shrink-0 space-y-2 border-t bg-background p-3 sm:px-6' onSubmit={onQuestionSubmit}>
        <label className='space-y-1.5 text-sm font-medium'>
          <span>Ask about this meeting</span>
          <Textarea
            aria-label='Assistant question'
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            placeholder='Ask a question grounded in the authorized meeting evidence'
            disabled={questionBusy}
            aria-invalid={questionCount > ASSISTANT_QUESTION_LIMIT || Boolean(questionValidationError)}
            className='max-h-36 min-h-16 resize-y'
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
              event.preventDefault()
              if (!questionBusy && !isBlankAssistantQuestion(question) && questionCount <= ASSISTANT_QUESTION_LIMIT) form.current?.requestSubmit()
            }}
          />
        </label>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <span className='text-xs text-muted-foreground'>
            {questionCount}/4096 Unicode code points · AI-derived answers; verify important details
          </span>
          {(questionValidationError || questionCount > ASSISTANT_QUESTION_LIMIT) && (
            <span role='alert' className='text-sm text-destructive'>
              {questionValidationError || 'Questions must be at most 4096 Unicode code points.'}
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
            {questionMutationLabel(questionBusy, workflow)}
          </Button>
        </div>
      </form>
    </div>
  )
}

function questionMutationLabel(
  busy: boolean,
  workflow?: TurnWorkflow
): ReactNode {
  if (workflow && workflow.phase !== 'settled') return 'Processing…'
  if (busy) return <LoaderCircle className='size-4 animate-spin' />
  return 'Ask Assistant'
}
