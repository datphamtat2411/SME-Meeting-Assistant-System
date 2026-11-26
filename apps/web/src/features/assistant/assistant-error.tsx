import { RefreshCw, ShieldAlert } from 'lucide-react'
import { type CoreApiError, normalizeCoreApiError } from '@/lib/core-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

export function AssistantError({
  error,
  onRetry,
}: {
  error: unknown
  onRetry?: () => void
}) {
  const failure = normalizeCoreApiError(error)
  return (
    <Alert variant='destructive'>
      <ShieldAlert />
      <AlertTitle>{assistantErrorTitle(failure)}</AlertTitle>
      <AlertDescription>
        <p>{assistantErrorMessage(failure)}</p>
        {onRetry && (
          <Button type='button' size='sm' variant='outline' onClick={onRetry}>
            <RefreshCw className='size-4' /> Retry or refresh
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

function assistantErrorTitle(error: CoreApiError): string {
  if (error.status === 401) return 'Authentication required'
  if (error.status === 403) return 'Assistant access denied'
  if (error.status === 404) return 'Conversation unavailable'
  if (error.code === 'ASSISTANT_SOURCE_STALE') return 'Assistant evidence is stale'
  if (error.code === 'ASSISTANT_TURN_IN_PROGRESS') return 'An Assistant turn is already processing'
  if (error.code === 'ASSISTANT_IDEMPOTENCY_CONFLICT') return 'Assistant request identity conflicts'
  if (error.code === 'ASSISTANT_CONVERSATION_INACTIVE') return 'Conversation is inactive'
  if (error.code === 'ASSISTANT_TURN_FAILED') return 'Assistant turn failed'
  if (error.status === 409) return 'Assistant operation conflicts with current state'
  if (error.status === 429) return 'Assistant admission is limited'
  if (error.status === 503) return 'Assistant is currently unavailable.'
  if (error.kind === 'malformed') return 'Assistant response was invalid.'
  if (error.recoveryOutcome === 'uncertain' || error.isNetworkError) {
    return 'Assistant request outcome is uncertain'
  }
  return 'Assistant request failed'
}

function assistantErrorMessage(error: CoreApiError): string {
  if (error.status === 401) return 'Sign in again to use the Assistant.'
  if (error.status === 403) {
    return 'You are not authorized to use this Assistant conversation.'
  }
  if (error.status === 404) {
    return 'This conversation or meeting is no longer available to your account.'
  }
  if (error.code === 'ASSISTANT_SOURCE_STALE') {
    return 'Assistant evidence is stale or unavailable. Refresh history before asking again.'
  }
  if (error.code === 'ASSISTANT_TURN_IN_PROGRESS') {
    return 'A previous question is still processing. Refresh history before submitting another question.'
  }
  if (error.code === 'ASSISTANT_IDEMPOTENCY_CONFLICT') {
    return 'This request identity belongs to a different question.'
  }
  if (error.code === 'ASSISTANT_CONVERSATION_INACTIVE') {
    return 'This conversation no longer accepts new questions.'
  }
  if (error.code === 'ASSISTANT_TURN_FAILED') {
    return 'Core confirmed that this turn failed. Replaying its request identity will not restart inference.'
  }
  if (error.status === 409) {
    return 'The operation conflicts with the current conversation state. Refresh history before proceeding.'
  }
  if (error.status === 422) {
    return error.message
  }
  if (error.status === 429) {
    return 'Core is limiting concurrent Assistant work. Try again explicitly later.'
  }
  if (error.status === 503) {
    return 'The Core Assistant capability is disabled, unavailable, or failed safely. No local answer was generated.'
  }
  if (error.kind === 'malformed') {
    return 'Core returned an invalid Assistant response. No answer was displayed.'
  }
  if (error.recoveryOutcome === 'uncertain' || error.isNetworkError) {
    return 'Core may have accepted the request, but its outcome is not known. Refresh history or retry the same question explicitly; it will not be duplicated automatically.'
  }
  return error.message
}
