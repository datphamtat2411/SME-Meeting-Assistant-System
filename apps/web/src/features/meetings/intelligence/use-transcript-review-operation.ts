import { useCallback, useLayoutEffect, useRef, useState } from 'react'

type ReviewScope = {
  meetingId: string
  actorId: string | null
  transcriptId: string | null
  canRead: boolean
  confirmedAccessLoss: boolean
  canCorrect: boolean
  canMap: boolean
}

export type ReviewExecution = {
  scope: ReviewScope
  kind: 'correction' | 'mapping'
  controller: AbortController
  releaseCommand?: (owner: object) => void
}

function sameScope(a: ReviewScope, b: ReviewScope): boolean {
  return (
    a.meetingId === b.meetingId &&
    a.actorId === b.actorId &&
    a.transcriptId === b.transcriptId
  )
}

function canExecute(scope: ReviewScope, kind: ReviewExecution['kind']) {
  return (
    scope.canRead &&
    Boolean(scope.transcriptId) &&
    (kind === 'correction' ? scope.canCorrect : scope.canMap)
  )
}

/** One synchronous write boundary for the current review snapshot. */
export function useTranscriptReviewOperation(
  scope: ReviewScope,
  claimCommand?: (owner: object) => boolean,
  releaseCommand?: (owner: object) => void
) {
  const scopeRef = useRef(scope)
  const executionRef = useRef<ReviewExecution | null>(null)
  const [pending, setPending] = useState(false)
  const [interrupted, setInterrupted] = useState<ReviewExecution | null>(null)

  useLayoutEffect(() => {
    scopeRef.current = scope
    const active = executionRef.current
    if (
      active &&
      (!sameScope(active.scope, scope) || !canExecute(scope, active.kind))
    ) {
      executionRef.current = null
      active.controller.abort()
      active.releaseCommand?.(active)
      setPending(false)
      if (sameScope(active.scope, scope) && !scope.confirmedAccessLoss) {
        setInterrupted(active)
      }
    }
  }, [scope])

  useLayoutEffect(
    () => () => {
      const active = executionRef.current
      executionRef.current = null
      active?.controller.abort()
      if (active) active.releaseCommand?.(active)
    },
    []
  )

  const acquire = useCallback(
    (kind: ReviewExecution['kind']) => {
      const current = scopeRef.current
      if (executionRef.current || !canExecute(current, kind)) return null
      const execution: ReviewExecution = {
        scope: current,
        kind,
        controller: new AbortController(),
        releaseCommand,
      }
      if (claimCommand && !claimCommand(execution)) return null
      executionRef.current = execution
      setInterrupted(null)
      setPending(true)
      return execution
    },
    [claimCommand, releaseCommand]
  )

  const isCurrent = useCallback((execution: ReviewExecution) => {
    const current = scopeRef.current
    return (
      executionRef.current === execution &&
      !execution.controller.signal.aborted &&
      sameScope(execution.scope, current) &&
      canExecute(current, execution.kind)
    )
  }, [])

  const clearInterrupted = useCallback(() => setInterrupted(null), [])

  const release = useCallback((execution: ReviewExecution) => {
    if (executionRef.current !== execution) return
    executionRef.current = null
    execution.releaseCommand?.(execution)
    setPending(false)
  }, [])

  return { acquire, isCurrent, release, pending, interrupted, clearInterrupted }
}
