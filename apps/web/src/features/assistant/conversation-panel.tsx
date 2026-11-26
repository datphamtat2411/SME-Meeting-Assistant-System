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
import { chronologicalHistoryMessages } from './assistant-history'
import { ConversationHistory } from './message-history'
import type {
  ConversationHistoryQuery,
  ProcessingTurn,
  Submission,
} from './assistant-types'

export function ConversationPanel({
  listAccessError,
  detailAccessError,
  onDetailAccessRetry,
  selectedMeetingTitle,
  selectedConversationId,
  selectedConversation,
  detailQuery,
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
  submission,
  submissionError,
  processingTurn,
  pollingStopped,
  pollingError,
  pollingAttempts,
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
  submission?: Submission
  submissionError: unknown
  processingTurn?: ProcessingTurn
  pollingStopped: boolean
  pollingError: unknown
  pollingAttempts: number
  onRefresh: () => void
  onResumePolling: () => void
}) {
  if (!selectedConversationId || listAccessError) return null
  if (detailAccessError) {
    return (
      <AssistantError error={detailAccessError} onRetry={onDetailAccessRetry} />
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
      {(detailQuery.isPending || (detailQuery.isFetching && !detailQuery.isFetchingNextPage)) ? (
        <RequestLoading label='Loading conversation history…' />
      ) : detailQuery.isError && !detailQuery.data ? (
        <AssistantError
          error={detailQuery.error}
          onRetry={() => void detailQuery.refetch()}
        />
      ) : detailQuery.data ? (
        <ConversationHistory
          messages={chronologicalHistoryMessages(detailQuery.data.pages)}
          hasMore={Boolean(detailQuery.hasNextPage)}
          loadingOlder={detailQuery.isFetchingNextPage}
          olderPageError={
            detailQuery.isFetchNextPageError
              ? detailQuery.error
              : undefined
          }
          onLoadOlder={onLoadOlderMessages}
        />
      ) : null}
      {historyRefreshError !== undefined &&
        historyRefreshError !== null && (
          <AssistantError error={historyRefreshError} />
        )}

      {(processingTurn || pollingStopped) && (
        <Alert>
          <LoaderCircle className='animate-spin' />
          <AlertTitle>Core is processing this question.</AlertTitle>
          <AlertDescription>
            {pollingStopped
              ? `Core accepted the turn, but completion was not observed after ${pollingAttempts} bounded checks. Refresh history or resume read-only status checks; the question will not be submitted again automatically.`
              : 'The accepted turn remains PROCESSING. The Web is checking conversation history without creating another request.'}
            {pollingStopped && (
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

      {submissionError !== undefined && submissionError !== null && (
        <AssistantError
          error={submissionError}
          onRetry={submission ? onQuestionRetry : undefined}
        />
      )}
      {pollingError !== undefined &&
        pollingError !== null &&
        submissionError === undefined && (
          <AssistantError
            error={pollingError}
            onRetry={onResumePolling}
          />
        )}

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
            disabled={questionBusy || isBlankAssistantQuestion(question) || questionCount > ASSISTANT_QUESTION_LIMIT}
          >
            {questionMutationLabel(questionBusy, processingTurn)}
          </Button>
        </div>
      </form>
    </div>
  )
}

function questionMutationLabel(
  busy: boolean,
  processingTurn?: ProcessingTurn
): ReactNode {
  if (processingTurn) return 'Processing…'
  if (busy) return <LoaderCircle className='size-4 animate-spin' />
  return 'Ask Assistant'
}
