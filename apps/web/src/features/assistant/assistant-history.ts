import { useCallback, useEffect } from 'react'
import { type InfiniteData, useQueryClient } from '@tanstack/react-query'
import {
  assertAssistantAccessCurrent,
  assertAssistantHistoryResultCurrent,
  assistantHistoryEpoch,
  captureAssistantAccess,
} from './assistant-access'
import {
  assistantConversationDetailQueryOptions,
  assistantConversationHistoryQueryOptions,
  findAssistantTurnMessage,
  type AssistantConversation,
  type AssistantConversationDetail,
  type AssistantMessage,
} from './assistant-api'
import type { AssistantUiScope, ProcessingTurn } from './assistant-types'

const POLL_INTERVAL_MS = 750
const MAX_POLL_ATTEMPTS = 40
const MAX_TURN_HISTORY_PAGES = 10

export function uniqueConversations(
  pages: AssistantConversation[][]
): AssistantConversation[] {
  const seen = new Set<string>()
  return pages.flat().filter((conversation) => {
    if (seen.has(conversation.id)) return false
    seen.add(conversation.id)
    return true
  })
}

export function chronologicalHistoryMessages(
  pages: AssistantConversationDetail[]
): AssistantMessage[] {
  const newestCopyById = new Map<string, AssistantMessage>()
  for (const page of pages) {
    for (const message of page.messages) {
      if (
        !newestCopyById.has(message.id) ||
        message.visibility === 'SOURCE_UNAVAILABLE'
      ) {
        newestCopyById.set(message.id, message)
      }
    }
  }

  const seen = new Set<string>()
  return [...pages].reverse().flatMap((page) =>
    page.messages.flatMap((message) => {
      if (seen.has(message.id)) return []
      seen.add(message.id)
      return [newestCopyById.get(message.id) ?? message]
    })
  )
}

export function useAssistantHistory() {
  const queryClient = useQueryClient()

  const cacheHistoryPages = useCallback(
    (
      currentConversationId: string,
      incomingPages: AssistantConversationDetail[]
    ) => {
      for (const detail of incomingPages) {
        assertAssistantHistoryResultCurrent(
          queryClient,
          currentConversationId,
          detail
        )
      }
      const historyOptions = assistantConversationHistoryQueryOptions(
        currentConversationId
      )
      queryClient.setQueryData<
        InfiniteData<AssistantConversationDetail, number>
      >(historyOptions.queryKey, (cached) => {
        const byPage = new Map<number, AssistantConversationDetail>(
          (cached?.pages ?? []).map((detail) => [detail.page, detail])
        )
        for (const detail of incomingPages) byPage.set(detail.page, detail)
        const pages = [...byPage.values()].sort(
          (left, right) => left.page - right.page
        )
        const fresh = new Map(
          incomingPages.flatMap((detail) =>
            detail.messages.map((message) => [message.id, message] as const)
          )
        )
        // Once a cached copy is redacted, a separately observed older copy
        // must not restore it. A complete fresh history read can replace it.
        for (const detail of cached?.pages ?? []) {
          for (const message of detail.messages) {
            if (message.visibility === 'SOURCE_UNAVAILABLE') {
              fresh.set(message.id, message)
            }
          }
        }
        const seenMessageIds = new Set<string>()
        const deduplicatedPages = pages.map((detail) => ({
          ...detail,
          messages: detail.messages
            .filter((message) => {
              if (seenMessageIds.has(message.id)) return false
              seenMessageIds.add(message.id)
              return true
            })
            .map((message) => fresh.get(message.id) ?? message),
        }))
        return {
          pages: deduplicatedPages,
          pageParams: deduplicatedPages.map((detail) => detail.page),
        }
      })
    },
    [queryClient]
  )

  const fetchNewestHistory = useCallback(
    async (currentConversationId: string) => {
      const access = captureAssistantAccess(queryClient, currentConversationId)
      const newest = await queryClient.fetchQuery({
        ...assistantConversationDetailQueryOptions(currentConversationId, 0),
        staleTime: 0,
      })
      assertAssistantAccessCurrent(queryClient, access)
      cacheHistoryPages(currentConversationId, [newest])
      return newest
    },
    [cacheHistoryPages, queryClient]
  )

  return { cacheHistoryPages, fetchNewestHistory }
}

