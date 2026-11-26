import { useCallback, useSyncExternalStore } from 'react'
import { type InfiniteData, type QueryClient } from '@tanstack/react-query'
import { CoreApiError, normalizeCoreApiError } from '@/lib/core-api'
import {
  getRequestRecoveryGeneration,
  isRequestRecoveryBlocked,
  isSessionLossConfirmed,
} from '@/lib/request-recovery'
import type {
  AssistantConversation,
  AssistantConversationDetail,
  AssistantMessage,
} from './assistant-api'

type AccessState = {
  session: number
  epoch: number
  listEpoch: number
  resourceEpochs: Map<string, number>
  meetingEpochs: Map<string, number>
  conversationMeetings: Map<string, string>
  meetingDenials: Map<string, { listEpoch: number; error: CoreApiError }>
  historyResetEpochs: Map<string, number>
  questionEpochs: Map<string, number>
  historyEpochs: Map<string, number>
  redactedIds: Map<string, Set<string>>
  denied: Map<string, CoreApiError>
  listError?: CoreApiError
  revision: number
  listeners: Set<() => void>
}

// Coordination only: no conversations, questions or answers are retained here.
const states = new WeakMap<QueryClient, AccessState>()

function stateFor(client: QueryClient): AccessState {
  let state = states.get(client)
  const session = getRequestRecoveryGeneration()
  if (!state) {
    state = {
      session,
      epoch: 0,
      listEpoch: 0,
      resourceEpochs: new Map(),
      meetingEpochs: new Map(),
      conversationMeetings: new Map(),
      meetingDenials: new Map(),
      historyResetEpochs: new Map(),
      questionEpochs: new Map(),
      historyEpochs: new Map(),
      redactedIds: new Map(),
      denied: new Map(),
      revision: 0,
      listeners: new Set(),
    }
    states.set(client, state)
  } else if (state.session !== session) {
    state.session = session
    state.epoch += 1
    state.listEpoch += 1
    state.resourceEpochs.clear()
    state.meetingEpochs.clear()
    state.conversationMeetings.clear()
    state.meetingDenials.clear()
    state.historyResetEpochs.clear()
    state.questionEpochs.clear()
    state.historyEpochs.clear()
    state.redactedIds.clear()
    state.denied.clear()
    state.listError = undefined
    state.revision += 1
  }
  return state
}

function notify(state: AccessState) {
  state.revision += 1
  for (const listener of state.listeners) listener()
}

export function subscribeAssistantAccess(
  client: QueryClient,
  listener: () => void
): () => void {
  const state = stateFor(client)
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
  }
}

export function useAssistantAccessRevision(client: QueryClient): number {
  const subscribe = useCallback(
    (listener: () => void) => subscribeAssistantAccess(client, listener),
    [client]
  )
  const snapshot = useCallback(() => stateFor(client).revision, [client])
  return useSyncExternalStore(subscribe, snapshot)
}

const sessionError = new CoreApiError({
  status: 401,
  code: 'AUTH_REQUIRED',
  kind: 'http',
  message: 'The authenticated session is no longer available.',
})

export function assistantAccessError(
  client: QueryClient,
  conversationId?: string
): CoreApiError | undefined {
  if (isRequestRecoveryBlocked() || isSessionLossConfirmed()) {
    return sessionError
  }
  const state = stateFor(client)
  return (
    state.listError ??
    (conversationId ? state.denied.get(conversationId) : undefined)
  )
}

export type AssistantAccessToken = {
  session: number
  epoch: number
  resourceEpoch: number
  conversationId?: string
  meetingId?: string
  questionEpoch?: number
}

export function captureAssistantAccess(
  client: QueryClient,
  conversationId?: string
): AssistantAccessToken {
  const state = stateFor(client)
  return {
    session: state.session,
    epoch: state.epoch,
    resourceEpoch: conversationId
      ? (state.resourceEpochs.get(conversationId) ?? 0)
      : state.listEpoch,
    conversationId,
  }
}

