import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { CoreApiError } from '@/lib/core-api'
import { getRequestRecoveryGeneration } from '@/lib/request-recovery'
import {
  assistantAccessError,
  assertAssistantAccessCurrent,
  beginAssistantQuestion,
  captureAssistantAccess,
  containAssistantAccessFailure,
  isAssistantAccessCurrent,
  retryAssistantAccess,
  useAssistantAccessRevision,
  type AssistantAccessToken,
} from './assistant-access'
import {
  ASSISTANT_QUESTION_LIMIT,
  assistantConversationHistoryQueryOptions,
  assistantConversationsInfiniteQueryOptions,
  assistantQuestionLength,
  createAssistantConversation,
  findAssistantTurnMessage,
  isBlankAssistantQuestion,
  newAssistantIdempotencyKey,
  normalizeAssistantQuestion,
  submitAssistantQuestion,
  type AssistantConversation,
  type AssistantConversationDetail,
  type AssistantTurn,
} from './assistant-api'
import {
  uniqueConversations,
  useAssistantHistory,
  useAssistantHistoryPolling,
} from './assistant-history'
import type {
  AssistantUiScope,
  ProcessingTurn,
  Submission,
} from './assistant-types'

type CreateOperation = {
  access: AssistantAccessToken
  operationId: number
  scope: AssistantUiScope
  meetingId: string
  title?: string
}

type QuestionOperation = {
  access: AssistantAccessToken
  operationId: number
  scope: AssistantUiScope
  submission: Submission
}

type AcceptedTurnCache = {
  submission: Submission
  turn: AssistantTurn
}