// Existing bounded history observation is isolated here. The authoritative
// status/recovery workflow will replace this in the next development wave.
export function useAssistantHistoryPolling({
  processingTurn,
  pollingStopped,
  isCurrentScope,
  cacheHistoryPages,
  finishProcessingTurn,
  setPollingAttempts,
  setPollingError,
  setPollingStopped,
}: {
  processingTurn?: ProcessingTurn
  pollingStopped: boolean
  isCurrentScope: (scope: AssistantUiScope) => boolean
  cacheHistoryPages: ReturnType<typeof useAssistantHistory>['cacheHistoryPages']
  finishProcessingTurn: (turn: ProcessingTurn) => void
  setPollingAttempts: (attempts: number) => void
  setPollingError: (error: unknown) => void
  setPollingStopped: (stopped: boolean) => void
}) {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (
      !processingTurn ||
      !isCurrentScope(processingTurn.scope) ||
      pollingStopped
    ) {
      return
    }

    const accepted = processingTurn
    let cancelled = false
    let timer: number | undefined
    let attempts = 0
    const observedPages = new Map<number, AssistantConversationDetail>()
    let observedEpoch = assistantHistoryEpoch(
      queryClient,
      accepted.conversationId
    )

    const reconcileObservationEpoch = () => {
      const current = assistantHistoryEpoch(
        queryClient,
        accepted.conversationId
      )
      if (current !== observedEpoch) {
        observedPages.clear()
        observedEpoch = current
      }
    }

    const poll = async () => {
      if (cancelled || !isCurrentScope(accepted.scope)) return
      try {
        const newestOptions = assistantConversationDetailQueryOptions(
          accepted.conversationId,
          0
        )
        const newest = await queryClient.fetchQuery({
          ...newestOptions,
          staleTime: 0,
        })
        if (cancelled || !isCurrentScope(accepted.scope)) return
        reconcileObservationEpoch()
        cacheHistoryPages(accepted.conversationId, [newest])
        observedPages.set(0, newest)

        const cachedPages =
          queryClient.getQueryData<
            InfiniteData<AssistantConversationDetail, number>
          >(
            assistantConversationHistoryQueryOptions(accepted.conversationId)
              .queryKey
          )?.pages ?? []
        for (const detail of cachedPages) {
          if (detail.page > 0 && !observedPages.has(detail.page)) {
            observedPages.set(detail.page, detail)
          }
        }

        const matchingPage = [...observedPages.values()]
          .sort((left, right) => left.page - right.page)
          .find((detail) => findAssistantTurnMessage(detail, accepted.turn))
        if (matchingPage) {
          finishProcessingTurn(accepted)
          return
        }

        const targetIsKnown = [...observedPages.values()].some((detail) =>
          accepted.turn.assistantMessageId
            ? detail.messages.some(
                (message) => message.id === accepted.turn.assistantMessageId
              )
            : detail.messages.some(
                (message) => message.id === accepted.turn.userMessageId
              )
        )
        if (!targetIsKnown) {
          const scannedPageNumbers = [...observedPages.keys()]
          const lastPageNumber = Math.max(...scannedPageNumbers)
          const lastPage = observedPages.get(lastPageNumber)
          const nextPage = lastPageNumber + 1
          if (lastPage?.hasMore && nextPage <= MAX_TURN_HISTORY_PAGES) {
            const olderOptions = assistantConversationDetailQueryOptions(
              accepted.conversationId,
              nextPage
            )
            const older = await queryClient.fetchQuery({
              ...olderOptions,
              staleTime: 0,
            })
            if (cancelled || !isCurrentScope(accepted.scope)) return
            reconcileObservationEpoch()
            assertAssistantHistoryResultCurrent(
              queryClient,
              accepted.conversationId,
              older
            )
            observedPages.set(nextPage, older)
            const olderMatch = findAssistantTurnMessage(older, accepted.turn)
            if (olderMatch) {
              cacheHistoryPages(accepted.conversationId, [older])
              finishProcessingTurn(accepted)
              return
            }
          }
        }

        attempts += 1
        setPollingAttempts(attempts)
        if (attempts >= MAX_POLL_ATTEMPTS) {
          setPollingStopped(true)
          return
        }
      } catch (error) {
        if (cancelled || !isCurrentScope(accepted.scope)) return
        setPollingError(error)
        setPollingStopped(true)
        return
      }
      timer = window.setTimeout(poll, POLL_INTERVAL_MS)
    }

    timer = window.setTimeout(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      void queryClient.cancelQueries({
        queryKey: [
          'assistant',
          'conversation',
          accepted.conversationId,
          'page',
        ],
      })
    }
  }, [
    cacheHistoryPages,
    finishProcessingTurn,
    isCurrentScope,
    pollingStopped,
    processingTurn,
    queryClient,
    setPollingAttempts,
    setPollingError,
    setPollingStopped,
  ])
}
