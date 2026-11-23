import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  assistantConversationsQueryOptions,
  createAssistantConversation,
  fetchAssistantConversationDetail,
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

type Submission = {
  conversationId: string
  question: string
  idempotencyKey: string
}

type ProcessingTurn = {
  conversationId: string
  turn: AssistantTurn
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
  const submissionInFlightRef = useRef(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const meetingsQuery = useQuery(
    meetingListQueryOptions({ q, page, pageSize: 20, sort: 'createdAt,desc' })
  )
  const conversationsQuery = useQuery(assistantConversationsQueryOptions())
  const detailQuery = useQuery(
    assistantConversationDetailQueryOptions(selectedConversationId)
  )

  const selectedMeeting = meetingsQuery.data?.meetings.find(
    (meeting) => meeting.id === selectedMeetingId
  )
  const selectedConversations = useMemo(
    () =>
      (conversationsQuery.data ?? []).filter(
        (conversation) => conversation.meetingId === selectedMeetingId
      ),
    [conversationsQuery.data, selectedMeetingId]
  )

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedMeetingId) {
        throw new CoreApiError({
          message: 'Select an authorized meeting first.',
          code: 'ASSISTANT_MEETING_REQUIRED',
          kind: 'http',
        })
      }
      return createAssistantConversation(
        selectedMeetingId,
        conversationTitle || undefined
      )
    },
    onSuccess: (conversation) => {
      setSelectedConversationId(conversation.id)
      setConversationTitle('')
      setSubmission(undefined)
      submissionRef.current = undefined
      setSubmissionError(undefined)
      setProcessingTurn(undefined)
      void queryClient.invalidateQueries({
        queryKey: ['assistant', 'conversations'],
      })
    },
  })

  const questionMutation = useMutation({
    mutationFn: (current: Submission) =>
      submitAssistantQuestion(
        current.conversationId,
        current.question,
        current.idempotencyKey
      ),
  })

  useEffect(() => {
    if (
      !processingTurn ||
      processingTurn.conversationId !== selectedConversationId ||
      pollingStopped
    ) {
      return
    }

    let cancelled = false
    let timer: number | undefined
    let attempts = 0

    const poll = async () => {
      if (cancelled) return
      try {
        const detail = await queryClient.fetchQuery({
          ...assistantConversationDetailQueryOptions(
            processingTurn.conversationId
          ),
          queryFn: ({ signal }: { signal: AbortSignal }) =>
            fetchAssistantConversationDetail(processingTurn.conversationId, {
              signal,
            }),
        })
        if (cancelled) return
        if (findAssistantTurnMessage(detail, processingTurn.turn)) {
          setProcessingTurn(undefined)
          setPollingStopped(false)
          setPollingError(undefined)
          setPollingAttempts(0)
          setQuestion('')
          setSubmission(undefined)
          submissionRef.current = undefined
          return
        }
        attempts += 1
        setPollingAttempts(attempts)
        if (attempts >= MAX_POLL_ATTEMPTS) {
          setPollingStopped(true)
          return
        }
      } catch (error) {
        if (cancelled) return
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
    }
  }, [pollingStopped, processingTurn, queryClient, selectedConversationId])

  function clearConversationState() {
    setSelectedConversationId(undefined)
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
    createMutation.reset()
    questionMutation.reset()
  }

  function selectMeeting(meetingId: string) {
    clearConversationState()
    setSelectedMeetingId(meetingId || undefined)
  }

  function openConversation(conversation: AssistantConversation) {
    clearConversationState()
    setSelectedMeetingId(conversation.meetingId)
    setSelectedConversationId(conversation.id)
  }

  async function submitQuestion(
    event?: FormEvent<HTMLFormElement>,
    retrySameQuestion = false
  ) {
    event?.preventDefault()
    if (!selectedConversationId || submissionInFlightRef.current) return

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
    const current =
      retrySameQuestion && previous
        ? previous
        : previous?.conversationId === selectedConversationId &&
            previous.question === normalizedQuestion &&
            submissionError
          ? previous
          : {
              conversationId: selectedConversationId,
              question: normalizedQuestion,
              idempotencyKey: newAssistantIdempotencyKey(),
            }

    submissionRef.current = current
    setSubmission(current)
    setQuestionValidationError(undefined)
    setSubmissionError(undefined)
    setPollingError(undefined)
    setPollingStopped(false)
    setPollingAttempts(0)
    submissionInFlightRef.current = true
    setIsSubmitting(true)
    try {
      const turn = await questionMutation.mutateAsync(current)
      if (turn.state === 'PROCESSING') {
        setProcessingTurn({ conversationId: current.conversationId, turn })
        return
      }
      if (turn.state === 'STALE_SOURCE') {
        setSubmissionError(
          new CoreApiError({
            status: 409,
            message: 'Assistant evidence is no longer current.',
            code: 'ASSISTANT_SOURCE_STALE',
            kind: 'http',
          })
        )
        return
      }
      if (turn.state === 'FAILED') {
        setSubmissionError(
          new CoreApiError({
            status: 503,
            message: 'Assistant answer is unavailable.',
            code: 'ASSISTANT_UNAVAILABLE',
            kind: 'server',
          })
        )
        return
      }
      await queryClient.refetchQueries({
        queryKey: ['assistant', 'conversation', current.conversationId],
      })
      setQuestion('')
      setSubmission(undefined)
      submissionRef.current = undefined
    } catch (error) {
      setSubmissionError(error)
    } finally {
      submissionInFlightRef.current = false
      setIsSubmitting(false)
    }
  }

  async function refreshConversation() {
    const accepted = processingTurn
    const refreshed = await detailQuery.refetch()
    if (
      !accepted ||
      !refreshed.data ||
      !findAssistantTurnMessage(refreshed.data, accepted.turn)
    ) {
      return
    }
    setProcessingTurn(undefined)
    setPollingStopped(false)
    setPollingError(undefined)
    setPollingAttempts(0)
    setQuestion('')
    setSubmission(undefined)
    submissionRef.current = undefined
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault()
    setPage(1)
    setQ(input.trim())
  }

  const questionCount = [...question].length
  const selectedConversation =
    conversationsQuery.data?.find(
      (conversation) => conversation.id === selectedConversationId
    ) ?? detailQuery.data?.conversation
  const isQuestionBusy =
    questionMutation.isPending || isSubmitting || Boolean(processingTurn)

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
          allConversations={conversationsQuery.data ?? []}
          conversationsQuery={conversationsQuery}
          selectedConversationId={selectedConversationId}
          selectedConversation={selectedConversation}
          conversationTitle={conversationTitle}
          onMeetingChange={selectMeeting}
          onConversationOpen={openConversation}
          onConversationTitleChange={setConversationTitle}
          onCreate={() => createMutation.mutate()}
          createPending={createMutation.isPending}
          createError={createMutation.error}
          detailQuery={detailQuery}
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
  detailQuery,
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
  conversationsQuery: ReturnType<typeof useQuery<AssistantConversation[]>>
  selectedConversationId?: string
  selectedConversation?: AssistantConversation
  conversationTitle: string
  onMeetingChange: (meetingId: string) => void
  onConversationOpen: (conversation: AssistantConversation) => void
  onConversationTitleChange: (title: string) => void
  onCreate: () => void
  createPending: boolean
  createError: unknown
  detailQuery: ReturnType<typeof useQuery<AssistantConversationDetail>>
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
        {conversationsQuery.isPending ? (
          <RequestLoading label='Loading Assistant conversations…' />
        ) : conversationsQuery.isError ? (
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
                disabled={detailQuery.isFetching}
              >
                <RefreshCw className='size-4' /> Refresh history
              </Button>
            </div>
            {detailQuery.isPending ? (
              <RequestLoading label='Loading conversation history…' />
            ) : detailQuery.isError ? (
              <AssistantError
                error={detailQuery.error}
                onRetry={() => void detailQuery.refetch()}
              />
            ) : detailQuery.data ? (
              <ConversationHistory detail={detailQuery.data} />
            ) : null}

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

function ConversationHistory({
  detail,
}: {
  detail: AssistantConversationDetail
}) {
  if (!detail.messages.length) {
    return (
      <RequestEmpty
        title='Conversation is ready for questions.'
        description='Core has not recorded any messages in this conversation yet.'
      />
    )
  }
  return (
    <div className='space-y-3' aria-label='Conversation history'>
      {detail.messages.map((message) => (
        <AssistantMessageCard key={message.id} message={message} />
      ))}
      {detail.hasMore && (
        <p className='text-xs text-muted-foreground'>
          Older messages are available through the Core history pagination.
        </p>
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
