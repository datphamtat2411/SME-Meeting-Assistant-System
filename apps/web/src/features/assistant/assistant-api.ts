import { z } from 'zod'
import {
  infiniteQueryOptions,
  queryOptions,
  type QueryClient,
} from '@tanstack/react-query'
import { CoreApiError, coreApi, type ApiResponseData } from '@/lib/core-api'
import {
  guardAssistantHistoryCache,
  readAssistantHistoryProtected,
  readAssistantProtected,
} from './assistant-access'

const assistantAnswerStatuses = [
  'GROUNDED',
  'PARTIAL',
  'INSUFFICIENT_EVIDENCE',
  'FAILED',
] as const

const assistantTurnStates = [
  'PROCESSING',
  'COMPLETED',
  'STALE_SOURCE',
  'FAILED',
] as const

const assistantMessageRoles = ['USER', 'ASSISTANT'] as const
const assistantMessageVisibilities = ['VISIBLE', 'SOURCE_UNAVAILABLE'] as const

const uuidSchema = z.string().uuid()
const timestampSchema = z.iso.datetime({ offset: true })
const claimSchema = z.object({
  claimId: z.string().min(1),
  text: z.string(),
  support: z.string().min(1),
  citationIds: z.array(z.string().min(1)),
})

const citationSchema = z.object({
  citationId: z.string().min(1),
  sourceType: z.string().min(1),
  sourceId: uuidSchema,
  meetingId: uuidSchema,
  sourceRevision: z.number().int().nonnegative(),
  retrievalChunkId: z.string().min(1),
  claimIds: z.array(z.string().min(1)),
})

const conversationSchema = z.object({
  id: uuidSchema,
  meetingId: uuidSchema,
  title: z.string().nullable(),
  status: z.string().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

const messageSchema = z.object({
  id: uuidSchema,
  role: z.enum(assistantMessageRoles),
  content: z.string().nullable(),
  answerStatus: z.enum(assistantAnswerStatuses).nullable(),
  visibility: z.enum(assistantMessageVisibilities),
  claims: z.array(claimSchema),
  citations: z.array(citationSchema),
  createdAt: timestampSchema,
})

const turnStatusSchema = z
  .object({
    conversationId: uuidSchema,
    turnId: uuidSchema,
    state: z.enum(assistantTurnStates),
    leaseStatus: z.enum(['ACTIVE', 'EXPIRED']).nullable(),
    userMessageId: uuidSchema,
    assistantMessageId: uuidSchema.nullable(),
    answerStatus: z.enum(assistantAnswerStatuses).nullable(),
  })
  .refine((turn) => {
    if (turn.state === 'PROCESSING') {
      return (
        turn.leaseStatus !== null &&
        turn.assistantMessageId === null &&
        turn.answerStatus === null
      )
    }
    if (
      turn.leaseStatus !== null ||
      turn.assistantMessageId === null ||
      turn.answerStatus === null
    ) {
      return false
    }
    if (turn.state === 'FAILED') return turn.answerStatus === 'FAILED'
    if (turn.state === 'STALE_SOURCE') {
      return ['GROUNDED', 'PARTIAL'].includes(turn.answerStatus)
    }
    return turn.answerStatus !== 'FAILED'
  })

const conversationDetailSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(messageSchema),
  page: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  hasMore: z.boolean(),
  nextBeforeMessageId: uuidSchema.nullable().optional(),
  pendingTurn: turnStatusSchema.nullable().optional(),
})

const turnSchema = z.object({
  turnId: uuidSchema,
  state: z.enum(assistantTurnStates),
  userMessageId: uuidSchema,
  assistantMessageId: uuidSchema.nullable(),
  answerStatus: z.enum(assistantAnswerStatuses).nullable(),
  answer: z.string().nullable(),
  claims: z.array(claimSchema),
  citations: z.array(citationSchema),
})

export type AssistantAnswerStatus = (typeof assistantAnswerStatuses)[number]
export type AssistantTurnState = (typeof assistantTurnStates)[number]
export type AssistantConversation = z.infer<typeof conversationSchema>
export type AssistantClaim = z.infer<typeof claimSchema>
export type AssistantCitation = z.infer<typeof citationSchema>
export type AssistantMessage = z.infer<typeof messageSchema>
export type AssistantConversationDetail = z.infer<
  typeof conversationDetailSchema
