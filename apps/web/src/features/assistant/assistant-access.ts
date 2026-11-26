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
  questionEpochs: Map<string, number>
  historyEpochs: Map<string, number>
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
      questionEpochs: new Map(),
      historyEpochs: new Map(),
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
    state.questionEpochs.clear()
    state.historyEpochs.clear()
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

export function useAssistantAccessRevision(client: QueryClient): number {
  const subscribe = useCallback(
    (listener: () => void) => {
      const state = stateFor(client)
      state.listeners.add(listener)
      return () => {
        state.listeners.delete(listener)
      }
    },
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

export function beginAssistantQuestion(
  client: QueryClient,
  conversationId: string
): AssistantAccessToken {
  const state = stateFor(client)
  const questionEpoch = (state.questionEpochs.get(conversationId) ?? 0) + 1
  state.questionEpochs.set(conversationId, questionEpoch)
  return { ...captureAssistantAccess(client, conversationId), questionEpoch }
}

function matchesEpoch(client: QueryClient, token: AssistantAccessToken): boolean {
  const current = captureAssistantAccess(client, token.conversationId)
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
      failure.code !== 'ASSISTANT_HISTORY_ANCHOR_NOT_FOUND')
  )
}

const listKey = ['assistant', 'conversations'] as const

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
  if (failure.status === 401 || !id) {
    state.epoch += 1
    state.listEpoch += 1
    state.denied.clear()
    state.listError = failure
    notify(state)
    void client.cancelQueries({ queryKey: ['assistant'] })
    client.removeQueries({ queryKey: ['assistant'] })
  } else {
    state.resourceEpochs.set(id, token.resourceEpoch + 1)
    state.listEpoch += 1
    state.denied.set(id, failure)
    notify(state)
    const resourceKeys = [
      ['assistant', 'conversation', id],
      ['assistant', 'turn', id],
    ]
    for (const queryKey of resourceKeys) {
      void client.cancelQueries({ queryKey })
      client.removeQueries({ queryKey })
    }
    void client.cancelQueries({ queryKey: listKey })
    client.setQueriesData<
      AssistantConversation[] | InfiniteData<AssistantConversation[]>
    >({ queryKey: listKey }, (cached) => {
      if (!cached) return cached
      const withoutDenied = (items: AssistantConversation[]) =>
        items.filter((conversation) => conversation.id !== id)
      return Array.isArray(cached)
        ? withoutDenied(cached)
        : { ...cached, pages: cached.pages.map(withoutDenied) }
    })
    void client.invalidateQueries({ queryKey: listKey })
  }
  return true
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

function historyEpoch(client: QueryClient, conversationId: string): number {
  return stateFor(client).historyEpochs.get(conversationId) ?? 0
}

function advanceHistoryEpoch(client: QueryClient, conversationId: string) {
  stateFor(client).historyEpochs.set(
    conversationId,
    historyEpoch(client, conversationId) + 1
  )
}

function replaceRedactions(
  detail: AssistantConversationDetail,
  redactions: Map<string, AssistantMessage>
): AssistantConversationDetail {
  return {
    ...detail,
    messages: detail.messages.map(
      (message) => redactions.get(message.id) ?? message
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
  const epoch = historyEpoch(client, conversationId)
  const detail = await readAssistantProtected(client, conversationId, read)
  if (epoch !== historyEpoch(client, conversationId)) {
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
  if (redactions.size > 0) {
    advanceHistoryEpoch(client, conversationId)
    client.setQueriesData<AssistantConversationDetail>(
      { queryKey: ['assistant', 'conversation', conversationId, 'page'] },
      (cached) => cached && replaceRedactions(cached, redactions)
    )
    client.setQueriesData<InfiniteData<AssistantConversationDetail>>(
      { queryKey: ['assistant', 'conversation', conversationId, 'history'] },
      (cached) =>
        cached && {
          ...cached,
          pages: cached.pages.map((page) => replaceRedactions(page, redactions)),
        }
    )
  }
  return detail
}

// A stale-source outcome does not identify every affected cached message.
// Discard the conversation's cached history and revalidate through Core.
export function invalidateAssistantHistory(
  client: QueryClient,
  conversationId: string
): void {
  advanceHistoryEpoch(client, conversationId)
  const pageKey = ['assistant', 'conversation', conversationId, 'page']
  const historyKey = ['assistant', 'conversation', conversationId, 'history']
  void client.cancelQueries({ queryKey: pageKey })
  client.removeQueries({ queryKey: pageKey })
  void client.cancelQueries({ queryKey: historyKey })
  void client.resetQueries({ queryKey: historyKey })
}
