import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Bot, LoaderCircle, RefreshCw, Search, ShieldAlert } from 'lucide-react'
import { CoreApiError, normalizeCoreApiError } from '@/lib/core-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { meetingListQueryOptions } from '@/features/meetings/data/list-api'
import {
  assistantConversationDetailQueryOptions,
  assistantConversationHistoryQueryOptions,
  assistantConversationsInfiniteQueryOptions,
  createAssistantConversation,
  findAssistantTurnMessage,
  newAssistantIdempotencyKey,
  submitAssistantQuestion,
  type AssistantConversation,
  type AssistantConversationDetail,
  type AssistantMessage,
  type AssistantTurn,
} from './assistant-api'

const POLL_INTERVAL_MS = 750
const MAX_POLL_ATTEMPTS = 40
const MAX_TURN_HISTORY_PAGES = 10

type Submission = {
  meetingId: string
  conversationId: string
  question: string
  idempotencyKey: string
}

type AssistantUiScope = {
  generation: number
  meetingId?: string
  conversationId?: string
}

type CreateOperation = {
  operationId: number
  scope: AssistantUiScope
  meetingId: string
  title?: string
}

type QuestionOperation = {
  operationId: number
  scope: AssistantUiScope
  submission: Submission
}

type AcceptedTurnCache = {
  submission: Submission
  turn: AssistantTurn
}

type ProcessingTurn = {
  scope: AssistantUiScope
  conversationId: string
  submission: Submission
  turn: AssistantTurn
}

type ConversationListQuery = {
  data?: InfiniteData<AssistantConversation[]>
  isPending: boolean
  isError: boolean
  error: unknown
  refetch: () => Promise<unknown>
  hasNextPage: boolean
  isFetchingNextPage: boolean
  isFetchNextPageError: boolean
  fetchNextPage: () => Promise<unknown>
}

type ConversationHistoryQuery = {
  data?: InfiniteData<AssistantConversationDetail>
  isPending: boolean
  isFetching: boolean
  isError: boolean
  error: unknown
  refetch: () => Promise<unknown>
  hasNextPage: boolean
  isFetchingNextPage: boolean
  isFetchNextPageError: boolean
  fetchNextPage: () => Promise<unknown>
}

