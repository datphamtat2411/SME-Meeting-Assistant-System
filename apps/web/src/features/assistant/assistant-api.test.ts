import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  ASSISTANT_PAGE_SIZE,
  assistantConversationDetailQueryOptions,
  assistantConversationHistoryQueryOptions,
  assistantConversationsInfiniteQueryOptions,
  assistantConversationsQueryOptions,
  createAssistantConversation,
  fetchAssistantConversations,
  fetchAssistantConversationDetail,
  fetchAssistantTurnStatus,
  findAssistantTurnMessage,
  lookupAssistantTurn,
  parseAssistantConversationDetailResponse,
  parseAssistantConversationsResponse,
  parseAssistantTurnResponse,
  submitAssistantQuestion,
  type AssistantConversationDetail,
} from './assistant-api'

const meetingId = '11111111-1111-4111-8111-111111111111'
const conversationId = '22222222-2222-4222-8222-222222222222'
const userMessageId = '33333333-3333-4333-8333-333333333333'
const assistantMessageId = '44444444-4444-4444-8444-444444444444'
const sourceId = '55555555-5555-4555-8555-555555555555'

const conversation = {
  id: conversationId,
  meetingId,
  title: 'Roadmap questions',
  status: 'ACTIVE',
  createdAt: '2026-11-22T10:00:00Z',
  updatedAt: '2026-11-22T10:00:00Z',
}

const groundedMessage = {
  id: assistantMessageId,
  role: 'ASSISTANT' as const,
  content: 'The launch is planned for Friday.',
  answerStatus: 'GROUNDED' as const,
  visibility: 'VISIBLE' as const,
  claims: [
    {
      claimId: 'claim-1',
      text: 'The launch is planned for Friday.',
      support: 'SUPPORTED',
      citationIds: ['citation-1'],
    },
  ],
  citations: [
    {
      citationId: 'citation-1',
      sourceType: 'TRANSCRIPT',
      sourceId,
      meetingId,
      sourceRevision: 3,
      retrievalChunkId: 'chunk-1',
      claimIds: ['claim-1'],
    },
  ],
  createdAt: '2026-11-22T10:01:00Z',
}

const detail: AssistantConversationDetail = {
  conversation,
  messages: [
    {
      id: userMessageId,
      role: 'USER',
      content: 'When is the launch?',
      answerStatus: null,
      visibility: 'VISIBLE',
      claims: [],
      citations: [],
      createdAt: '2026-11-22T10:00:30Z',
    },
    groundedMessage,
  ],
  page: 0,
  size: 50,
  hasMore: false,
}

function success<T>(data: T) {
  return { data, meta: {} }
}