export function useAssistantConversation() {
  const queryClient = useQueryClient()
  useAssistantAccessRevision(queryClient)
  const [selectedMeetingId, setSelectedMeetingId] = useState<string>()
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | undefined
  >()
  const [conversationTitle, setConversationTitle] = useState('')
  const [question, setQuestion] = useState('')
  const [questionValidationError, setQuestionValidationError] = useState<
    string | undefined
  >()
  const [submission, setSubmission] = useState<Submission>()
  const submissionRef = useRef<Submission | undefined>(undefined)
  const [submissionError, setSubmissionError] = useState<unknown>()
  const [processingTurn, setProcessingTurn] = useState<ProcessingTurn>()
  const [pollingStopped, setPollingStopped] = useState(false)
  const [pollingError, setPollingError] = useState<unknown>()
  const [pollingAttempts, setPollingAttempts] = useState(0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<unknown>()
  const [historyRefreshError, setHistoryRefreshError] = useState<unknown>()
  const [isRefreshingHistory, setIsRefreshingHistory] = useState(false)

  const scopeRef = useRef<AssistantUiScope>({
    generation: 0,
    session: getRequestRecoveryGeneration(),
  })
  const createOperationRef = useRef<number | undefined>(undefined)
  const questionOperationRef = useRef<number | undefined>(undefined)
  const refreshOperationRef = useRef<number | undefined>(undefined)
  const createSequenceRef = useRef(0)
  const questionSequenceRef = useRef(0)
  const refreshSequenceRef = useRef(0)

  const listAccessError = assistantAccessError(queryClient)
  const detailAccessError = assistantAccessError(
    queryClient,
    selectedConversationId
  )
  const conversationsQuery = useInfiniteQuery({
    ...assistantConversationsInfiniteQueryOptions(),
    enabled: !listAccessError,
  })
  const detailQuery = useInfiniteQuery({
    ...assistantConversationHistoryQueryOptions(selectedConversationId),
    enabled: Boolean(selectedConversationId) && !detailAccessError,
    refetchOnMount: 'always',
  })

  const allConversations = useMemo(
    () => listAccessError ? [] : uniqueConversations(conversationsQuery.data?.pages ?? []),
    [conversationsQuery.data, listAccessError]
  )
  const selectedConversations = useMemo(
    () =>
      allConversations.filter(
        (conversation) => conversation.meetingId === selectedMeetingId
      ),
    [allConversations, selectedMeetingId]
  )

  const createMutation = useMutation({
    mutationFn: async (operation: CreateOperation) => {
      assertAssistantAccessCurrent(queryClient, operation.access)
      const conversation = await createAssistantConversation(
        operation.meetingId,
        operation.title
      )
      assertAssistantAccessCurrent(queryClient, operation.access)
      return conversation
    },
    onSuccess: (conversation, operation) => {
      if (!isAssistantAccessCurrent(queryClient, operation.access)) return
      queryClient.setQueryData(
        ['assistant', 'conversation', conversation.id, 'summary'],
        conversation
      )
      void queryClient.invalidateQueries({
        queryKey: ['assistant', 'conversations'],
      })
      if (conversation.meetingId !== operation.meetingId) {
        if (isCurrentScope(operation.scope)) {
          setCreateError(
            new CoreApiError({
              message: 'Core returned a conversation for a different meeting.',
              code: 'MALFORMED_RESPONSE',
              kind: 'malformed',
            })
          )
        }
        return
      }
      if (!isCurrentScope(operation.scope)) return
      scopeRef.current = {
        ...operation.scope,
        generation: operation.scope.generation + 1,
        conversationId: conversation.id,
      }
      setSelectedConversationId(conversation.id)
      setConversationTitle('')
      setQuestion('')
      setSubmission(undefined)
      submissionRef.current = undefined
      setSubmissionError(undefined)
      setProcessingTurn(undefined)
      setCreateError(undefined)
    },
    onError: (error, operation) => {
      if (containAssistantAccessFailure(queryClient, operation.access, error)) return
      if (isCurrentScope(operation.scope)) setCreateError(error)
    },
    onSettled: (_data, _error, operation) => {
      if (operation.scope.session !== getRequestRecoveryGeneration()) return
      if (createOperationRef.current !== operation.operationId) return
      createOperationRef.current = undefined
      setIsCreating(false)
    },
  })

  const questionMutation = useMutation({
    mutationFn: async (operation: QuestionOperation) => {
      assertAssistantAccessCurrent(queryClient, operation.access)
      const turn = await submitAssistantQuestion(
        operation.submission.conversationId,
        operation.submission.question,
        operation.submission.idempotencyKey
      )
      assertAssistantAccessCurrent(queryClient, operation.access)
      if (turn.citations.some((citation) =>
        citation.meetingId !== operation.submission.meetingId
      )) {
        throw new CoreApiError({
          code: 'MALFORMED_RESPONSE',
          kind: 'malformed',
          message: 'Core returned Assistant evidence for a different meeting.',
        })
      }
      return turn
    },
  })

  const isCurrentScope = useCallback((expected: AssistantUiScope) => {
    const current = scopeRef.current
    return (
      current.generation === expected.generation &&
      current.session === expected.session &&
      expected.session === getRequestRecoveryGeneration() &&
      !assistantAccessError(queryClient, expected.conversationId) &&
      current.meetingId === expected.meetingId &&
      current.conversationId === expected.conversationId
    )
  }, [queryClient])

  const { cacheHistoryPages, fetchNewestHistory } = useAssistantHistory()

  const finishProcessingTurn = useCallback(
    (accepted: ProcessingTurn) => {
      if (!isCurrentScope(accepted.scope)) return
      const latestKey = [
        'assistant',
        'turn',
        accepted.conversationId,
        'latest-accepted',
      ] as const
      const latest = queryClient.getQueryData<AcceptedTurnCache>(latestKey)
      if (
        latest?.submission.idempotencyKey === accepted.submission.idempotencyKey
      ) {
        queryClient.removeQueries({ queryKey: latestKey, exact: true })
      }
      setProcessingTurn(undefined)
      setPollingStopped(false)
      setPollingError(undefined)
      setPollingAttempts(0)
      if (
        submissionRef.current?.idempotencyKey ===
        accepted.submission.idempotencyKey
      ) {
        setQuestion('')
        setSubmission(undefined)
        submissionRef.current = undefined
      }
    },
    [isCurrentScope, queryClient]
  )

  const createConversation = () => {
    const currentScope = scopeRef.current
    if (!currentScope.meetingId || assistantAccessError(queryClient)) return
    const operation: CreateOperation = {
      access: captureAssistantAccess(queryClient),
      operationId: ++createSequenceRef.current,
      scope: { ...currentScope },
      meetingId: currentScope.meetingId,
      title: conversationTitle || undefined,
    }
    createOperationRef.current = operation.operationId
    setCreateError(undefined)
    setIsCreating(true)
    createMutation.mutate(operation)
  }

  function clearConversationState(
    meetingId?: string,
    conversationId?: string
  ): AssistantUiScope {
    const nextScope: AssistantUiScope = {
      generation: scopeRef.current.generation + 1,
      session: getRequestRecoveryGeneration(),
      meetingId,
      conversationId,
    }
    scopeRef.current = nextScope
    setSelectedMeetingId(meetingId)
    setSelectedConversationId(conversationId)
    setConversationTitle('')
    setQuestion('')
    setQuestionValidationError(undefined)
    setSubmission(undefined)
    submissionRef.current = undefined
    setSubmissionError(undefined)
    setProcessingTurn(undefined)
    setPollingStopped(false)
    setPollingError(undefined)
    setPollingAttempts(0)
    setHistoryRefreshError(undefined)
    setIsRefreshingHistory(false)
    setIsSubmitting(false)
    setIsCreating(false)
    setCreateError(undefined)
    createOperationRef.current = undefined
    questionOperationRef.current = undefined
    refreshOperationRef.current = undefined
    createMutation.reset()
    questionMutation.reset()
    return nextScope
  }

  function selectMeeting(meetingId: string) {
    clearConversationState(meetingId || undefined)
  }

  function openConversation(conversation: AssistantConversation) {
    retryAssistantAccess(queryClient, conversation.id)
    const scope = clearConversationState(
      conversation.meetingId,
      conversation.id
    )
    const accepted = queryClient.getQueryData<AcceptedTurnCache>([
      'assistant',
      'turn',
      conversation.id,
      'latest-accepted',
    ])
    if (
      accepted?.turn.state === 'PROCESSING' &&
      accepted.submission.meetingId === conversation.meetingId &&
      accepted.submission.conversationId === conversation.id
    ) {
      submissionRef.current = accepted.submission
      setSubmission(accepted.submission)
      setQuestion(accepted.submission.question)
      setProcessingTurn({
        scope,
        conversationId: conversation.id,
        submission: accepted.submission,
        turn: accepted.turn,
      })
    }
  }

  async function submitQuestion(
    event?: FormEvent<HTMLFormElement>,
    retrySameQuestion = false
  ) {
    event?.preventDefault()
    const activeScope = { ...scopeRef.current }
    if (
      !activeScope.meetingId ||
      !activeScope.conversationId ||
      !isCurrentScope(activeScope) ||
      questionOperationRef.current !== undefined
    ) {
      return
    }

    const normalizedQuestion = normalizeAssistantQuestion(question)
    if (!retrySameQuestion && isBlankAssistantQuestion(normalizedQuestion)) {
      setQuestionValidationError('Enter a question before submitting.')
      return
    }
    if (!retrySameQuestion && assistantQuestionLength(normalizedQuestion) > ASSISTANT_QUESTION_LIMIT) {
      setQuestionValidationError(
        'Questions must be at most 4096 Unicode code points.'
      )
      return
    }

    const previous = submissionRef.current
    const previousMatchesScope =
      previous?.meetingId === activeScope.meetingId &&
      previous.conversationId === activeScope.conversationId
    const current =
      retrySameQuestion && previousMatchesScope && previous
        ? previous
        : previousMatchesScope &&
            previous.question === normalizedQuestion &&
            submissionError
          ? previous
          : {
              meetingId: activeScope.meetingId,
              conversationId: activeScope.conversationId,
              question: normalizedQuestion,
              idempotencyKey: newAssistantIdempotencyKey(),
            }
    const operation: QuestionOperation = {
      access: beginAssistantQuestion(queryClient, current.conversationId),
      operationId: ++questionSequenceRef.current,
      scope: activeScope,
      submission: current,
    }

    submissionRef.current = current
    setSubmission(current)
    setQuestionValidationError(undefined)
    setSubmissionError(undefined)
    setPollingError(undefined)
    setPollingStopped(false)
    setPollingAttempts(0)
    questionOperationRef.current = operation.operationId
    setIsSubmitting(true)
    try {
      const turn = await questionMutation.mutateAsync(operation)
      if (!isAssistantAccessCurrent(queryClient, operation.access)) return
      const latestKey = ['assistant', 'turn', current.conversationId, 'latest-accepted']
      if (turn.state === 'PROCESSING') {
        // Only the accepted processing identity is needed when reopening.
        queryClient.setQueryData<AcceptedTurnCache>(latestKey, {
          turn: { ...turn, answer: null, claims: [], citations: [] },
          submission: current,
        })
      } else {
        queryClient.removeQueries({ queryKey: latestKey, exact: true })
      }
      void queryClient.invalidateQueries({
        queryKey: assistantConversationHistoryQueryOptions(
          current.conversationId
        ).queryKey,
        refetchType: 'none',
      })

      if (turn.state === 'PROCESSING') {
        if (isCurrentScope(operation.scope)) {
          setProcessingTurn({
            scope: operation.scope,
            conversationId: current.conversationId,
            submission: current,
            turn,
          })
        }
        return
      }
      if (turn.state === 'STALE_SOURCE') {
        if (isCurrentScope(operation.scope)) {
          setSubmissionError(
            new CoreApiError({
              status: 409,
              message: 'Assistant evidence is no longer current.',
              code: 'ASSISTANT_SOURCE_STALE',
              kind: 'http',
            })
          )
        }
        return
      }
      if (turn.state === 'FAILED') {
        if (isCurrentScope(operation.scope)) {
          setSubmissionError(
            new CoreApiError({
              status: 503,
              message: 'Assistant answer is unavailable.',
              code: 'ASSISTANT_UNAVAILABLE',
              kind: 'server',
            })
          )
        }
        return
      }
      await fetchNewestHistory(current.conversationId)
      if (!isCurrentScope(operation.scope)) return
      setQuestion('')
      setSubmission(undefined)
      submissionRef.current = undefined
    } catch (error) {
      if (!containAssistantAccessFailure(queryClient, operation.access, error) &&
        isAssistantAccessCurrent(queryClient, operation.access) &&
        isCurrentScope(operation.scope)) setSubmissionError(error)
    } finally {
      if (operation.scope.session === getRequestRecoveryGeneration() &&
        questionOperationRef.current === operation.operationId) {
        questionOperationRef.current = undefined
        setIsSubmitting(false)
      }
    }
  }

  async function refreshConversation() {
    const currentScope = { ...scopeRef.current }
    if (!currentScope.conversationId || !isCurrentScope(currentScope)) return
    const operationId = ++refreshSequenceRef.current
    refreshOperationRef.current = operationId
    setHistoryRefreshError(undefined)
    setIsRefreshingHistory(true)
    try {
      const newest = await fetchNewestHistory(currentScope.conversationId)
      if (!isCurrentScope(currentScope)) return
      const accepted =
        processingTurn &&
        isCurrentScope(processingTurn.scope) &&
        processingTurn.conversationId === currentScope.conversationId
          ? processingTurn
          : undefined
      const pages = queryClient.getQueryData<
        InfiniteData<AssistantConversationDetail, number>
      >(
        assistantConversationHistoryQueryOptions(currentScope.conversationId)
          .queryKey
      )?.pages ?? [newest]
      if (
        accepted &&
        pages.some((detail) => findAssistantTurnMessage(detail, accepted.turn))
      ) {
        finishProcessingTurn(accepted)
      }
    } catch (error) {
      if (isCurrentScope(currentScope)) setHistoryRefreshError(error)
    } finally {
      if (currentScope.session === getRequestRecoveryGeneration() &&
        refreshOperationRef.current === operationId) {
        refreshOperationRef.current = undefined
        setIsRefreshingHistory(false)
      }
    }
  }

  useAssistantHistoryPolling({
    processingTurn,
    pollingStopped,
    isCurrentScope,
    cacheHistoryPages,
    finishProcessingTurn,
    setPollingAttempts,
    setPollingError,
    setPollingStopped,
  })

  const questionCount = assistantQuestionLength(question)
  const selectedConversation =
    allConversations.find(
      (conversation) => conversation.id === selectedConversationId
    ) ?? detailQuery.data?.pages[0]?.conversation
  const isQuestionBusy = isSubmitting || Boolean(processingTurn)

  return {
    selectedMeetingId,
    selectMeeting,
    selector: {
      listAccessError,
      onListAccessRetry: () => {
        retryAssistantAccess(queryClient)
        clearConversationState(selectedMeetingId)
        void conversationsQuery.refetch()
      },
      selectedMeetingId,
      conversations: selectedConversations,
      allConversations,
      conversationsQuery,
      selectedConversationId,
      conversationTitle,
      onMeetingChange: selectMeeting,
      onConversationOpen: openConversation,
      onConversationTitleChange: setConversationTitle,
      onCreate: createConversation,
      createPending: isCreating,
      createError,
      onLoadOlderConversations: () => void conversationsQuery.fetchNextPage(),
    },
    panel: {
      listAccessError,
      detailAccessError,
      onDetailAccessRetry: () => {
        retryAssistantAccess(queryClient, selectedConversationId)
        clearConversationState(selectedMeetingId, selectedConversationId)
        void detailQuery.refetch()
      },
      selectedConversationId,
      selectedConversation,
      detailQuery,
      historyRefreshError,
      historyRefreshing: isRefreshingHistory,
      onLoadOlderMessages: () =>
        void detailQuery.fetchNextPage({ cancelRefetch: false }),
      question,
      questionCount,
      questionValidationError,
      onQuestionChange: (value: string) => {
        setQuestion(value)
        setQuestionValidationError(undefined)
      },
      onQuestionSubmit: (event: FormEvent<HTMLFormElement>) =>
        void submitQuestion(event),
      onQuestionRetry: () => void submitQuestion(undefined, true),
      questionBusy: isQuestionBusy,
      submission,
      submissionError,
      processingTurn,
      pollingStopped,
      pollingError,
      pollingAttempts,
      onRefresh: () => void refreshConversation(),
      onResumePolling: () => {
        setPollingError(undefined)
        setPollingStopped(false)
        setPollingAttempts(0)
      },
    },
  }
}
