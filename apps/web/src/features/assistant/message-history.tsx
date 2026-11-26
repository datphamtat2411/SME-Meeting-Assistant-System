import { LoaderCircle, ShieldAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RequestEmpty } from '@/components/request-state'
import type { AssistantMessage } from './assistant-api'
import { AssistantError } from './assistant-error'

export function ConversationHistory({
  messages,
  hasMore,
  loadingOlder,
  olderPageError,
  onLoadOlder,
}: {
  messages: AssistantMessage[]
  hasMore: boolean
  loadingOlder: boolean
  olderPageError: unknown
  onLoadOlder: () => void
}) {
  return (
    <div className='space-y-3' aria-label='Conversation history'>
      {!messages.length && (
        <RequestEmpty
          title='Conversation is ready for questions.'
          description='Core has not recorded any messages in this conversation yet.'
        />
      )}
      {messages.map((message) => (
        <AssistantMessageCard key={message.id} message={message} />
      ))}
      {olderPageError !== undefined && olderPageError !== null && (
        <AssistantError error={olderPageError} />
      )}
      {hasMore && (
        <Button
          type='button'
          variant='outline'
          disabled={loadingOlder}
          onClick={onLoadOlder}
        >
          {loadingOlder && <LoaderCircle className='size-4 animate-spin' />}
          {olderPageError
            ? 'Retry loading older messages'
            : 'Load older messages'}
        </Button>
      )}
    </div>
  )
}

function AssistantMessageCard({ message }: { message: AssistantMessage }) {
  const isUser = message.role === 'USER'
  const sourceUnavailable = message.visibility === 'SOURCE_UNAVAILABLE'
  return (
    <article
      className={`rounded-lg border p-4 ${isUser ? 'bg-muted/30' : 'bg-card'}`}
    >
      <div className='flex flex-wrap items-center gap-2'>
        <Badge variant={isUser ? 'outline' : 'default'}>
          {isUser ? 'You' : 'Assistant'}
        </Badge>
        {!isUser && message.answerStatus && (
          <Badge variant='outline'>{message.answerStatus}</Badge>
        )}
      </div>
      {sourceUnavailable ? (
        <Alert className='mt-3'>
          <ShieldAlert />
          <AlertTitle>Source unavailable</AlertTitle>
          <AlertDescription>
            Core no longer verifies the evidence for this answer. The previous
            answer is not displayed as current grounded content.
          </AlertDescription>
        </Alert>
      ) : (
        message.content && (
          <p className='mt-3 text-sm leading-6 whitespace-pre-wrap'>
            {message.content}
          </p>
        )
      )}
      {!isUser &&
        message.answerStatus === 'INSUFFICIENT_EVIDENCE' &&
        message.citations.length === 0 && (
          <p className='mt-3 text-sm text-muted-foreground'>
            No verified citations were returned.
          </p>
        )}
      {!isUser && !sourceUnavailable && message.claims.length > 0 && (
        <div className='mt-4 space-y-2 border-t pt-3'>
          <p className='text-xs font-semibold tracking-wide text-muted-foreground uppercase'>
            Claims
          </p>
          {message.claims.map((claim) => (
            <div
              className='rounded-md bg-muted/40 p-3 text-sm'
              key={claim.claimId}
            >
              <p>{claim.text}</p>
              <p className='mt-1 text-xs text-muted-foreground'>
                {claim.support}
              </p>
            </div>
          ))}
        </div>
      )}
      {!isUser && !sourceUnavailable && message.citations.length > 0 && (
        <div className='mt-4 space-y-2 border-t pt-3'>
          <p className='text-xs font-semibold tracking-wide text-muted-foreground uppercase'>
            Evidence
          </p>
          {message.citations.map((citation) => (
            <details
              className='rounded-md border px-3 py-2 text-sm'
              key={citation.citationId}
            >
              <summary className='cursor-pointer font-medium'>
                {citation.sourceType} · Revision {citation.sourceRevision}
              </summary>
              <div className='mt-2 space-y-1 text-xs text-muted-foreground'>
                <p>Citation: {citation.citationId}</p>
                <p>Retrieval chunk: {citation.retrievalChunkId}</p>
                <p>Meeting-scoped source: {citation.meetingId}</p>
              </div>
            </details>
          ))}
        </div>
      )}
    </article>
  )
}