describe('Assistant Core API adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('parses the public conversation and evidence DTOs', () => {
    expect(
      parseAssistantConversationsResponse(success([conversation]))
    ).toEqual([conversation])
    expect(parseAssistantConversationDetailResponse(success(detail))).toEqual(
      detail
    )
    expect(
      parseAssistantTurnResponse(
        success({
          turnId: '66666666-6666-4666-8666-666666666666',
          state: 'COMPLETED',
          userMessageId,
          assistantMessageId,
          answerStatus: 'GROUNDED',
          answer: groundedMessage.content,
          claims: groundedMessage.claims,
          citations: groundedMessage.citations,
        })
      )
    ).toMatchObject({
      state: 'COMPLETED',
      answerStatus: 'GROUNDED',
    })
  })

  it('rejects malformed envelopes and nested Assistant DTOs', () => {
    expect(() =>
      parseAssistantConversationsResponse(
        success([{ ...conversation, id: 'bad' }])
      )
    ).toThrowError(CoreApiError)
    expect(() =>
      parseAssistantConversationDetailResponse(
        success({ ...detail, hasMore: 'false' })
      )
    ).toThrowError(/malformed Assistant conversation/i)
    expect(() =>
      parseAssistantTurnResponse(
        success({
          state: 'PROCESSING',
          userMessageId,
          claims: [],
          citations: [],
        })
      )
    ).toThrowError(CoreApiError)
  })

  it('uses the existing Core transport for list, detail, and creation', async () => {
    const get = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValueOnce(success([conversation]))
      .mockResolvedValueOnce(success(detail))
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue(conversation)
    const signal = new AbortController().signal

    await expect(
      fetchAssistantConversations({ page: 0, size: 50, signal })
    ).resolves.toEqual([conversation])
    await expect(
      assistantConversationDetailQueryOptions(conversationId).queryFn?.({
        client: new QueryClient(),
        queryKey: [
          'assistant',
          'conversation',
          conversationId,
          'page',
          0,
          ASSISTANT_PAGE_SIZE,
        ],
        signal,
        meta: undefined,
      })
    ).resolves.toEqual(detail)
    await expect(
      createAssistantConversation(meetingId, '  Project questions  ')
    ).resolves.toEqual(conversation)

    expect(get).toHaveBeenNthCalledWith(
      1,
      '/assistant/conversations',
      expect.objectContaining({
        params: { page: 0, size: 50 },
        signal,
      })
    )
    expect(get).toHaveBeenNthCalledWith(
      2,
      `/assistant/conversations/${conversationId}`,
      expect.objectContaining({ params: { page: 0, size: 50 }, signal })
    )
    expect(post).toHaveBeenCalledWith('/assistant/conversations', {
      meetingId,
      title: 'Project questions',
    })
  })

  it('requests zero-based conversation pages and treats empty or partial pages as terminal', async () => {
    const olderConversation = {
      ...conversation,
      id: '77777777-7777-4777-8777-777777777777',
    }
    const get = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValueOnce(success([conversation]))
      .mockResolvedValueOnce(success([]))
      .mockResolvedValueOnce(success([olderConversation]))

    await expect(fetchAssistantConversations({ page: 0 })).resolves.toEqual([
      conversation,
    ])
    await expect(fetchAssistantConversations({ page: 1 })).resolves.toEqual([])
    await expect(fetchAssistantConversations({ page: 2 })).resolves.toEqual([
      olderConversation,
    ])

    expect(get.mock.calls.map((call) => call[1]?.params)).toEqual([
      { page: 0, size: ASSISTANT_PAGE_SIZE },
      { page: 1, size: ASSISTANT_PAGE_SIZE },
      { page: 2, size: ASSISTANT_PAGE_SIZE },
    ])

    const options = assistantConversationsInfiniteQueryOptions(2)
    expect(
      options.getNextPageParam?.([conversation], [[conversation]], 0, [0])
    ).toBeUndefined()
    expect(options.getNextPageParam?.([], [[]], 1, [0])).toBeUndefined()
    expect(
      options.getNextPageParam?.(
        [conversation, olderConversation],
        [[conversation, olderConversation]],
        0,
        [0]
      )
    ).toBe(1)
  })

  it('fetches detail pages with the Core page contract and preserves in-page chronology', async () => {
    const olderUserMessage = {
      ...detail.messages[0]!,
      id: '77777777-7777-4777-8777-777777777777',
      content: 'Earlier question',
      createdAt: '2026-11-22T09:58:00Z',
    }
    const firstPage: AssistantConversationDetail = {
      ...detail,
      size: 2,
    }
    const olderPage: AssistantConversationDetail = {
      ...detail,
      messages: [olderUserMessage, groundedMessage],
      page: 1,
      size: 2,
      hasMore: true,
    }
    const get = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValueOnce(success(firstPage))
      .mockResolvedValueOnce(success(olderPage))
    const signal = new AbortController().signal

    await expect(
      fetchAssistantConversationDetail(conversationId, {
        page: 0,
        size: 2,
        signal,
      })
    ).resolves.toEqual(firstPage)
    await expect(
      fetchAssistantConversationDetail(conversationId, {
        page: 1,
        size: 2,
        signal,
      })
    ).resolves.toEqual(olderPage)

    expect(get.mock.calls.map((call) => call[1])).toEqual([
      { params: { page: 0, size: 2 }, signal },
      { params: { page: 1, size: 2 }, signal },
    ])
    expect(olderPage.messages.map((message) => message.createdAt)).toEqual([
      '2026-11-22T09:58:00Z',
      '2026-11-22T10:01:00Z',
    ])

    const historyOptions = assistantConversationHistoryQueryOptions(
      conversationId,
      2
    )
    expect(historyOptions.initialPageParam).toBe(0)
    expect(
      historyOptions.getNextPageParam?.(
        olderPage,
        [detail, olderPage],
        1,
        [0, 1]
      )
    ).toBe(2)
    expect(
      historyOptions.getNextPageParam?.(
        { ...olderPage, hasMore: false },
        [detail, { ...olderPage, hasMore: false }],
        1,
        [0, 1]
      )
    ).toBeUndefined()
  })

  it('reads authoritative turn status and looks up an exact request without posting', async () => {
    const turnId = '66666666-6666-4666-8666-666666666666'
    const status = {
      conversationId,
      turnId,
      state: 'PROCESSING',
      leaseStatus: 'EXPIRED',
      userMessageId,
      assistantMessageId: null,
      answerStatus: null,
    }
    const get = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValue(success(status))
    const post = vi.spyOn(coreApi, 'post')
    await expect(
      fetchAssistantTurnStatus(conversationId, turnId)
    ).resolves.toEqual(status)
    await expect(
      lookupAssistantTurn(conversationId, 'request-1')
    ).resolves.toEqual(status)
    expect(get).toHaveBeenNthCalledWith(
      2,
      `/assistant/conversations/${conversationId}/turns`,
      { headers: { 'Idempotency-Key': 'request-1' } }
    )
    expect(post).not.toHaveBeenCalled()
    get.mockResolvedValueOnce(success({ ...status, conversationId: meetingId }))
    await expect(
      fetchAssistantTurnStatus(conversationId, turnId)
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('uses an exclusive message anchor without sending an offset page', async () => {
    const get = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValue(success(detail))
    await fetchAssistantConversationDetail(conversationId, {
      beforeMessageId: assistantMessageId,
      size: 50,
    })
    expect(get).toHaveBeenCalledWith(
      `/assistant/conversations/${conversationId}`,
      { params: { beforeMessageId: assistantMessageId, size: 50 } }
    )
  })

  it('requires and forwards one caller-held idempotency key unchanged', async () => {
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue({
      turnId: '66666666-6666-4666-8666-666666666666',
      state: 'PROCESSING',
      userMessageId,
      assistantMessageId: null,
      answerStatus: null,
      answer: null,
      claims: [],
      citations: [],
    })
    const key = 'assistant-question-1'

    await submitAssistantQuestion(conversationId, '  What changed?  ', key)
    await submitAssistantQuestion(conversationId, 'What changed?', key)

    expect(post).toHaveBeenNthCalledWith(
      1,
      `/assistant/conversations/${conversationId}/messages`,
      { question: 'What changed?' },
      { headers: { 'Idempotency-Key': key } }
    )
    expect(post.mock.calls[0]?.[2]).toEqual(post.mock.calls[1]?.[2])
  })

  it('rejects invalid questions before creating a Core mutation', async () => {
    const post = vi.spyOn(coreApi, 'post')

    await expect(
      submitAssistantQuestion(conversationId, '   ', 'assistant-question-1')
    ).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_ASSISTANT_INPUT',
    })
    await expect(
      submitAssistantQuestion(conversationId, 'Valid question', 'bad key!')
    ).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_ASSISTANT_INPUT',
    })
    expect(post).not.toHaveBeenCalled()
  })

  it('accepts 4096 supplementary code points and rejects oversized questions', async () => {
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue({
      turnId: '66666666-6666-4666-8666-666666666666',
      state: 'PROCESSING',
      userMessageId,
      assistantMessageId: null,
      answerStatus: null,
      answer: null,
      claims: [],
      citations: [],
    })
    const question = '😀'.repeat(4096)
    await submitAssistantQuestion(
      conversationId,
      `  ${question}  `,
      'unicode-key'
    )
    expect(post).toHaveBeenCalledWith(
      `/assistant/conversations/${conversationId}/messages`,
      { question },
      { headers: { 'Idempotency-Key': 'unicode-key' } }
    )
    await expect(
      submitAssistantQuestion(conversationId, question + 'x', 'too-long')
    ).rejects.toMatchObject({ status: 422 })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('matches the exact assistant message ID without substituting a different response', () => {
    const laterAssistant = {
      ...groundedMessage,
      id: '77777777-7777-4777-8777-777777777777',
    }
    const withUnrelatedAnswer = {
      ...detail,
      messages: [detail.messages[0]!, laterAssistant],
    }

    expect(
      findAssistantTurnMessage(withUnrelatedAnswer, {
        userMessageId,
        assistantMessageId,
      })
    ).toBeUndefined()
    expect(
      findAssistantTurnMessage(detail, { userMessageId, assistantMessageId })
    ).toEqual(groundedMessage)
  })

  it('uses only an immediate Assistant response after the accepted user message', () => {
    const processingDetail = {
      ...detail,
      messages: detail.messages.slice(0, 1),
    }
    const processingTurn = {
      turnId: '66666666-6666-4666-8666-666666666666',
      state: 'PROCESSING',
      userMessageId,
      assistantMessageId: null,
      answerStatus: null,
      answer: null,
      claims: [],
      citations: [],
    } as const

    expect(
      findAssistantTurnMessage(processingDetail, processingTurn)
    ).toBeUndefined()
    expect(findAssistantTurnMessage(detail, processingTurn)).toEqual(
      groundedMessage
    )

    const laterTurnUser = {
      ...detail.messages[0]!,
      id: '77777777-7777-4777-8777-777777777777',
      content: 'A different user turn',
      createdAt: '2026-11-22T10:00:45Z',
    }
    const unrelatedLaterAnswer = {
      ...groundedMessage,
      id: '88888888-8888-4888-8888-888888888888',
      createdAt: '2026-11-22T10:01:00Z',
    }
    expect(
      findAssistantTurnMessage(
        {
          ...detail,
          messages: [detail.messages[0]!, laterTurnUser, unrelatedLaterAnswer],
        },
        processingTurn
      )
    ).toBeUndefined()
    expect(
      findAssistantTurnMessage(
        { ...detail, messages: [laterTurnUser, unrelatedLaterAnswer] },
        processingTurn
      )
    ).toBeUndefined()
    expect(
      findAssistantTurnMessage(
        { ...detail, page: 1, messages: [detail.messages[0]!] },
        processingTurn
      )
    ).toBeUndefined()
  })

  it('rejects malformed paginated list and history DTOs', () => {
    expect(() =>
      parseAssistantConversationsResponse(success({ items: [conversation] }))
    ).toThrowError(CoreApiError)
    expect(() =>
      parseAssistantConversationDetailResponse(success({ ...detail, page: -1 }))
    ).toThrowError(CoreApiError)
    expect(() =>
      parseAssistantConversationDetailResponse(success({ ...detail, size: 0 }))
    ).toThrowError(CoreApiError)
    expect(() =>
      parseAssistantConversationDetailResponse(
        success({ ...detail, hasMore: 1 })
      )
    ).toThrowError(CoreApiError)
  })

  it('rejects a detail response that does not identify the requested page', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue(
      success({ ...detail, page: 1 })
    )

    await expect(
      fetchAssistantConversationDetail(conversationId, { page: 0 })
    ).rejects.toMatchObject({
      kind: 'malformed',
      code: 'MALFORMED_RESPONSE',
    })
  })

  it('keeps query reads non-mutating and disables automatic retries', () => {
    const listOptions = assistantConversationsQueryOptions()
    const detailOptions =
      assistantConversationDetailQueryOptions(conversationId)
    const historyOptions =
      assistantConversationHistoryQueryOptions(conversationId)

    expect(listOptions.queryKey).toEqual(['assistant', 'conversations', 0, 50])
    expect(detailOptions.queryKey).toEqual([
      'assistant',
      'conversation',
      conversationId,
      'page',
      0,
      ASSISTANT_PAGE_SIZE,
    ])
    expect(historyOptions.queryKey).toEqual([
      'assistant',
      'conversation',
      conversationId,
      'history',
      ASSISTANT_PAGE_SIZE,
    ])
    expect(listOptions.retry).toBe(false)
    expect(detailOptions.retry).toBe(false)
    expect(historyOptions.retry).toBe(false)
  })
})