// Creation is scoped to a meeting, not to the conversation-list resource.
export function captureAssistantCreationAccess(
  client: QueryClient,
  meetingId: string
): AssistantAccessToken {
  return {
    ...captureAssistantAccess(client),
    meetingId,
    resourceEpoch: stateFor(client).meetingEpochs.get(meetingId) ?? 0,
  }
}

export function beginAssistantQuestion(
  client: QueryClient,
  conversationId: string
): AssistantAccessToken {
  const state = stateFor(client)
  const questionEpoch = (state.questionEpochs.get(conversationId) ?? 0) + 1
  state.questionEpochs.set(conversationId, questionEpoch)
  return { ...captureAssistantAccess(client, conversationId), questionEpoch }
}

function matchesEpoch(
  client: QueryClient,
  token: AssistantAccessToken
): boolean {
  const current = token.meetingId
    ? captureAssistantCreationAccess(client, token.meetingId)
    : captureAssistantAccess(client, token.conversationId)
  return (
    current.session === token.session &&
    current.epoch === token.epoch &&
    current.resourceEpoch === token.resourceEpoch &&
    (token.questionEpoch === undefined ||
      (token.conversationId !== undefined &&
        stateFor(client).questionEpochs.get(token.conversationId) ===
          token.questionEpoch))
  )
}

export function isAssistantAccessCurrent(
  client: QueryClient,
  token: AssistantAccessToken
): boolean {
  return (
    matchesEpoch(client, token) &&
    !assistantAccessError(client, token.conversationId)
  )
}

export function assertAssistantAccessCurrent(
  client: QueryClient,
  token: AssistantAccessToken
): void {
  if (!isAssistantAccessCurrent(client, token)) {
    throw new CoreApiError({
      kind: 'http',
      code: 'ASSISTANT_OPERATION_OBSOLETE',
      message: 'This Assistant operation is no longer current.',
    })
  }
}

export function isAssistantAuthorizationDenial(error: unknown): boolean {
  const failure = normalizeCoreApiError(error)
  return (
    failure.status === 401 ||
    failure.status === 403 ||
    (failure.status === 404 &&
      failure.code !== 'ASSISTANT_TURN_NOT_FOUND' &&
      failure.code !== 'ASSISTANT_HISTORY_ANCHOR_NOT_FOUND' &&
      failure.code !== 'ASSISTANT_MESSAGE_NOT_FOUND')
  )
}

const listKey = ['assistant', 'conversations'] as const

function conversationsForMeeting(
  client: QueryClient,
  meetingId: string
): Set<string> {
  const ids = new Set<string>()
  for (const [id, meeting] of stateFor(client).conversationMeetings) {
    if (meeting === meetingId) ids.add(id)
  }
  const include = (conversation: AssistantConversation | undefined) => {
    if (conversation?.meetingId === meetingId) ids.add(conversation.id)
  }
  for (const [, cached] of client.getQueriesData<
    AssistantConversation[] | InfiniteData<AssistantConversation[]>
  >({ queryKey: listKey })) {
    if (Array.isArray(cached)) cached.forEach(include)
    else cached?.pages.flat().forEach(include)
  }
  for (const [key, cached] of client.getQueriesData<
    | AssistantConversation
    | AssistantConversationDetail
    | InfiniteData<AssistantConversationDetail>
  >({ queryKey: ['assistant', 'conversation'] })) {
    if (!cached) continue
    if (key[3] === 'summary' && 'meetingId' in cached) include(cached)
    if (key[3] === 'page' && 'conversation' in cached) {
      include(cached.conversation)
    }
    if (key[3] === 'history' && 'pages' in cached) {
      cached.pages.forEach((page) => include(page.conversation))
    }
  }
  return ids
}