>
export type AssistantTurn = z.infer<typeof turnSchema>
export type AssistantTurnStatus = z.infer<typeof turnStatusSchema>

const conversationsPath = '/assistant/conversations'
export const ASSISTANT_PAGE_SIZE = 50

function malformedAssistantResponse(
  message: string,
  cause: unknown
): CoreApiError {
  return new CoreApiError({
    message,
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause,
  })
}

function parseAssistantResponse<T>(
  response: ApiResponseData<unknown>,
  schema: z.ZodType<T>,
  message: string
): T {
  const parsed = schema.safeParse(response.data)
  if (!parsed.success) throw malformedAssistantResponse(message, parsed.error)
  return parsed.data
}

export function parseAssistantConversationsResponse(
  response: ApiResponseData<unknown>
): AssistantConversation[] {
  return parseAssistantResponse(
    response,
    z.array(conversationSchema),
    'Core API returned a malformed Assistant conversation list response.'
  )
}

export function parseAssistantConversationDetailResponse(
  response: ApiResponseData<unknown>
): AssistantConversationDetail {
  const detail = parseAssistantResponse(
    response,
    conversationDetailSchema,
    'Core API returned a malformed Assistant conversation detail response.'
  )
  if (
    detail.messages.length > detail.size ||
    detail.messages.some(
      (message) =>
        message.citations.some(
          (citation) => citation.meetingId !== detail.conversation.meetingId
        ) ||
        (message.visibility === 'SOURCE_UNAVAILABLE' &&
          (message.content !== null ||
            message.claims.length > 0 ||
            message.citations.length > 0))
    ) ||
    (detail.pendingTurn &&
      (detail.pendingTurn.conversationId !== detail.conversation.id ||
        detail.pendingTurn.state !== 'PROCESSING')) ||
    (detail.nextBeforeMessageId !== undefined &&
      detail.nextBeforeMessageId !==
        (detail.hasMore ? detail.messages[0]?.id : null))
  ) {
    throw malformedAssistantResponse(
      'Core API returned inconsistent Assistant history or evidence.',
      undefined
    )
  }
  return detail
}

export function parseAssistantTurnResponse(
  response: ApiResponseData<unknown>
): AssistantTurn {
  return parseAssistantResponse(
    response,
    turnSchema,
    'Core API returned a malformed Assistant turn response.'
  )
}

export type AssistantConversationListOptions = {
  page?: number
  size?: number
  signal?: AbortSignal
}

