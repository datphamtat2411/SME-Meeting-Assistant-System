import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { normalizeCoreApiError } from '@/lib/core-api'
import {
  assistantAccessError,
  captureAssistantCreationAccess,
  containAssistantAccessFailure,
  invalidateAssistantHistory,
  isAssistantAccessCurrent,
  retryAssistantAccess,
  revalidateAssistantHistory,
  useAssistantAccessRevision,
} from './assistant-access'
import {
  ASSISTANT_QUESTION_LIMIT,
  assistantConversationHistoryQueryOptions,
  assistantConversationsInfiniteQueryOptions,
  assistantQuestionLength,
  createAssistantConversation,
  isBlankAssistantQuestion,
  newAssistantIdempotencyKey,
  normalizeAssistantQuestion,
  type AssistantConversation,
} from './assistant-api'
import { uniqueConversations } from './assistant-history'
import type { AssistantSelection } from './assistant-selection'
import { useAssistantTurnWorkflow } from './assistant-turn-workflow'

export function useAssistantConversation(
  selection: AssistantSelection,
  onSelectionChange: (selection: AssistantSelection) => void
) {
  const client = useQueryClient()
  useAssistantAccessRevision(client)
  const {
    meetingId: selectedMeetingId,
    conversationId: selectedConversationId,
  } = selection
  const [openedId, setOpenedId] = useState<string>()
  const [previousId, setPreviousId] = useState(selectedConversationId)
  const [conversationTitle, setConversationTitle] = useState('')
  const [question, setQuestion] = useState('')
  const [questionValidationError, setQuestionValidationError] =
    useState<string>()
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<unknown>()
  const [uncertainCreation, setUncertainCreation] = useState(false)
  const creationRef = useRef(false)
  const selectionRef = useRef(selection)
  const selectionGeneration = useRef(0)
  const [historyRefreshing, setHistoryRefreshing] = useState(false)
  const [historyError, setHistoryError] = useState<unknown>()
  const refreshGeneration = useRef(0)

  useEffect(() => {
    selectionRef.current = {
      conversationId: selectedConversationId,
      meetingId: selectedMeetingId,
    }
    selectionGeneration.current += 1
  }, [selectedConversationId, selectedMeetingId])

  // Reset conversation-local presentation state during a selection transition
  // before React commits the new conversation, not in a cascading effect.
  if (previousId !== selectedConversationId) {
    setPreviousId(selectedConversationId)
    setOpenedId(undefined)
    setQuestion('')
    setQuestionValidationError(undefined)
    setHistoryError(undefined)
    setHistoryRefreshing(false)
  }

  useEffect(() => {
    if (!selectedConversationId) return
    let current = true
    retryAssistantAccess(client, selectedConversationId)
    // Await the reset itself. The new query remains disabled until all old
    // pages and in-flight reads have been invalidated by the security boundary.
    void revalidateAssistantHistory(client, selectedConversationId)
      .catch(() => {
        /* The enabled detail query will surface its own read failure. */
      })
      .then(() => {
        if (current) setOpenedId(selectedConversationId)
      })
    return () => {
      current = false
    }
  }, [client, selectedConversationId])

  const listAccessError = assistantAccessError(client)
  const detailAccessError = assistantAccessError(client, selectedConversationId)
  const conversationsQuery = useInfiniteQuery({
    ...assistantConversationsInfiniteQueryOptions(),
    enabled: !listAccessError,
  })
  const detailQuery = useInfiniteQuery({
    ...assistantConversationHistoryQueryOptions(selectedConversationId),
    enabled:
      Boolean(selectedConversationId) &&
      openedId === selectedConversationId &&
      !detailAccessError,
    refetchOnMount: 'always',
  })
  const historyAccessReady =
    openedId === selectedConversationId &&
    Boolean(detailQuery.data) &&
    !detailAccessError &&
    !historyRefreshing &&
    (!detailQuery.isError || detailQuery.isFetchNextPageError) &&
    (!detailQuery.isFetching || detailQuery.isFetchingNextPage)
  const detail = historyAccessReady ? detailQuery.data?.pages[0] : undefined
  const selectedConversation = detail?.conversation
  const turns = useAssistantTurnWorkflow(
    detail,
    historyAccessReady,
    selectedConversationId
  )

  const allConversations = useMemo(
    () =>
      listAccessError
        ? []
        : uniqueConversations(conversationsQuery.data?.pages ?? []),
    [conversationsQuery.data, listAccessError]
  )
  const conversations = allConversations.filter((item) =>
    selectedMeetingId ? item.meetingId === selectedMeetingId : true
  )

  function selectMeeting(meetingId: string) {
    const next = { ...selection, meetingId: meetingId || undefined }
    selectionRef.current = next
    selectionGeneration.current += 1
    setConversationTitle('')
    setCreateError(undefined)
    onSelectionChange(next)
  }

  function openConversation(conversation: AssistantConversation) {
    retryAssistantAccess(client, conversation.id)
    if (conversation.id === selectedConversationId)
      invalidateAssistantHistory(client, conversation.id)
    const next = {
      meetingId: conversation.meetingId,
      conversationId: conversation.id,
    }
    selectionRef.current = next
    selectionGeneration.current += 1
    onSelectionChange(next)
  }

  async function createConversation() {
    const meetingId = selection.meetingId
    if (!meetingId || creationRef.current || assistantAccessError(client))
      return
    if (
      uncertainCreation &&
      !window.confirm(
        'Core may already have created a conversation. Create another conversation explicitly?'
      )
    )
      return
    const access = captureAssistantCreationAccess(client, meetingId)
    const generation = selectionGeneration.current
    creationRef.current = true
    setIsCreating(true)
    setCreateError(undefined)
    setUncertainCreation(false)
    try {
      const conversation = await createAssistantConversation(
        meetingId,
        conversationTitle || undefined
      )
      if (!isAssistantAccessCurrent(client, access)) return
      void client.invalidateQueries({
        queryKey: ['assistant', 'conversations'],
      })
      if (
        generation !== selectionGeneration.current ||
        selectionRef.current.meetingId !== meetingId
      )
        return
      setConversationTitle('')
      openConversation(conversation)
    } catch (error) {
      const wasCurrent = isAssistantAccessCurrent(client, access)
      containAssistantAccessFailure(client, access, error)
      if (!wasCurrent) return
      const failure = normalizeCoreApiError(error)
      const uncertain =
        failure.isNetworkError ||
        failure.isServerError ||
        failure.kind === 'malformed' ||
        failure.recoveryOutcome === 'uncertain'
      if (uncertain) {
        setUncertainCreation(true)
        void client.invalidateQueries({
          queryKey: ['assistant', 'conversations'],
        })
      }
      if (generation === selectionGeneration.current) setCreateError(error)
    } finally {
      creationRef.current = false
      setIsCreating(false)
    }
  }

  async function refreshConversation() {
    const id = selectedConversationId
    if (!id) return
    const generation = ++refreshGeneration.current
    setHistoryRefreshing(true)
    setHistoryError(undefined)
    try {
      await revalidateAssistantHistory(client, id)
    } catch (error) {
      if (
        selectionRef.current.conversationId === id &&
        refreshGeneration.current === generation
      )
        setHistoryError(error)
    } finally {
      if (
        selectionRef.current.conversationId === id &&
        refreshGeneration.current === generation
      )
        setHistoryRefreshing(false)
    }
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      !selectedConversation ||
      turns.busy ||
      selectedConversation.status !== 'ACTIVE'
    )
      return
    const normalized = normalizeAssistantQuestion(question)
    if (isBlankAssistantQuestion(normalized)) {
      setQuestionValidationError('Enter a question before submitting.')
      return
    }
    if (assistantQuestionLength(normalized) > ASSISTANT_QUESTION_LIMIT) {
      setQuestionValidationError(
        'Questions must be at most 4096 Unicode code points.'
      )
      return
    }
    setQuestionValidationError(undefined)
    void turns.submit({
      meetingId: selectedConversation.meetingId,
      conversationId: selectedConversation.id,
      question: normalized,
      idempotencyKey: newAssistantIdempotencyKey(),
    })
    setQuestion('')
  }

  const inactive = selectedConversation?.status !== 'ACTIVE'
  return {
    selectedMeetingId,
    selectMeeting,
    selector: {
      listAccessError,
      onListAccessRetry: () => {
        retryAssistantAccess(client)
        void conversationsQuery.refetch()
      },
      selectedMeetingId,
      conversations,
      allConversations,
      conversationsQuery,
      selectedConversationId,
      conversationTitle,
      onMeetingChange: selectMeeting,
      onConversationOpen: openConversation,
      onConversationTitleChange: setConversationTitle,
      onCreate: () => void createConversation(),
      createPending: isCreating,
      createError,
      uncertainCreation,
      onLoadOlderConversations: () => void conversationsQuery.fetchNextPage(),
    },
    panel: {
      listAccessError,
      detailAccessError,
      onDetailAccessRetry: () => {
        retryAssistantAccess(client, selectedConversationId)
        void refreshConversation()
      },
      selectedConversationId,
      selectedConversation,
      detailQuery,
      historyAccessReady,
      historyRefreshError: historyError ?? turns.historyRefreshError,
      historyRefreshing,
      onLoadOlderMessages: () => {
        if (
          normalizeCoreApiError(detailQuery.error).code ===
          'ASSISTANT_HISTORY_ANCHOR_NOT_FOUND'
        )
          void refreshConversation()
        else void detailQuery.fetchNextPage({ cancelRefetch: false })
      },
      question,
      questionCount: assistantQuestionLength(question),
      questionValidationError,
      onQuestionChange: (value: string) => {
        setQuestion(value)
        setQuestionValidationError(undefined)
      },
      onQuestionSubmit: submitQuestion,
      questionBusy: turns.busy || inactive,
      workflow: turns.workflow,
      onQuestionRetry: turns.retry,
      onRecover: turns.recover,
      onResumePolling: turns.resume,
      onRefresh: () => void refreshConversation(),
      inactive,
    },
  }
}
