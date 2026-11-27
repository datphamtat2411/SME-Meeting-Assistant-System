import { useCallback, useLayoutEffect, useRef } from 'react'
import { useOptionalMeetingSession } from '../media/meeting-session-context'
import { type MeetingAuthorizationContextValue } from '../meeting-authorization-context'

export function intelligenceReadAllowed(
  authorization: MeetingAuthorizationContextValue | null
): boolean {
  return (
    !authorization ||
    (authorization.scopeReady &&
      authorization.canReadProtectedData &&
      authorization.capabilities.canReadIntelligence &&
      !authorization.isConfirmedAccessLoss)
  )
}

/** The owner of an asynchronous mutation must still be the mounted,
 * authorized meeting/session that initiated it when its response arrives. */
export function useIntelligenceOperationScope(
  meetingId: string,
  authorization: MeetingAuthorizationContextValue | null,
  canMutate: boolean
) {
  const scope = `${meetingId}:${authorization?.identity?.userId ?? 'standalone'}:${authorization?.identity?.session?.id ?? ''}:${intelligenceReadAllowed(authorization)}:${canMutate}:${authorization?.canPerformProtectedOperation ?? true}`
  const generation = useRef(0)
  useLayoutEffect(() => {
    generation.current += 1
    return () => {
      generation.current += 1
    }
  }, [scope])

  return useCallback(() => {
    const owner = generation.current
    return () => generation.current === owner
  }, [])
}

/** Register disposable editor work with the existing meeting navigation guard. */
export function useIntelligenceDraftProtection(
  feature: 'summary' | 'decisions',
  dirty: boolean
) {
  const setDirty = useOptionalMeetingSession()?.setIntelligenceDraftDirty
  useLayoutEffect(() => {
    setDirty?.(feature, dirty)
    return () => setDirty?.(feature, false)
  }, [dirty, feature, setDirty])
}
