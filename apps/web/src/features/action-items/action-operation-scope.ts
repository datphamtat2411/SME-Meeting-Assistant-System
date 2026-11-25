import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getAuthLifecycleSnapshot,
  subscribeAuthLifecycle,
} from '@/features/auth/session/auth-lifecycle'
import {
  currentUserQueryKey,
  currentUserQueryOptions,
  type AuthContext,
} from '@/features/auth/session/current-user'
import { useOptionalMeetingAuthorization } from '@/features/meetings/meeting-authorization-context'

function authLifecycleVersion() {
  const { state, generation } = getAuthLifecycleSnapshot()
  return `${state}:${generation}`
}

/** Item-only readers need not have access to protected meeting content.
 * The capture function itself identifies the current verified review scope.
 * A changed scope must establish a new review, even if authority returns. */
export function useActionOperationScope(resource: string, allowed: boolean) {
  const client = useQueryClient()
  const authorization = useOptionalMeetingAuthorization()
  const currentUser = useQuery({
    ...currentUserQueryOptions(),
    enabled: false,
  })
  const lifecycle = useSyncExternalStore(
    subscribeAuthLifecycle,
    authLifecycleVersion,
    authLifecycleVersion
  )
  const identity = authorization ? authorization.identity : currentUser.data
  const actorId = identity?.userId
  const sessionId = identity?.session?.id
  const available = Boolean(
    allowed &&
      actorId &&
      sessionId &&
      !currentUser.isError &&
      lifecycle.startsWith('idle:') &&
      (!authorization ||
        (authorization.scopeReady &&
          authorization.capabilities.canReadActionItems &&
          !authorization.isConfirmedAccessLoss))
  )
  const scope = `${resource}:${actorId ?? ''}:${sessionId ?? ''}:${available}:${lifecycle}`
  const activeScope = useRef(scope)
  const generation = useRef(0)
  useLayoutEffect(() => {
    activeScope.current = scope
    generation.current += 1
    return () => {
      generation.current += 1
    }
  }, [scope])

  return useCallback(() => {
    const owner = generation.current
    return () => {
      const current = client.getQueryData<AuthContext>(currentUserQueryKey)
      return (
        available &&
        activeScope.current === scope &&
        generation.current === owner &&
        authLifecycleVersion() === lifecycle &&
        current?.userId === actorId &&
        current?.session?.id === sessionId &&
        client.getQueryState(currentUserQueryKey)?.status === 'success'
      )
    }
  }, [actorId, available, client, lifecycle, scope, sessionId])
}