function containConversationResources(
  client: QueryClient,
  state: AccessState,
  ids: Set<string>,
  failure: CoreApiError,
  meetingId?: string
): void {
  state.listEpoch += 1
  for (const id of ids) {
    state.resourceEpochs.set(id, (state.resourceEpochs.get(id) ?? 0) + 1)
    state.denied.set(id, failure)
  }
  notify(state)
  for (const id of ids) {
    for (const queryKey of [
      ['assistant', 'conversation', id],
      ['assistant', 'turn', id],
    ]) {
      void client.cancelQueries({ queryKey }, { revert: false })
      client.removeQueries({ queryKey })
    }
  }
  void client.cancelQueries({ queryKey: listKey }, { revert: false })
  client.setQueriesData<
    AssistantConversation[] | InfiniteData<AssistantConversation[]>
  >({ queryKey: listKey }, (cached) => {
    if (!cached) return cached
    const withoutDenied = (items: AssistantConversation[]) =>
      items.filter(
        (conversation) =>
          !ids.has(conversation.id) && conversation.meetingId !== meetingId
      )
    return Array.isArray(cached)
      ? withoutDenied(cached)
      : { ...cached, pages: cached.pages.map(withoutDenied) }
  })
  void client.invalidateQueries({ queryKey: listKey })
}

export function containAssistantAccessFailure(
  client: QueryClient,
  token: AssistantAccessToken,
  error: unknown
): boolean {
  if (!matchesEpoch(client, token) || !isAssistantAuthorizationDenial(error)) {
    return false
  }
  const failure = normalizeCoreApiError(error)
  const state = stateFor(client)
  const id = token.conversationId
  if (failure.status !== 401 && token.meetingId) {
    state.meetingEpochs.set(token.meetingId, token.resourceEpoch + 1)
    state.meetingDenials.set(token.meetingId, {
      listEpoch: state.listEpoch + 1,
      error: failure,
    })
    containConversationResources(
      client,
      state,
      conversationsForMeeting(client, token.meetingId),
      failure,
      token.meetingId
    )
  } else if (failure.status === 401 || !id) {
    state.epoch += 1
    state.listEpoch += 1
    state.denied.clear()
    state.listError = failure
    notify(state)
    void client.cancelQueries({ queryKey: ['assistant'] }, { revert: false })
    client.removeQueries({ queryKey: ['assistant'] })
  } else {
    containConversationResources(client, state, new Set([id]), failure)
  }
  return true
}

// A canonical meeting-detail denial has the same scope as a meeting-scoped
// Assistant denial, not a denial of the whole conversation collection.
export function containAssistantMeetingDenial(
  client: QueryClient,
  token: AssistantAccessToken,
  error: unknown
): void {
  const previous = token.meetingId
    ? stateFor(client).meetingDenials.get(token.meetingId)
    : undefined
  if (previous?.error === error) return
  containAssistantAccessFailure(client, token, error)
}

// Only an explicit user-initiated read can release a containment boundary.
export function retryAssistantAccess(
  client: QueryClient,
  conversationId?: string
): void {
  const state = stateFor(client)
  if (!conversationId) {
    if (!state.listError) return
    state.epoch += 1
    state.listError = undefined
  } else {
    if (!state.denied.delete(conversationId)) return
    state.resourceEpochs.set(
      conversationId,
      (state.resourceEpochs.get(conversationId) ?? 0) + 1
    )
  }
  notify(state)
}

export async function readAssistantProtected<T>(
  client: QueryClient,
  conversationId: string | undefined,
  read: () => Promise<T>
): Promise<T> {
  const token = captureAssistantAccess(client, conversationId)
  assertAssistantAccessCurrent(client, token)
  try {
    const result = await read()
    assertAssistantAccessCurrent(client, token)
    return result
  } catch (error) {
    containAssistantAccessFailure(client, token, error)
    throw error
  }
}

export function assistantHistoryEpoch(
  client: QueryClient,
  conversationId: string
): number {
  return stateFor(client).historyEpochs.get(conversationId) ?? 0
}

