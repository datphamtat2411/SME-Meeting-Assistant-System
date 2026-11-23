import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi, type ApiResponseData } from '@/lib/core-api'

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
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

const messageSchema = z.object({
  id: uuidSchema,
  role: z.enum(assistantMessageRoles),
  content: z.string().nullable(),
  answerStatus: z.enum(assistantAnswerStatuses).nullable(),
  visibility: z.enum(assistantMessageVisibilities),
  claims: z.array(claimSchema),
  citations: z.array(citationSchema),
  createdAt: z.string().min(1),
})

const conversationDetailSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(messageSchema),
  page: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  hasMore: z.boolean(),
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

const conversationsPath = '/assistant/conversations'

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
  return parseAssistantResponse(
    response,
    conversationDetailSchema,
    'Core API returned a malformed Assistant conversation detail response.'
  )
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
  const size = options.size ?? 50
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
  const size = options.size ?? 50
  return queryOptions({
    queryKey: ['assistant', 'conversations', page, size] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchAssistantConversations({ page, size, signal }),
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
  return parseAssistantResponse(
    { data: response, meta: {} },
    conversationSchema,
    'Core API returned a malformed Assistant conversation response.'
  )
}

export async function fetchAssistantConversationDetail(
  conversationId: string,
  options: { signal?: AbortSignal } = {}
): Promise<AssistantConversationDetail> {
  const response = await coreApi.getWithMeta<unknown>(
    `${conversationsPath}/${encodeURIComponent(conversationId)}`,
    options.signal
      ? { params: { page: 0, size: 50 }, signal: options.signal }
      : {
          params: { page: 0, size: 50 },
        }
  )
  return parseAssistantConversationDetailResponse(response)
}

export function assistantConversationDetailQueryOptions(
  conversationId?: string
) {
  return queryOptions({
    queryKey: ['assistant', 'conversation', conversationId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchAssistantConversationDetail(conversationId as string, { signal }),
    enabled: Boolean(conversationId),
    retry: false,
  })
}

const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function codePointLength(value: string): number {
  return [...value].length
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
  const normalizedQuestion = question.trim()
  if (!normalizedQuestion || codePointLength(normalizedQuestion) > 4096) {
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

export function findAssistantTurnMessage(
  detail: AssistantConversationDetail,
  turn: Pick<AssistantTurn, 'userMessageId' | 'assistantMessageId'>
): AssistantMessage | undefined {
  if (turn.assistantMessageId) {
    return detail.messages.find(
      (message) => message.id === turn.assistantMessageId
    )
  }
  const userIndex = detail.messages.findIndex(
    (message) => message.id === turn.userMessageId
  )
  if (userIndex < 0) return undefined
  return detail.messages
    .slice(userIndex + 1)
    .find((message) => message.role === 'ASSISTANT')
}
