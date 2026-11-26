import { type FormEvent, type ReactNode } from 'react'
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
import type { ConversationHistoryQuery } from './assistant-types'
import type { TurnWorkflow } from './assistant-turn-workflow'
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
  if (!selectedConversationId || listAccessError) return null
  if (detailAccessError) {
    return (
      <AssistantError error={detailAccessError} onRetry={onDetailAccessRetry} />
    )
  }

  if (!historyAccessReady) {
    return detailQuery.isError ? (
      <AssistantError error={detailQuery.error} onRetry={onRefresh} />
    ) : (
      <RequestLoading label='Loading conversation history…' />
    )
  }

  return (
    <div className='space-y-4 border-t pt-5'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h3 className='font-semibold'>
            {selectedConversation?.title || 'Conversation'}
          </h3>
          <p className='text-sm text-muted-foreground'>
            {selectedMeetingTitle || 'Authorized meeting'} ·{' '}
            {selectedConversationId}
          </p>
        </div>
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
          messages={chronologicalHistoryMessages(detailQuery.data.pages)}
          hasMore={Boolean(detailQuery.hasNextPage)}
          loadingOlder={detailQuery.isFetchingNextPage}
          olderPageError={
            detailQuery.isFetchNextPageError ? detailQuery.error : undefined
          }
          onLoadOlder={onLoadOlderMessages}
        />
      ) : null}
      {historyRefreshError !== undefined && historyRefreshError !== null && (
        <AssistantError error={historyRefreshError} />
      )}

      {workflow && workflow.phase !== 'settled' && (
        <Alert>
          <AlertTitle>
            {workflow.phase === 'recoverable' ? 'Execution lease expired' :
              workflow.phase === 'paused' ? 'Turn outcome is unresolved' :
              workflow.phase === 'uncertain' || workflow.phase === 'lookup' ? 'Question submission is unresolved' :
              'Core is processing this question.'}
          </AlertTitle>
          <AlertDescription>
            {workflow.phase === 'recoverable' ? 'Recover this existing turn explicitly. No new question will be created.' :
              workflow.phase === 'paused' ? 'Resume read-only status checks to reconcile the durable turn.' :
              workflow.phase === 'uncertain' || workflow.phase === 'lookup' ? 'The original request identity is retained. No automatic resubmission will occur.' :
              'The Web observes authoritative turn status without creating another request.'}
            {workflow.phase === 'recoverable' && <Button type='button' size='sm' variant='outline' onClick={onRecover} disabled={inactive}>Recover turn</Button>}
            {(workflow.phase === 'paused' || workflow.phase === 'uncertain') && (
              <Button type='button' size='sm' variant='outline' onClick={onResumePolling}>Resume status checks</Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {workflow?.error != null && (
        <AssistantError error={workflow.error}
          onRetry={workflow.phase === 'uncertain' && canRetryAssistantSubmission(workflow.error) ? onQuestionRetry : undefined}
        />
      )}
      {workflow && 'retryAt' in workflow && workflow.retryAt != null && workflow.retryAt > Date.now() && (
        <p className='text-sm text-muted-foreground'>Retry is available after {new Date(workflow.retryAt).toLocaleTimeString()}.</p>
      )}
      {inactive && <p className='text-sm text-muted-foreground'>This conversation is not active.</p>}

      <form className='space-y-3' onSubmit={onQuestionSubmit}>
        <label className='space-y-1.5 text-sm font-medium'>
          <span>Ask about this meeting</span>
          <Textarea
            aria-label='Assistant question'
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            placeholder='Ask a question grounded in the authorized meeting evidence'
            disabled={questionBusy}
          />
        </label>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <span className='text-xs text-muted-foreground'>
            {questionCount}/4096 Unicode code points
          </span>
          {questionValidationError && (
            <span role='alert' className='text-sm text-destructive'>
              {questionValidationError}
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