function advanceHistoryEpoch(client: QueryClient, conversationId: string) {
  stateFor(client).historyEpochs.set(
    conversationId,
    assistantHistoryEpoch(client, conversationId) + 1
  )
}

// A read's ownership follows the exact returned projection through the
// asynchronous cache-write boundary, without retaining any history bodies.
const historyResults = new WeakMap<
  AssistantConversationDetail,
  {
    client: QueryClient
    access: AssistantAccessToken
    epoch: number
    resetEpoch: number
  }
>()

function stampHistoryResult(
  client: QueryClient,
  conversationId: string,
  detail: AssistantConversationDetail
): AssistantConversationDetail {
  historyResults.set(detail, {
    client,
    access: captureAssistantAccess(client, conversationId),
    epoch: assistantHistoryEpoch(client, conversationId),
    resetEpoch: stateFor(client).historyResetEpochs.get(conversationId) ?? 0,
  })
  return detail
}

export function assertAssistantHistoryResultCurrent(
  client: QueryClient,
  conversationId: string,
  detail: AssistantConversationDetail
): void {
  const stamp = historyResults.get(detail)
  if (
    !stamp ||
    stamp.client !== client ||
    stamp.access.conversationId !== conversationId ||
    !isAssistantAccessCurrent(client, stamp.access) ||
    stamp.epoch !== assistantHistoryEpoch(client, conversationId)
  ) {
    throw new CoreApiError({
      code: 'ASSISTANT_OPERATION_OBSOLETE',
      kind: 'http',
      message: 'Assistant history changed before the result was applied.',
    })
  }
}

// TanStack may apply a query result after the read itself has returned.
// Do not allow structural sharing to replace its ownership identity.
export function guardAssistantHistoryCache(
  _previous: unknown,
  next: unknown
): unknown {
  if (next && typeof next === 'object') {
    if ('pages' in next && Array.isArray(next.pages)) {
      // A sequential infinite refetch can learn a redaction on a later page.
      // Earlier pages from that same reset generation may be safely sanitized
      // with the accumulated redactions, but never across an access/reset fence.
      const pages = next.pages.map((page: AssistantConversationDetail) => {
        const stamp = historyResults.get(page)
        const id = stamp?.access.conversationId
        if (!stamp || !id) return page
        const state = stateFor(stamp.client)
        if (
          isAssistantAccessCurrent(stamp.client, stamp.access) &&
          stamp.resetEpoch === (state.historyResetEpochs.get(id) ?? 0) &&
          stamp.epoch !== assistantHistoryEpoch(stamp.client, id)
        ) {
          return stampHistoryResult(
            stamp.client,
            id,
            redactKnownMessages(
              page,
              state.redactedIds.get(id) ?? new Set(),
              new Map()
            )
          )
        }
        assertAssistantHistoryResultCurrent(stamp.client, id, page)
        return page
      })
      return { ...next, pages }
    }
    const page = next as AssistantConversationDetail
    const stamp = historyResults.get(page)
    if (stamp?.access.conversationId)
      assertAssistantHistoryResultCurrent(
        stamp.client,
        stamp.access.conversationId,
        page
      )
  }
  return next
}

function redactKnownMessages(
  detail: AssistantConversationDetail,
  redactedIds: Set<string>,
  redactions: Map<string, AssistantMessage>
): AssistantConversationDetail {
  return {
    ...detail,
    messages: detail.messages.map(
      (message) =>
        redactions.get(message.id) ??
        (redactedIds.has(message.id)
          ? {
              ...message,
              visibility: 'SOURCE_UNAVAILABLE',
              content: null,
              claims: [],
              citations: [],
            }
          : message)
    ),
  }
}

