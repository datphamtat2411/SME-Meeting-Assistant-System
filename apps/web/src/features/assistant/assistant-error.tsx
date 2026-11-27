import { RefreshCw, ShieldAlert } from 'lucide-react'
import { type CoreApiError, normalizeCoreApiError } from '@/lib/core-api'
import { useUiTranslation } from '@/lib/i18n'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

export function AssistantError({
  error,
  onRetry,
  retryDisabled,
}: {
  error: unknown
  onRetry?: () => void
  retryDisabled?: boolean
}) {
  const { t } = useUiTranslation()
  const failure = normalizeCoreApiError(error)
  return (
    <Alert variant='destructive'>
      <ShieldAlert />
      <AlertTitle>{assistantErrorTitle(failure, t)}</AlertTitle>
      <AlertDescription>
        <p>{assistantErrorMessage(failure, t)}</p>
        {onRetry && (
          <Button
            type='button'
            size='sm'
            variant='outline'
            onClick={onRetry}
            disabled={retryDisabled}
          >
            <RefreshCw className='size-4' /> {t('assistant:retryRefresh')}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

function assistantErrorTitle(
  error: CoreApiError,
  t: (key: string) => string
): string {
  if (error.status === 401) return t('assistant:authTitle')
  if (error.status === 403) return t('assistant:deniedTitle')
  if (error.code === 'ASSISTANT_MESSAGE_NOT_FOUND')
    return t('assistant:answerUnavailable')
  if (error.status === 404) return t('assistant:conversationUnavailable')
  if (error.code === 'ASSISTANT_SOURCE_STALE') return t('assistant:staleTitle')
  if (error.code === 'ASSISTANT_TURN_IN_PROGRESS')
    return t('assistant:turnInProgress')
  if (error.code === 'ASSISTANT_IDEMPOTENCY_CONFLICT')
    return t('assistant:identityConflict')
  if (error.code === 'ASSISTANT_CONVERSATION_INACTIVE')
    return t('assistant:inactiveTitle')
  if (error.code === 'ASSISTANT_TURN_FAILED') return t('assistant:failedTitle')
  if (error.status === 409) return t('assistant:conflictTitle')
  if (error.status === 429) return t('assistant:limitedTitle')
  if (error.status === 503) return t('assistant:unavailableTitle')
  if (error.kind === 'malformed') return t('assistant:malformedTitle')
  if (error.recoveryOutcome === 'uncertain' || error.isNetworkError) {
    return t('assistant:uncertainTitle')
  }
  return t('assistant:failedRequestTitle')
}

function assistantErrorMessage(
  error: CoreApiError,
  t: (key: string) => string
): string {
  if (error.status === 401) return t('assistant:authMessage')
  if (error.status === 403) {
    return t('assistant:deniedMessage')
  }
  if (error.code === 'ASSISTANT_MESSAGE_NOT_FOUND') {
    return t('assistant:answerUnavailableMessage')
  }
  if (error.status === 404) {
    return t('assistant:conversationUnavailableMessage')
  }
  if (error.code === 'ASSISTANT_SOURCE_STALE') {
    return t('assistant:staleMessage')
  }
  if (error.code === 'ASSISTANT_TURN_IN_PROGRESS') {
    return t('assistant:turnInProgressMessage')
  }
  if (error.code === 'ASSISTANT_IDEMPOTENCY_CONFLICT') {
    return t('assistant:identityConflictMessage')
  }
  if (error.code === 'ASSISTANT_CONVERSATION_INACTIVE') {
    return t('assistant:inactiveMessage')
  }
  if (error.code === 'ASSISTANT_TURN_FAILED') {
    return t('assistant:failedTurnMessage')
  }
  if (error.status === 409) {
    return t('assistant:conflictMessage')
  }
  if (error.status === 422) {
    return error.message
  }
  if (error.status === 429) {
    return t('assistant:limitedMessage')
  }
  if (error.status === 503) {
    return t('assistant:unavailableMessage')
  }
  if (error.kind === 'malformed') {
    return t('assistant:malformedMessage')
  }
  if (error.recoveryOutcome === 'uncertain' || error.isNetworkError) {
    return t('assistant:uncertainMessage')
  }
  return t('assistant:genericFailure')
}
