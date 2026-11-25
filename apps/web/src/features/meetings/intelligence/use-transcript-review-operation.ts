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
export function useTranscriptReviewOperation(scope: ReviewScope) {
  const scopeRef = useRef(scope)
  const executionRef = useRef<ReviewExecution | null>(null)
  const [pending, setPending] = useState(false)
  const [interrupted, setInterrupted] = useState<ReviewExecution | null>(null)

  useLayoutEffect(() => {
    scopeRef.current = scope
    const active = executionRef.current
    if (active && (!sameScope(active.scope, scope) || !scope.canRead)) {
      executionRef.current = null
      active.controller.abort()
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
    },
    []
  )

  const acquire = useCallback((kind: ReviewExecution['kind']) => {
    const current = scopeRef.current
    if (executionRef.current || !canExecute(current, kind)) return null
    const execution: ReviewExecution = {
      scope: current,
      kind,
      controller: new AbortController(),
    }
    executionRef.current = execution
    setInterrupted(null)
    setPending(true)
    return execution
  }, [])

  const isCurrent = useCallback((execution: ReviewExecution) => {
    const current = scopeRef.current
    return (
      executionRef.current === execution &&
      !execution.controller.signal.aborted &&
      sameScope(execution.scope, current) &&
      current.canRead
    )
  }, [])

  const release = useCallback((execution: ReviewExecution) => {
    if (executionRef.current !== execution) return
    executionRef.current = null
    setPending(false)
  }, [])

  return { acquire, isCurrent, release, pending, interrupted }
}