// Protect every cached representation, not just the currently rendered page.
// A concurrent read started before a newly observed redaction is obsolete.
export async function readAssistantHistoryProtected(
  client: QueryClient,
  conversationId: string,
  read: () => Promise<AssistantConversationDetail>
): Promise<AssistantConversationDetail> {
  const token = captureAssistantAccess(client, conversationId)
  const epoch = assistantHistoryEpoch(client, conversationId)
  const listEpoch = stateFor(client).listEpoch
  const detail = await readAssistantProtected(client, conversationId, read)
  assertAssistantAccessCurrent(client, token)
  const accessState = stateFor(client)
  const meetingId = detail.conversation.meetingId
  accessState.conversationMeetings.set(conversationId, meetingId)
  const denial = accessState.meetingDenials.get(meetingId)
  if (denial && denial.listEpoch > listEpoch) {
    containAssistantAccessFailure(client, token, denial.error)
    throw denial.error
  }
  if (epoch !== assistantHistoryEpoch(client, conversationId)) {
    throw new CoreApiError({
      code: 'ASSISTANT_OPERATION_OBSOLETE',
      kind: 'http',
      message: 'Assistant history changed during this read.',
    })
  }

  const redactions = new Map(
    detail.messages
      .filter((message) => message.visibility === 'SOURCE_UNAVAILABLE')
      .map((message) => [message.id, message] as const)
  )
  const state = stateFor(client)
  const redactedIds = state.redactedIds.get(conversationId) ?? new Set<string>()
  const changed = [...redactions.keys()].some((id) => !redactedIds.has(id))
  for (const id of redactions.keys()) redactedIds.add(id)
  state.redactedIds.set(conversationId, redactedIds)
  if (changed) {
    advanceHistoryEpoch(client, conversationId)
    const redact = (cached: AssistantConversationDetail) =>
      stampHistoryResult(
        client,
        conversationId,
        redactKnownMessages(cached, redactedIds, redactions)
      )
    client.setQueriesData<AssistantConversationDetail>(
      { queryKey: ['assistant', 'conversation', conversationId, 'page'] },
      (cached) => cached && redact(cached)
    )
    client.setQueriesData<InfiniteData<AssistantConversationDetail>>(
      { queryKey: ['assistant', 'conversation', conversationId, 'history'] },
      (cached) =>
        cached && {
          ...cached,
          pages: cached.pages.map(redact),
        }
    )
  }
  // Redaction is monotonic within a history generation. Reopening the
  // conversation discards that generation and performs fresh authorized reads.
  return stampHistoryResult(
    client,
    conversationId,
    redactedIds.size
      ? redactKnownMessages(detail, redactedIds, redactions)
      : { ...detail }
  )
}

// A stale-source outcome does not identify every affected cached message.
// Discard the conversation's cached history and revalidate through Core.
function resetAssistantHistory(
  client: QueryClient,
  conversationId: string,
  throwOnError: boolean
): Promise<void> {
  advanceHistoryEpoch(client, conversationId)
  const state = stateFor(client)
  state.historyResetEpochs.set(
    conversationId,
    (state.historyResetEpochs.get(conversationId) ?? 0) + 1
  )
  state.redactedIds.delete(conversationId)
  const pageKey = ['assistant', 'conversation', conversationId, 'page']
  const historyKey = ['assistant', 'conversation', conversationId, 'history']
  void client.cancelQueries({ queryKey: pageKey }, { revert: false })
  client.removeQueries({ queryKey: pageKey })
  void client.cancelQueries({ queryKey: historyKey }, { revert: false })
  return client.resetQueries({ queryKey: historyKey }, { throwOnError })
}

export function invalidateAssistantHistory(
  client: QueryClient,
  conversationId: string
): void {
  void resetAssistantHistory(client, conversationId, false)
}

// Explicit refresh is a fresh authorization boundary, not an overlay on
// unverified older pages. An unsuccessful read leaves no old history to merge.
export function revalidateAssistantHistory(
  client: QueryClient,
  conversationId: string
): Promise<void> {
  return resetAssistantHistory(client, conversationId, true)
}
