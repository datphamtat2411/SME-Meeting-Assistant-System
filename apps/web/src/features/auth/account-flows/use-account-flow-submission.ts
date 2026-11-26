import { useEffect, useRef, useState } from 'react'
import {
  type AccountFlowFailure,
  type AccountFlowOperation,
  classifyAccountFlowFailure,
} from './account-flow-errors'

type SubmissionState =
  | { type: 'ready' }
  | { type: 'submitting' }
  | { type: 'completed' }
  | { type: 'failure'; failure: AccountFlowFailure }

function isBlocked(
  state: SubmissionState,
  operation: AccountFlowOperation
): boolean {
  if (state.type === 'submitting' || state.type === 'completed') return true
  if (state.type !== 'failure') return false
  return (
    state.failure.kind === 'unavailable' ||
    (state.failure.kind === 'uncertain' && operation !== 'recovery') ||
    state.failure.retryAt !== undefined
  )
}

/** One in-flight mutation per mounted workflow; no automatic replay. */
export function useAccountFlowSubmission(operation: AccountFlowOperation) {
  const [state, setState] = useState<SubmissionState>({ type: 'ready' })
  const current = useRef<SubmissionState>({ type: 'ready' })
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const retryAt = state.type === 'failure' ? state.failure.retryAt : undefined
  useEffect(() => {
    if (retryAt === undefined) return
    const deadline = retryAt
    let timer: ReturnType<typeof setTimeout>
    function releaseWhenDue() {
      const remaining = deadline - Date.now()
      if (remaining > 0) {
        timer = setTimeout(releaseWhenDue, Math.min(remaining, 2_147_483_647))
        return
      }
      const previous = current.current
      if (previous.type === 'failure' && previous.failure.retryAt === retryAt) {
        const next: SubmissionState = {
          type: 'failure',
          failure: { ...previous.failure, retryAt: undefined },
        }
        current.current = next
        setState(next)
      }
    }
    timer = setTimeout(releaseWhenDue, 0)
    return () => clearTimeout(timer)
  }, [retryAt])

  function transition(next: SubmissionState) {
    current.current = next
    setState(next)
  }

  async function run(
    action: () => Promise<void>
  ): Promise<'completed' | AccountFlowFailure | null> {
    if (!mounted.current || isBlocked(current.current, operation)) return null
    transition({ type: 'submitting' })
    try {
      await action()
      if (!mounted.current) return null
      transition({ type: 'completed' })
      return 'completed'
    } catch (error) {
      if (!mounted.current) return null
      const failure = classifyAccountFlowFailure(error, operation)
      transition({ type: 'failure', failure })
      return failure
    }
  }

  function reset() {
    if (current.current.type === 'completed') transition({ type: 'ready' })
  }

  return {
    state,
    pending: state.type === 'submitting',
    blocked: isBlocked(state, operation),
    failure: state.type === 'failure' ? state.failure : null,
    run,
    reset,
  }
}