export async function fetchAssistantConversations(
  options: AssistantConversationListOptions = {}
): Promise<AssistantConversation[]> {
  const page = options.page ?? 0
  const size = options.size ?? ASSISTANT_PAGE_SIZE
  const response = await coreApi.getWithMeta<unknown>(conversationsPath, {
    params: { page, size },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return parseAssistantConversationsResponse(response)
}

export function assistantConversationsQueryOptions(
  options: Pick<AssistantConversationListOptions, 'page' | 'size'> = {}
) {
  const page = options.page ?? 0
  const size = options.size ?? ASSISTANT_PAGE_SIZE
  return queryOptions({
    queryKey: ['assistant', 'conversations', page, size] as const,
    queryFn: ({
      signal,
      client,
    }: {
      signal: AbortSignal
      client: QueryClient
    }) =>
      readAssistantProtected(client, undefined, () =>
        fetchAssistantConversations({ page, size, signal })
      ),
    retry: false,
  })
}

export function assistantConversationsInfiniteQueryOptions(
  size = ASSISTANT_PAGE_SIZE
) {
  return infiniteQueryOptions({
    queryKey: ['assistant', 'conversations', 'pages', size] as const,
    initialPageParam: 0,
    queryFn: ({
      pageParam,
      signal,
      client,
    }: {
      pageParam: number
      signal: AbortSignal
      client: QueryClient
    }) =>
      readAssistantProtected(client, undefined, () =>
        fetchAssistantConversations({ page: pageParam, size, signal })
      ),
    getNextPageParam: (
      lastPage: AssistantConversation[],
      allPages: AssistantConversation[][]
    ) => (lastPage.length === size ? allPages.length : undefined),
    retry: false,
  })
}

export async function createAssistantConversation(
  meetingId: string,
  title?: string
): Promise<AssistantConversation> {
  const trimmedTitle = title?.trim()
  const response = await coreApi.post<unknown>(
    conversationsPath,
    trimmedTitle ? { meetingId, title: trimmedTitle } : { meetingId }
  )
  const conversation = parseAssistantResponse(
    { data: response, meta: {} },
    conversationSchema,
    'Core API returned a malformed Assistant conversation response.'
  )
  if (conversation.meetingId !== meetingId) {
    throw malformedAssistantResponse(
      'Core returned a conversation for a different meeting.',
      undefined
    )
  }
  return conversation
}

export async function fetchAssistantConversationDetail(
  conversationId: string,
  options: {
    page?: number
    size?: number
    beforeMessageId?: string
    signal?: AbortSignal
  } = {}
): Promise<AssistantConversationDetail> {
  const page = options.page ?? 0
  const size = options.size ?? ASSISTANT_PAGE_SIZE
  if (options.beforeMessageId && options.page !== undefined) {
    throw invalidAssistantInput('Use either page or beforeMessageId.')
  }
  const response = await coreApi.getWithMeta<unknown>(
    `${conversationsPath}/${encodeURIComponent(conversationId)}`,
    {
      params: options.beforeMessageId
        ? { beforeMessageId: options.beforeMessageId, size }
        : { page, size },
      ...(options.signal ? { signal: options.signal } : {}),
    }
  )
  const detail = parseAssistantConversationDetailResponse(response)
  if (
    detail.conversation.id !== conversationId ||
    detail.page !== page ||
    detail.size !== size
  ) {
    throw malformedAssistantResponse(
      'Core API returned Assistant history for a different page or conversation.',
      {
        requestedPage: page,
        requestedSize: size,
        detailPage: detail.page,
        detailSize: detail.size,
      }
    )
  }
  return detail
}

export function assistantConversationDetailQueryOptions(
  conversationId?: string,
  page = 0,
  size = ASSISTANT_PAGE_SIZE
) {
  return queryOptions({
    queryKey: [
      'assistant',
      'conversation',
      conversationId,
      'page',
      page,
      size,
    ] as const,
    queryFn: ({
      signal,
      client,
    }: {
      signal: AbortSignal
      client: QueryClient
    }) =>
      readAssistantHistoryProtected(client, conversationId as string, () =>
        fetchAssistantConversationDetail(conversationId as string, {
          page,
          size,
          signal,
        })
      ),
    enabled: Boolean(conversationId),
    structuralSharing: guardAssistantHistoryCache,
    retry: false,
  })
}

export function assistantConversationHistoryQueryOptions(
  conversationId?: string,
  size = ASSISTANT_PAGE_SIZE
) {
  return infiniteQueryOptions({
    queryKey: [
      'assistant',
      'conversation',
      conversationId,
      'history',
      size,
    ] as const,
    initialPageParam: null as string | null,
    queryFn: ({
      pageParam,
      signal,
      client,
    }: {
      pageParam: string | null
      signal: AbortSignal
      client: QueryClient
    }) =>
      readAssistantHistoryProtected(
        client,
        conversationId as string,
        async () => {
          const detail = await fetchAssistantConversationDetail(
            conversationId as string,
            {
              ...(pageParam === null ? {} : { beforeMessageId: pageParam }),
              size,
              signal,
            }
          )
          if (detail.hasMore && !detail.nextBeforeMessageId) {
            throw malformedAssistantResponse(
              'Core omitted the history continuation anchor.',
              undefined
            )
          }
          return detail
        }
      ),
    getNextPageParam: (lastPage: AssistantConversationDetail) =>
      lastPage.nextBeforeMessageId ?? undefined,
    enabled: Boolean(conversationId),
    structuralSharing: guardAssistantHistoryCache,
    retry: false,
  })
}

const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

// Match the server's existing String.trim fingerprint normalization exactly.
export function normalizeAssistantQuestion(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value.charCodeAt(start) <= 32) start += 1
  while (end > start && value.charCodeAt(end - 1) <= 32) end -= 1
  return value.slice(start, end)
}

export const ASSISTANT_QUESTION_LIMIT = 4096

export function assistantQuestionLength(value: string): number {
  return [...normalizeAssistantQuestion(value)].length
}

// Character.isWhitespace / String.isBlank in the canonical Java API.
export function isBlankAssistantQuestion(value: string): boolean {
  return [...normalizeAssistantQuestion(value)].every((character) => {
    const code = character.codePointAt(0)!
    return (
      (code >= 9 && code <= 13) ||
      (code >= 28 && code <= 32) ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x2006) ||
      (code >= 0x2008 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x205f ||
      code === 0x3000
    )
  })
}

function invalidAssistantInput(message: string): CoreApiError {
  return new CoreApiError({
    message,
    status: 422,
    code: 'INVALID_ASSISTANT_INPUT',
    kind: 'http',
  })
}

export function newAssistantIdempotencyKey(): string {
  if (typeof crypto?.randomUUID !== 'function') {
    throw new Error(
      'This browser cannot create a safe Assistant request identity.'
    )
  }
  return crypto.randomUUID()
}

export async function submitAssistantQuestion(
  conversationId: string,
  question: string,
  idempotencyKey: string,
  signal?: AbortSignal
): Promise<AssistantTurn> {
  const normalizedQuestion = normalizeAssistantQuestion(question)
  if (
    isBlankAssistantQuestion(normalizedQuestion) ||
    assistantQuestionLength(normalizedQuestion) > ASSISTANT_QUESTION_LIMIT
  ) {
    throw invalidAssistantInput(
      'Enter a nonblank Assistant question of at most 4096 characters.'
    )
  }
  if (!idempotencyKeyPattern.test(idempotencyKey)) {
    throw invalidAssistantInput('The Assistant request identity is invalid.')
  }
  const response = await coreApi.post<unknown>(
    `${conversationsPath}/${encodeURIComponent(conversationId)}/messages`,
    { question: normalizedQuestion },
    {
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal ? { signal } : {}),
    }
  )
  return parseAssistantResponse(
    { data: response, meta: {} },
    turnSchema,
    'Core API returned a malformed Assistant turn response.'
  )
}

