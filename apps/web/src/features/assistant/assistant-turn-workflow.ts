import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CoreApiError, normalizeCoreApiError } from '@/lib/core-api'
import {
  beginAssistantQuestion,
  captureAssistantAccess,
  containAssistantAccessFailure,
  invalidateAssistantHistory,
  isAssistantAccessCurrent,
  readAssistantProtected,
  revalidateAssistantHistory,
  subscribeAssistantAccess,
  type AssistantAccessToken,
} from './assistant-access'
import {
  fetchAssistantTurnStatus,
  lookupAssistantTurn,
  recoverAssistantTurn,
  submitAssistantQuestion,
  type AssistantConversationDetail,
  type AssistantTurn,
  type AssistantTurnStatus,
} from './assistant-api'
import { canRetryAssistantSubmission } from './assistant-error-policy'
import type { Submission } from './assistant-types'

type Operation = { access: AssistantAccessToken }
type Intent = Operation & {
  phase: 'submitting' | 'lookup' | 'uncertain'
  submission: Submission
  error?: unknown
  retryAt?: number
}
type KnownTurn = Operation & {
  phase: 'observing' | 'paused' | 'recoverable' | 'recovering'
  turnId: string
  error?: unknown
  retryAt?: number
}
type Settled = Operation & {
  phase: 'settled'
  turnId?: string
  error?: unknown
}
export type TurnWorkflow = Intent | KnownTurn | Settled

export function retryAt(error: unknown, now = Date.now()): number {
  const value = normalizeCoreApiError(error).retryAfter
  if (!value) return now
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(now, date) : now
}

const observationBudget = 60_000
const statusKey = (id: string, turnId: string) =>
  ['assistant', 'turn', id, 'status', turnId] as const

function terminalError(state: AssistantTurn['state']) {
  if (state === 'FAILED')
    return new CoreApiError({ status: 503, code: 'ASSISTANT_TURN_FAILED', kind: 'server', message: 'Core confirmed that this turn failed.' })
  if (state === 'STALE_SOURCE')
    return new CoreApiError({ status: 409, code: 'ASSISTANT_SOURCE_STALE', kind: 'http', message: 'Assistant evidence is no longer current.' })
  return undefined
}

