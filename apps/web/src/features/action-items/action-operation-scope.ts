import { useCallback, useLayoutEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getAuthLifecycleSnapshot } from '@/features/auth/session/auth-lifecycle'
import {
  currentUserQueryKey,
  type AuthContext,
} from '@/features/auth/session/current-user'
import { useOptionalMeetingAuthorization } from '@/features/meetings/meeting-authorization-context'

/** Item-only readers need not have access to protected meeting content.
 * Protect completion using authenticated scope and resource capabilities. */
export function useActionOperationScope(resource: string, allowed: boolean) {
  const client = useQueryClient()
  const authorization = useOptionalMeetingAuthorization()
  const identity = authorization?.identity
  const available =
    allowed &&
    (!authorization ||
      (authorization.scopeReady &&
        authorization.capabilities.canReadActionItems &&
        !authorization.isConfirmedAccessLoss))
  const scope = `${resource}:${identity?.userId ?? ''}:${identity?.session?.id ?? ''}:${available}`
  const generation = useRef(0)
  useLayoutEffect(() => {
    generation.current += 1
    return () => {
      generation.current += 1
    }
  }, [scope])

  return useCallback(() => {
    const owner = generation.current
    const initial = client.getQueryData<AuthContext>(currentUserQueryKey)
    const auth = getAuthLifecycleSnapshot()
    return () => {
      const current = client.getQueryData<AuthContext>(currentUserQueryKey)
      const lifecycle = getAuthLifecycleSnapshot()
      return (
        available &&
        generation.current === owner &&
        auth.state === 'idle' &&
        lifecycle.state === 'idle' &&
        auth.generation === lifecycle.generation &&
        initial?.userId === current?.userId &&
        initial?.session?.id === current?.session?.id &&
        client.getQueryState(currentUserQueryKey)?.status !== 'error'
      )
    }
  }, [available, client])
}