export function AssistantPage() {
  const queryClient = useQueryClient()
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
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

  const scopeRef = useRef<AssistantUiScope>({ generation: 0 })
  const createOperationRef = useRef<number | undefined>(undefined)
  const questionOperationRef = useRef<number | undefined>(undefined)
  const refreshOperationRef = useRef<number | undefined>(undefined)
  const createSequenceRef = useRef(0)
  const questionSequenceRef = useRef(0)
  const refreshSequenceRef = useRef(0)

  const meetingsQuery = useQuery(
    meetingListQueryOptions({ q, page, pageSize: 20, sort: 'createdAt,desc' })
  )
  const conversationsQuery = useInfiniteQuery(
    assistantConversationsInfiniteQueryOptions()
  )
  const detailQuery = useInfiniteQuery(
    assistantConversationHistoryQueryOptions(selectedConversationId)
  )

  const selectedMeeting = meetingsQuery.data?.meetings.find(
    (meeting) => meeting.id === selectedMeetingId
  )
  const allConversations = useMemo(
    () => uniqueConversations(conversationsQuery.data?.pages ?? []),
    [conversationsQuery.data]
  )
  const selectedConversations = useMemo(
    () =>
      allConversations.filter(
        (conversation) => conversation.meetingId === selectedMeetingId
      ),
    [allConversations, selectedMeetingId]
  )

  const createMutation = useMutation({
    mutationFn: (operation: CreateOperation) =>
      createAssistantConversation(operation.meetingId, operation.title),
    onSuccess: (conversation, operation) => {
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
      if (isCurrentScope(operation.scope)) setCreateError(error)
    },
    onSettled: (_data, _error, operation) => {
      if (createOperationRef.current !== operation.operationId) return
      createOperationRef.current = undefined
      setIsCreating(false)
    },
  })

  const questionMutation = useMutation({
    mutationFn: (operation: QuestionOperation) =>
      submitAssistantQuestion(
        operation.submission.conversationId,
        operation.submission.question,
        operation.submission.idempotencyKey
      ),
  })

  const isCurrentScope = useCallback((expected: AssistantUiScope) => {
    const current = scopeRef.current
    return (
      current.generation === expected.generation &&
      current.meetingId === expected.meetingId &&
      current.conversationId === expected.conversationId
    )
  }, [])

  const cacheHistoryPages = useCallback(
    (
      currentConversationId: string,
      incomingPages: AssistantConversationDetail[]
    ) => {
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
        const seenMessageIds = new Set<string>()
        const deduplicatedPages = pages.map((detail) => ({
          ...detail,
          messages: detail.messages.filter((message) => {
            if (seenMessageIds.has(message.id)) return false
            seenMessageIds.add(message.id)
            return true
          }),
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
      const newest = await queryClient.fetchQuery({
        ...assistantConversationDetailQueryOptions(currentConversationId, 0),
        staleTime: 0,
      })
      cacheHistoryPages(currentConversationId, [newest])
      return newest
    },
    [cacheHistoryPages, queryClient]
  )

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
    if (!currentScope.meetingId) return
    const operation: CreateOperation = {
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
      questionOperationRef.current !== undefined
    ) {
      return
    }

    const normalizedQuestion = question.trim()
    if (!retrySameQuestion && !normalizedQuestion) {
      setQuestionValidationError('Enter a question before submitting.')
      return
    }
    if (!retrySameQuestion && [...normalizedQuestion].length > 4096) {
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
      const acceptedTurnCache: AcceptedTurnCache = {
        turn,
        submission: current,
      }
      queryClient.setQueryData(
        [
          'assistant',
          'turn',
          current.conversationId,
          'by-idempotency-key',
          current.idempotencyKey,
        ],
        acceptedTurnCache
      )
      queryClient.setQueryData(
        ['assistant', 'turn', current.conversationId, 'latest-accepted'],
        acceptedTurnCache
      )
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
      if (isCurrentScope(operation.scope)) setSubmissionError(error)
    } finally {
      if (questionOperationRef.current === operation.operationId) {
        questionOperationRef.current = undefined
        setIsSubmitting(false)
      }
    }
  }

  async function refreshConversation() {
    const currentScope = { ...scopeRef.current }
    if (!currentScope.conversationId) return
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
      if (refreshOperationRef.current === operationId) {
        refreshOperationRef.current = undefined
        setIsRefreshingHistory(false)
      }
    }
  }

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
        observedPages.set(0, newest)
        cacheHistoryPages(accepted.conversationId, [newest])

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
          cacheHistoryPages(accepted.conversationId, [
            ...observedPages.values(),
          ])
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
            observedPages.set(nextPage, older)
            const olderMatch = findAssistantTurnMessage(older, accepted.turn)
            if (olderMatch) {
              cacheHistoryPages(accepted.conversationId, [
                ...observedPages.values(),
              ])
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
  ])

  function submitSearch(event: FormEvent) {
    event.preventDefault()
    setPage(1)
    setQ(input.trim())
  }

  const questionCount = [...question].length
  const selectedConversation =
    allConversations.find(
      (conversation) => conversation.id === selectedConversationId
    ) ?? detailQuery.data?.pages[0]?.conversation
  const isQuestionBusy = isSubmitting || Boolean(processingTurn)

  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='space-y-6'>
        <div>
          <p className='text-sm font-medium text-primary'>
            Knowledge discovery
          </p>
          <h1 className='flex items-center gap-2 text-3xl font-bold'>
            <Bot className='size-7' /> AI Assistant & search
          </h1>
          <p className='mt-2 text-muted-foreground'>
            Ask questions about an authorized meeting through the Core
            Assistant, or search meeting metadata.
          </p>
        </div>

        <AssistantConversationCard
          meetings={meetingsQuery.data?.meetings ?? []}
          selectedMeetingId={selectedMeetingId}
          selectedMeetingTitle={selectedMeeting?.title}
          conversations={selectedConversations}
          allConversations={allConversations}
          conversationsQuery={conversationsQuery}
          selectedConversationId={selectedConversationId}
          selectedConversation={selectedConversation}
          conversationTitle={conversationTitle}
          onMeetingChange={selectMeeting}
          onConversationOpen={openConversation}
          onConversationTitleChange={setConversationTitle}
          onCreate={createConversation}
          createPending={isCreating}
          createError={createError}
          onLoadOlderConversations={() =>
            void conversationsQuery.fetchNextPage()
          }
          detailQuery={detailQuery}
          historyRefreshError={historyRefreshError}
          historyRefreshing={isRefreshingHistory}
          onLoadOlderMessages={() =>
            void detailQuery.fetchNextPage({ cancelRefetch: false })
          }
          question={question}
          questionCount={questionCount}
          questionValidationError={questionValidationError}
          onQuestionChange={(value) => {
            setQuestion(value)
            setQuestionValidationError(undefined)
          }}
          onQuestionSubmit={(event) => void submitQuestion(event)}
          onQuestionRetry={() => void submitQuestion(undefined, true)}
          questionBusy={isQuestionBusy}
          submission={submission}
          submissionError={submissionError}
          processingTurn={processingTurn}
          pollingStopped={pollingStopped}
          pollingError={pollingError}
          pollingAttempts={pollingAttempts}
          onRefresh={() => void refreshConversation()}
          onResumePolling={() => {
            setPollingError(undefined)
            setPollingStopped(false)
            setPollingAttempts(0)
          }}
        />

        <Card>
          <CardHeader>
            <CardTitle>Search meetings</CardTitle>
            <form className='flex gap-2' onSubmit={submitSearch}>
              <Input
                aria-label='Search meeting titles'
                placeholder='Search by meeting title or description'
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
              <Button type='submit'>
                <Search className='size-4' /> Search
              </Button>
            </form>
          </CardHeader>
          <CardContent className='space-y-3'>
            {meetingsQuery.isPending ? (
              <RequestLoading />
            ) : meetingsQuery.isError ? (
              <RequestError
                error={meetingsQuery.error}
                retry={() => void meetingsQuery.refetch()}
              />
            ) : !meetingsQuery.data.meetings.length ? (
              <RequestEmpty title='No accessible meetings match' />
            ) : (
              meetingsQuery.data.meetings.map((meeting) => (
                <div
                  className='flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between'
                  key={meeting.id}
                >
                  <Link
                    className='min-w-0 flex-1 rounded-md hover:bg-accent'
                    to='/meetings/$meetingId'
                    params={{ meetingId: meeting.id }}
                  >
                    <div className='flex flex-wrap items-center justify-between gap-2'>
                      <strong>{meeting.title}</strong>
                      <Badge variant='outline'>{meeting.status}</Badge>
                    </div>
                    <p className='mt-1 line-clamp-2 text-sm text-muted-foreground'>
                      {meeting.description || 'No description provided'}
                    </p>
                  </Link>
                  <Button
                    type='button'
                    variant={
                      selectedMeetingId === meeting.id ? 'default' : 'outline'
                    }
                    onClick={() => selectMeeting(meeting.id)}
                  >
                    {selectedMeetingId === meeting.id
                      ? 'Selected for Assistant'
                      : 'Use meeting for Assistant'}
                  </Button>
                </div>
              ))
            )}
            {meetingsQuery.data && (
              <div className='flex items-center justify-between text-sm text-muted-foreground'>
                <span>
                  {meetingsQuery.data.pagination.totalElements} result(s)
                </span>
                <div className='flex items-center gap-2'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!meetingsQuery.data.pagination.hasPrevious}
                    onClick={() => setPage((current) => current - 1)}
                  >
                    Previous
                  </Button>
                  {page}
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!meetingsQuery.data.pagination.hasNext}
                    onClick={() => setPage((current) => current + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </Main>
    </>
  )
}

function AssistantConversationCard({
  meetings,
  selectedMeetingId,
  selectedMeetingTitle,
  conversations,
  allConversations,
  conversationsQuery,
  selectedConversationId,
  selectedConversation,
  conversationTitle,
  onMeetingChange,
  onConversationOpen,
  onConversationTitleChange,
  onCreate,
  createPending,
  createError,
  onLoadOlderConversations,
  detailQuery,
  historyRefreshError,
  historyRefreshing,
  onLoadOlderMessages,
  question,
  questionCount,
  questionValidationError,
  onQuestionChange,
  onQuestionSubmit,
  onQuestionRetry,
  questionBusy,
  submission,
  submissionError,
  processingTurn,
  pollingStopped,
  pollingError,
  pollingAttempts,
  onRefresh,
  onResumePolling,
}: {
  meetings: Array<{ id: string; title: string }>
  selectedMeetingId?: string
  selectedMeetingTitle?: string
  conversations: AssistantConversation[]
  allConversations: AssistantConversation[]
  conversationsQuery: ConversationListQuery
  selectedConversationId?: string
  selectedConversation?: AssistantConversation
  conversationTitle: string
  onMeetingChange: (meetingId: string) => void
  onConversationOpen: (conversation: AssistantConversation) => void
  onConversationTitleChange: (title: string) => void
  onCreate: () => void
  createPending: boolean
  createError: unknown
  onLoadOlderConversations: () => void
  detailQuery: ConversationHistoryQuery
  historyRefreshError: unknown
  historyRefreshing: boolean
  onLoadOlderMessages: () => void
  question: string
  questionCount: number
  questionValidationError?: string
  onQuestionChange: (question: string) => void
  onQuestionSubmit: (event: FormEvent<HTMLFormElement>) => void
  onQuestionRetry: () => void
  questionBusy: boolean
  submission?: Submission
  submissionError: unknown
  processingTurn?: ProcessingTurn
  pollingStopped: boolean
  pollingError: unknown
  pollingAttempts: number
  onRefresh: () => void
  onResumePolling: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <Bot className='size-5 text-primary' /> Assistant conversations
        </CardTitle>
        <p className='text-sm text-muted-foreground'>
          Conversations are owned by Core and remain bound to one authorized
          meeting.
        </p>
      </CardHeader>
      <CardContent className='space-y-5'>
        {conversationsQuery.isPending && !conversationsQuery.data ? (
          <RequestLoading label='Loading Assistant conversations…' />
        ) : conversationsQuery.isError && !conversationsQuery.data ? (
          <AssistantError
            error={conversationsQuery.error}
            onRetry={() => void conversationsQuery.refetch()}
          />
        ) : (
          <>
            <div className='grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'>
              <label className='space-y-1.5 text-sm font-medium'>
                <span>Meeting scope</span>
                <select
                  aria-label='Assistant meeting'
                  className='flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
                  value={selectedMeetingId ?? ''}
                  onChange={(event) => onMeetingChange(event.target.value)}
                >
                  <option value=''>Select an authorized meeting</option>
                  {meetings.map((meeting) => (
                    <option key={meeting.id} value={meeting.id}>
                      {meeting.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className='space-y-1.5 text-sm font-medium'>
                <span>Conversation title (optional)</span>
                <Input
                  aria-label='Conversation title'
                  maxLength={255}
                  value={conversationTitle}
                  onChange={(event) =>
                    onConversationTitleChange(event.target.value)
                  }
                  placeholder='Questions about this meeting'
                  disabled={!selectedMeetingId || createPending}
                />
              </label>
            </div>

            <div className='space-y-2'>
              <div className='flex items-center justify-between gap-3'>
                <h3 className='font-semibold'>
                  {selectedMeetingTitle
                    ? `Conversations for ${selectedMeetingTitle}`
                    : 'Existing conversations'}
                </h3>
                <Button
                  type='button'
                  onClick={onCreate}
                  disabled={!selectedMeetingId || createPending}
                >
                  {createPending && (
                    <LoaderCircle className='size-4 animate-spin' />
                  )}
                  Create conversation
                </Button>
              </div>
              {selectedMeetingId && conversations.length ? (
                <div className='space-y-2'>
                  {conversations.map((conversation) => (
                    <div
                      className='flex items-center justify-between gap-3 rounded-md border p-3'
                      key={conversation.id}
                    >
                      <div className='min-w-0'>
                        <p className='truncate font-medium'>
                          {conversation.title || 'Untitled conversation'}
                        </p>
                        <p className='text-xs text-muted-foreground'>
                          {conversation.status}
                        </p>
                      </div>
                      <Button
                        type='button'
                        size='sm'
                        variant={
                          selectedConversationId === conversation.id
                            ? 'default'
                            : 'outline'
                        }
                        onClick={() => onConversationOpen(conversation)}
                      >
                        {selectedConversationId === conversation.id
                          ? 'Opened'
                          : 'Open conversation'}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : allConversations.length && !selectedMeetingId ? (
                <RequestEmpty
                  title='Select a meeting to browse conversations'
                  description='Core only exposes conversations that belong to your authorized meeting scope.'
                />
              ) : (
                <RequestEmpty
                  title={
                    selectedMeetingId
                      ? 'No conversation for this meeting'
                      : 'Choose an authorized meeting'
                  }
                  description={
                    selectedMeetingId
                      ? 'Create a conversation explicitly to start asking questions.'
                      : undefined
                  }
                />
              )}
              {conversationsQuery.isFetchNextPageError && (
                <AssistantError
                  error={conversationsQuery.error}
                  onRetry={onLoadOlderConversations}
                />
              )}
              {conversationsQuery.hasNextPage && (
                <Button
                  type='button'
                  variant='outline'
                  disabled={conversationsQuery.isFetchingNextPage}
                  onClick={onLoadOlderConversations}
                >
                  {conversationsQuery.isFetchingNextPage && (
                    <LoaderCircle className='size-4 animate-spin' />
                  )}
                  {conversationsQuery.isFetchNextPageError
                    ? 'Retry loading older conversations'
                    : 'Load older conversations'}
                </Button>
              )}
            </div>

            {createError && <AssistantError error={createError} />}
          </>
        )}

        {selectedConversationId && (
          <div className='space-y-4 border-t pt-5'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <div>
                <h3 className='font-semibold'>
                  {selectedConversation?.title || 'Conversation'}
                </h3>
                <p className='text-sm text-muted-foreground'>
                  {selectedMeetingTitle || 'Authorized meeting'} ·{' '}
                  {selectedConversationId}
                </p>
              </div>
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={onRefresh}
                disabled={detailQuery.isFetching || historyRefreshing}
              >
                <RefreshCw className='size-4' /> Refresh history
              </Button>
            </div>
            {detailQuery.isPending && !detailQuery.data ? (
              <RequestLoading label='Loading conversation history…' />
            ) : detailQuery.isError && !detailQuery.data ? (
              <AssistantError
                error={detailQuery.error}
                onRetry={() => void detailQuery.refetch()}
              />
            ) : detailQuery.data ? (
              <ConversationHistory
                messages={chronologicalHistoryMessages(detailQuery.data.pages)}
                hasMore={Boolean(detailQuery.hasNextPage)}
                loadingOlder={detailQuery.isFetchingNextPage}
                olderPageError={
                  detailQuery.isFetchNextPageError
                    ? detailQuery.error
                    : undefined
                }
                onLoadOlder={onLoadOlderMessages}
              />
            ) : null}
            {historyRefreshError !== undefined &&
              historyRefreshError !== null && (
                <AssistantError error={historyRefreshError} />
              )}

            {(processingTurn || pollingStopped) && (
              <Alert>
                <LoaderCircle className='animate-spin' />
                <AlertTitle>Core is processing this question.</AlertTitle>
                <AlertDescription>
                  {pollingStopped
                    ? `Core accepted the turn, but completion was not observed after ${pollingAttempts} bounded checks. Refresh history or resume read-only status checks; the question will not be submitted again automatically.`
                    : 'The accepted turn remains PROCESSING. The Web is checking conversation history without creating another request.'}
                  {pollingStopped && (
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      onClick={onResumePolling}
                    >
                      Resume status checks
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {submissionError !== undefined && submissionError !== null && (
              <AssistantError
                error={submissionError}
                onRetry={submission ? onQuestionRetry : undefined}
              />
            )}
            {pollingError !== undefined &&
              pollingError !== null &&
              submissionError === undefined && (
                <AssistantError
                  error={pollingError}
                  onRetry={onResumePolling}
                />
              )}

            <form className='space-y-3' onSubmit={onQuestionSubmit}>
              <label className='space-y-1.5 text-sm font-medium'>
                <span>Ask about this meeting</span>
                <Textarea
                  aria-label='Assistant question'
                  value={question}
                  maxLength={4096}
                  onChange={(event) => onQuestionChange(event.target.value)}
                  placeholder='Ask a question grounded in the authorized meeting evidence'
                  disabled={questionBusy}
                />
              </label>
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <span className='text-xs text-muted-foreground'>
                  {questionCount}/4096 Unicode code points
                </span>
                {questionValidationError && (
                  <span role='alert' className='text-sm text-destructive'>
                    {questionValidationError}
                  </span>
                )}
                <Button
                  type='submit'
                  disabled={questionBusy || !question.trim()}
                >
                  {questionMutationLabel(questionBusy, processingTurn)}
                </Button>
              </div>
            </form>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function questionMutationLabel(
  busy: boolean,
  processingTurn?: ProcessingTurn
): ReactNode {
  if (processingTurn) return 'Processing…'
  if (busy) return <LoaderCircle className='size-4 animate-spin' />
  return 'Ask Assistant'
}

function uniqueConversations(
  pages: AssistantConversation[][]
): AssistantConversation[] {
  const seen = new Set<string>()
  return pages.flat().filter((conversation) => {
    if (seen.has(conversation.id)) return false
    seen.add(conversation.id)
    return true
  })
}

function chronologicalHistoryMessages(
  pages: AssistantConversationDetail[]
): AssistantMessage[] {
  const newestCopyById = new Map<string, AssistantMessage>()
  for (const page of pages) {
    for (const message of page.messages) {
      if (!newestCopyById.has(message.id)) {
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

function ConversationHistory({
  messages,
  hasMore,
  loadingOlder,
  olderPageError,
  onLoadOlder,
}: {
  messages: AssistantMessage[]
  hasMore: boolean
  loadingOlder: boolean
  olderPageError: unknown
  onLoadOlder: () => void
}) {
  return (
    <div className='space-y-3' aria-label='Conversation history'>
      {!messages.length && (
        <RequestEmpty
          title='Conversation is ready for questions.'
          description='Core has not recorded any messages in this conversation yet.'
        />
      )}
      {messages.map((message) => (
        <AssistantMessageCard key={message.id} message={message} />
      ))}
      {olderPageError !== undefined && olderPageError !== null && (
        <AssistantError error={olderPageError} />
      )}
      {hasMore && (
        <Button
          type='button'
          variant='outline'
          disabled={loadingOlder}
          onClick={onLoadOlder}
        >
          {loadingOlder && <LoaderCircle className='size-4 animate-spin' />}
          {olderPageError
            ? 'Retry loading older messages'
            : 'Load older messages'}
        </Button>
      )}
    </div>
  )
}

function AssistantMessageCard({ message }: { message: AssistantMessage }) {
  const isUser = message.role === 'USER'
  const sourceUnavailable = message.visibility === 'SOURCE_UNAVAILABLE'
  return (
    <article
      className={`rounded-lg border p-4 ${isUser ? 'bg-muted/30' : 'bg-card'}`}
    >
      <div className='flex flex-wrap items-center gap-2'>
        <Badge variant={isUser ? 'outline' : 'default'}>
          {isUser ? 'You' : 'Assistant'}
        </Badge>
        {!isUser && message.answerStatus && (
          <Badge variant='outline'>{message.answerStatus}</Badge>
        )}
      </div>
      {sourceUnavailable ? (
        <Alert className='mt-3'>
          <ShieldAlert />
          <AlertTitle>Source unavailable</AlertTitle>
          <AlertDescription>
            Core no longer verifies the evidence for this answer. The previous
            answer is not displayed as current grounded content.
          </AlertDescription>
        </Alert>
      ) : (
        message.content && (
          <p className='mt-3 text-sm leading-6 whitespace-pre-wrap'>
            {message.content}
          </p>
        )
      )}
      {!isUser &&
        message.answerStatus === 'INSUFFICIENT_EVIDENCE' &&
        message.citations.length === 0 && (
          <p className='mt-3 text-sm text-muted-foreground'>
            No verified citations were returned.
          </p>
        )}
      {!isUser && !sourceUnavailable && message.claims.length > 0 && (
        <div className='mt-4 space-y-2 border-t pt-3'>
          <p className='text-xs font-semibold tracking-wide text-muted-foreground uppercase'>
            Claims
          </p>
          {message.claims.map((claim) => (
            <div
              className='rounded-md bg-muted/40 p-3 text-sm'
              key={claim.claimId}
            >
              <p>{claim.text}</p>
              <p className='mt-1 text-xs text-muted-foreground'>
                {claim.support}
              </p>
            </div>
          ))}
        </div>
      )}
      {!isUser && !sourceUnavailable && message.citations.length > 0 && (
        <div className='mt-4 space-y-2 border-t pt-3'>
          <p className='text-xs font-semibold tracking-wide text-muted-foreground uppercase'>
            Evidence
          </p>
          {message.citations.map((citation) => (
            <details
              className='rounded-md border px-3 py-2 text-sm'
              key={citation.citationId}
            >
              <summary className='cursor-pointer font-medium'>
                {citation.sourceType} · Revision {citation.sourceRevision}
              </summary>
              <div className='mt-2 space-y-1 text-xs text-muted-foreground'>
                <p>Citation: {citation.citationId}</p>
                <p>Retrieval chunk: {citation.retrievalChunkId}</p>
                <p>Meeting-scoped source: {citation.meetingId}</p>
              </div>
            </details>
          ))}
        </div>
      )}
    </article>
  )
}

function AssistantError({
  error,
  onRetry,
}: {
  error: unknown
  onRetry?: () => void
}) {
  const failure = normalizeCoreApiError(error)
  return (
    <Alert variant='destructive'>
      <ShieldAlert />
      <AlertTitle>{assistantErrorTitle(failure)}</AlertTitle>
      <AlertDescription>
        <p>{assistantErrorMessage(failure)}</p>
        {onRetry && (
          <Button type='button' size='sm' variant='outline' onClick={onRetry}>
            <RefreshCw className='size-4' /> Retry or refresh
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

function assistantErrorTitle(error: CoreApiError): string {
  if (error.status === 401) return 'Authentication required'
  if (error.status === 403) return 'Assistant access denied'
  if (error.status === 404) return 'Conversation unavailable'
  if (error.status === 409) return 'Assistant evidence is stale'
  if (error.status === 429) return 'Assistant admission is limited'
  if (error.status === 503) return 'Assistant is currently unavailable.'
  if (error.kind === 'malformed') return 'Assistant response was invalid.'
  if (error.recoveryOutcome === 'uncertain' || error.isNetworkError) {
    return 'Assistant request outcome is uncertain'
  }
  return 'Assistant request failed'
}

function assistantErrorMessage(error: CoreApiError): string {
  if (error.status === 401) return 'Sign in again to use the Assistant.'
  if (error.status === 403) {
    return 'You are not authorized to use this Assistant conversation.'
  }
  if (error.status === 404) {
    return 'This conversation or meeting is no longer available to your account.'
  }
  if (error.status === 409) {
    return 'Assistant evidence is stale or unavailable. Refresh history before asking again.'
  }
  if (error.status === 422) {
    return error.message
  }
  if (error.status === 429) {
    return 'Core is limiting concurrent Assistant work. Try again explicitly later.'
  }
  if (error.status === 503) {
    return 'The Core Assistant capability is disabled, unavailable, or failed safely. No local answer was generated.'
  }
  if (error.kind === 'malformed') {
    return 'Core returned an invalid Assistant response. No answer was displayed.'
  }
  if (error.recoveryOutcome === 'uncertain' || error.isNetworkError) {
    return 'Core may have accepted the request, but its outcome is not known. Refresh history or retry the same question explicitly; it will not be duplicated automatically.'
  }
  return error.message
}