// Operation identities survive conversation switches, but never leave the
// authenticated feature's memory. Canonical history stays in TanStack Query.
export function useAssistantTurnWorkflow(
  detail: AssistantConversationDetail | undefined,
  historyReady: boolean,
  selectedId?: string
) {
  const client = useQueryClient()
  const records = useRef(new Map<string, TurnWorkflow>())
  const [workflows, setWorkflows] = useState<ReadonlyMap<string, TurnWorkflow>>(new Map())
  const [refreshErrors, setRefreshErrors] = useState<ReadonlyMap<string, unknown>>(new Map())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const conversation = historyReady ? detail?.conversation : undefined
  const id = selectedId
  const pending = historyReady ? detail?.pendingTurn : undefined

  const write = useCallback((key: string, next: TurnWorkflow) => {
    if (!mounted.current) return
    records.current.set(key, next)
    setWorkflows(new Map(records.current))
  }, [])
  const owns = useCallback((key: string, operation: TurnWorkflow) =>
    mounted.current &&
    records.current.get(key) === operation &&
    isAssistantAccessCurrent(client, operation.access), [client])

  // Subscribe to the existing containment boundary. Remove retained intent
  // immediately on denial, not on an unrelated React rendering pass.
  useEffect(() => subscribeAssistantAccess(client, () => {
    const removed: string[] = []
    for (const [key, value] of records.current) {
      if (!isAssistantAccessCurrent(client, value.access)) {
        records.current.delete(key)
        removed.push(key)
      }
    }
    if (removed.length) {
      setWorkflows(new Map(records.current))
      setRefreshErrors((previous) => {
        const next = new Map(previous)
        for (const key of removed) next.delete(key)
        return next
      })
    }
  }), [client])

  const refresh = useCallback(async (key: string, operation: TurnWorkflow, reset = false) => {
    if (!owns(key, operation)) return
    setRefreshErrors((previous) => {
      const next = new Map(previous)
      next.delete(key)
      return next
    })
    try {
      if (reset) {
        await revalidateAssistantHistory(client, key)
      } else {
        // Infinite-query refetch recomputes every loaded continuation from
        // the newest page. Never merge a fresh head onto old offset pages.
        await client.refetchQueries(
          { queryKey: ['assistant', 'conversation', key, 'history'], type: 'active' },
          { throwOnError: true }
        )
        await client.invalidateQueries({
          queryKey: ['assistant', 'conversation', key, 'history'],
          refetchType: 'none',
        })
      }
    } catch (error) {
      if (owns(key, operation)) setRefreshErrors((previous) => new Map(previous).set(key, error))
    }
  }, [client, owns])

  const adopt = useCallback((key: string, operation: TurnWorkflow, turn: AssistantTurnStatus | AssistantTurn) => {
    if (!owns(key, operation)) return
    if (turn.state === 'PROCESSING') {
      const expired = 'leaseStatus' in turn && turn.leaseStatus === 'EXPIRED'
      write(key, { phase: expired ? 'recoverable' : 'observing', access: operation.access, turnId: turn.turnId })
      return
    }
    const next: Settled = { phase: 'settled', access: operation.access, turnId: turn.turnId, error: terminalError(turn.state) }
    write(key, next)
    void refresh(key, next, turn.state === 'STALE_SOURCE')
  }, [owns, refresh, write])

  useEffect(() => {
    if (!id || !detail) return
    const previous = records.current.get(id)
    if (previous && isAssistantAccessCurrent(client, previous.access)) {
      if (previous.phase === 'recoverable' || previous.phase === 'paused') {
        // A fresh authorized detail can resume observation of the exact
        // durable turn. Never infer completion from history.
        if (!pending || pending.turnId === previous.turnId) {
          if (Date.now() < (previous.retryAt ?? 0)) return
          const phase = pending?.leaseStatus === 'EXPIRED' ? 'recoverable' : 'observing'
          if (previous.phase !== phase) write(id, { ...previous, phase, error: undefined })
          return
        }
      }
      if (previous.phase !== 'settled' || previous.turnId === pending?.turnId) return
    }
    if (!pending || pending.conversationId !== id) return
    write(id, {
      phase: pending.leaseStatus === 'EXPIRED' ? 'recoverable' : 'observing',
      access: captureAssistantAccess(client, id),
      turnId: pending.turnId,
    })
  }, [client, id, detail, pending, write])

  const lookup = useCallback(async (key: string, operation: Intent) => {
    if (!owns(key, operation)) return
    const next: Intent = { ...operation, phase: 'lookup' }
    write(key, next)
    try {
      const turn = await readAssistantProtected(client, key, () =>
        lookupAssistantTurn(key, operation.submission.idempotencyKey)
      )
      if (normalizeCoreApiError(operation.error).code === 'ASSISTANT_IDEMPOTENCY_CONFLICT') {
        // The lookup identifies the conflicting durable operation, not proof
        // that this question was accepted. Keep the conflict visible.
        if (turn.state === 'PROCESSING') {
          write(key, { phase: turn.leaseStatus === 'EXPIRED' ? 'recoverable' : 'observing', access: next.access, turnId: turn.turnId, error: operation.error })
        } else {
          const settled: Settled = { phase: 'settled', access: next.access, turnId: turn.turnId, error: operation.error }
          write(key, settled)
          void refresh(key, settled, true)
        }
      } else adopt(key, next, turn)
    } catch (error) {
      if (!owns(key, next)) return
      // Absence is not proof of rejection; preserve the original intent.
      const failure = normalizeCoreApiError(error)
      write(key, {
        ...next,
        phase: 'uncertain',
        error: failure.code === 'ASSISTANT_TURN_NOT_FOUND' ? operation.error : error,
        retryAt: Math.max(operation.retryAt ?? 0, failure.retryAfter ? retryAt(error) : 0) || undefined,
      })
    }
  }, [adopt, client, owns, refresh, write])

  const submit = useCallback(async (submission: Submission, previous?: Intent) => {
    const key = submission.conversationId
    if (previous && (!owns(key, previous) || Date.now() < (previous.retryAt ?? 0))) return
    const current = records.current.get(key)
    if (!previous && current && isAssistantAccessCurrent(client, current.access) && current.phase !== 'settled') return
    const operation: Intent = {
      phase: 'submitting',
      access: beginAssistantQuestion(client, key),
      submission,
    }
    write(key, operation)
    try {
      const turn = await submitAssistantQuestion(key, submission.question, submission.idempotencyKey)
      if (!owns(key, operation)) return
      if (turn.citations.some((citation) => citation.meetingId !== submission.meetingId)) {
        throw new CoreApiError({ kind: 'malformed', code: 'MALFORMED_RESPONSE', message: 'Core returned evidence for another meeting.' })
      }
      adopt(key, operation, turn)
    } catch (error) {
      if (containAssistantAccessFailure(client, operation.access, error) || !owns(key, operation)) return
      const failure = normalizeCoreApiError(error)
      if (canRetryAssistantSubmission(error) || failure.code === 'ASSISTANT_IDEMPOTENCY_CONFLICT') {
        const next: Intent = { ...operation, phase: 'uncertain', error, retryAt: failure.retryAfter ? retryAt(error) : undefined }
        write(key, next)
        if (failure.status !== 429) void lookup(key, next)
        return
      }
      const next: Settled = { phase: 'settled', access: operation.access, error }
      write(key, next)
      if (failure.code === 'ASSISTANT_SOURCE_STALE') invalidateAssistantHistory(client, key)
      else if (failure.code === 'ASSISTANT_TURN_IN_PROGRESS' || failure.code === 'ASSISTANT_TURN_FAILED' || failure.code === 'ASSISTANT_CONVERSATION_INACTIVE') void refresh(key, next, true)
    }
  }, [adopt, client, lookup, owns, refresh, write])

  const workflow = id ? workflows.get(id) : undefined
  const active = workflow && isAssistantAccessCurrent(client, workflow.access) ? workflow : undefined
  const observing = active?.phase === 'observing' ? active : undefined

  useEffect(() => {
    if (!id || !observing) return
    const operation = observing
    const deadline = Date.now() + observationBudget
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let interval = 1000
    const key = statusKey(id, operation.turnId)
    const pause = (error?: unknown) => {
      if (!cancelled && owns(id, operation))
        write(id, { ...operation, phase: 'paused', error, retryAt: error && normalizeCoreApiError(error).retryAfter ? retryAt(error) : undefined })
    }
    const budgetTimer = setTimeout(() => {
      pause()
      void client.cancelQueries({ queryKey: key, exact: true })
    }, observationBudget)

    const schedule = (delay: number) => {
      if (Date.now() + delay >= deadline) return
      timer = setTimeout(() => void poll(), delay)
    }
    const poll = async () => {
      if (cancelled || !owns(id, operation) || Date.now() >= deadline) return
      try {
        const status = await client.fetchQuery({
          queryKey: key,
          queryFn: ({ signal, client: queryClient }) => readAssistantProtected(queryClient, id, () =>
            fetchAssistantTurnStatus(id, operation.turnId, signal)
          ),
          staleTime: 0,
          retry: false,
        })
        if (cancelled || !owns(id, operation)) return
        if (status.state !== 'PROCESSING' || status.leaseStatus === 'EXPIRED') {
          adopt(id, operation, status)
          return
        }
        interval = Math.min(interval * 2, 5000)
        schedule(interval)
      } catch (error) {
        if (cancelled || !owns(id, operation)) return
        const failure = normalizeCoreApiError(error)
        if (failure.status === 429 || failure.isNetworkError || failure.isServerError) {
          interval = Math.min(interval * 2, 5000)
          const delay = Math.max(interval, retryAt(error) - Date.now())
          if (Date.now() + delay >= deadline) pause(error)
          else schedule(delay)
        } else pause(error)
      }
    }
    schedule(interval)
    return () => {
      cancelled = true
      clearTimeout(timer)
      clearTimeout(budgetTimer)
      void client.cancelQueries({ queryKey: key, exact: true })
    }
  }, [adopt, client, id, observing, owns, write])

  const recover = async () => {
    if (!historyReady || !id || !active || active.phase !== 'recoverable' || !owns(id, active)) return
    if (Date.now() < (active.retryAt ?? 0)) return
    const operation: KnownTurn = { ...active, phase: 'recovering', access: beginAssistantQuestion(client, id) }
    write(id, operation)
    try {
      const turn = await recoverAssistantTurn(id, operation.turnId)
      if (!owns(id, operation)) return
      if (turn.citations.some((citation) => citation.meetingId !== conversation?.meetingId)) {
        throw new CoreApiError({ kind: 'malformed', code: 'MALFORMED_RESPONSE', message: 'Core returned evidence for another meeting.' })
      }
      adopt(id, operation, turn)
    } catch (error) {
      if (containAssistantAccessFailure(client, operation.access, error) || !owns(id, operation)) return
      const failure = normalizeCoreApiError(error)
      if (failure.code === 'ASSISTANT_TURN_FAILED' || failure.code === 'ASSISTANT_SOURCE_STALE' || failure.code === 'ASSISTANT_CONVERSATION_INACTIVE') {
        const next: Settled = { phase: 'settled', access: operation.access, turnId: operation.turnId, error }
        write(id, next)
        void refresh(id, next, true)
      } else {
        // Recovery may have been admitted; observe the same durable turn.
        write(id, { ...operation, phase: 'paused', error, retryAt: failure.retryAfter ? retryAt(error) : undefined })
      }
    }
  }

  const resume = () => {
    if (!id || !active || !owns(id, active)) return
    if ('retryAt' in active && Date.now() < (active.retryAt ?? 0)) return
    if (active.phase === 'paused') write(id, { ...active, phase: 'observing', error: undefined })
    if (active.phase === 'uncertain') void lookup(id, active)
  }

  return {
    workflow: active,
    busy: Boolean((active && active.phase !== 'settled') || (!active && pending)),
    historyRefreshError: id ? refreshErrors.get(id) : undefined,
    submit,
    recover: () => void recover(),
    resume,
    retry: () => {
      if (active?.phase === 'uncertain' && canRetryAssistantSubmission(active.error))
        void submit(active.submission, active)
    },
  }
}