// Explicit recovery never needs the original browser request payload.
export async function recoverAssistantTurn(
  conversationId: string,
  turnId: string,
  signal?: AbortSignal
): Promise<AssistantTurn> {
  const response = await coreApi.post<unknown>(
    `${conversationsPath}/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/recover`,
    undefined,
    { ...(signal ? { signal } : {}) }
  )
  const turn = parseAssistantResponse(
    { data: response, meta: {} },
    turnSchema,
    'Core API returned a malformed recovered Assistant turn.'
  )
  if (turn.turnId !== turnId) {
    throw malformedAssistantResponse(
      'Core API returned a different recovered Assistant turn.',
      undefined
    )
  }
  return turn
}

function parseTurnStatus(
  response: ApiResponseData<unknown>,
  conversationId: string,
  turnId?: string
): AssistantTurnStatus {
  const status = parseAssistantResponse(
    response,
    turnStatusSchema,
    'Core API returned a malformed Assistant turn status.'
  )
  if (
    status.conversationId !== conversationId ||
    (turnId !== undefined && status.turnId !== turnId)
  ) {
    throw malformedAssistantResponse(
      'Core API returned status for a different Assistant turn.',
      undefined
    )
  }
  return status
}

export async function fetchAssistantTurnStatus(
  conversationId: string,
  turnId: string,
  signal?: AbortSignal
): Promise<AssistantTurnStatus> {
  const response = await coreApi.getWithMeta<unknown>(
    `${conversationsPath}/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}`,
    { ...(signal ? { signal } : {}) }
  )
  return parseTurnStatus(response, conversationId, turnId)
}

export async function lookupAssistantTurn(
  conversationId: string,
  idempotencyKey: string,
  signal?: AbortSignal
): Promise<AssistantTurnStatus> {
  if (!idempotencyKeyPattern.test(idempotencyKey)) {
    throw invalidAssistantInput('The Assistant request identity is invalid.')
  }
  const response = await coreApi.getWithMeta<unknown>(
    `${conversationsPath}/${encodeURIComponent(conversationId)}/turns`,
    {
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal ? { signal } : {}),
    }
  )
  return parseTurnStatus(response, conversationId)
}
