import { useEffect, useLayoutEffect, useRef, useState } from 'react'

interface UseDirectorySearchDraftOptions {
  criteriaKey: string
  committedQuery?: string
  normalize: (value: string) => string | undefined
  onCommit: (query: string | undefined) => void
  delayMs: number
}

/**
 * Keeps transient input local while the router owns committed directory state.
 * Any committed-criteria navigation replaces the draft and cancels its timer.
 */
export function useDirectorySearchDraft({
  criteriaKey,
  committedQuery,
  normalize,
  onCommit,
  delayMs,
}: UseDirectorySearchDraftOptions) {
  const committedValue = committedQuery ?? ''
  const [draftState, setDraftState] = useState({
    criteriaKey,
    value: committedValue,
  })
  const previousCommitted = useRef({ criteriaKey, committedValue })
  const latest = useRef({
    criteriaKey,
    committedValue,
    normalize,
    onCommit,
  })
  const timer = useRef<number | null>(null)

  if (draftState.criteriaKey !== criteriaKey) {
    setDraftState({ criteriaKey, value: committedValue })
  }

  function cancelPendingCommit() {
    if (timer.current === null) return
    window.clearTimeout(timer.current)
    timer.current = null
  }

  useLayoutEffect(() => {
    latest.current = {
      criteriaKey,
      committedValue,
      normalize,
      onCommit,
    }
  }, [committedValue, criteriaKey, normalize, onCommit])

  useLayoutEffect(() => {
    if (
      previousCommitted.current.criteriaKey !== criteriaKey ||
      previousCommitted.current.committedValue !== committedValue
    ) {
      cancelPendingCommit()
    }
    previousCommitted.current = { criteriaKey, committedValue }
  }, [committedValue, criteriaKey])

  const draft =
    draftState.criteriaKey === criteriaKey ? draftState.value : committedValue

  useEffect(() => {
    if (draftState.criteriaKey !== criteriaKey) return
    if (normalize(draft) === normalize(committedValue)) return

    const scheduledCriteriaKey = criteriaKey
    const scheduledQuery = normalize(draft)
    const scheduledTimer = window.setTimeout(() => {
      timer.current = null
      const current = latest.current
      if (
        current.criteriaKey !== scheduledCriteriaKey ||
        current.normalize(current.committedValue) === scheduledQuery
      ) {
        return
      }
      current.onCommit(scheduledQuery)
    }, delayMs)
    timer.current = scheduledTimer

    return () => {
      window.clearTimeout(scheduledTimer)
      if (timer.current === scheduledTimer) timer.current = null
    }
  }, [
    committedValue,
    criteriaKey,
    delayMs,
    draft,
    draftState.criteriaKey,
    normalize,
  ])

  useEffect(() => cancelPendingCommit, [])

  function updateDraft(value: string) {
    setDraftState({ criteriaKey: latest.current.criteriaKey, value })
  }

  return { draft, updateDraft }
}
