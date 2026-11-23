import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  assistantConversationDetailQueryOptions,
  assistantConversationsQueryOptions,
  createAssistantConversation,
  fetchAssistantConversations,
  findAssistantTurnMessage,
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
        queryKey: ['assistant', 'conversation', conversationId],
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

  it('finds only the assistant message causally following the accepted user turn', () => {
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
  })

  it('keeps query reads non-mutating and disables automatic retries', () => {
    const listOptions = assistantConversationsQueryOptions()
    const detailOptions =
      assistantConversationDetailQueryOptions(conversationId)

    expect(listOptions.queryKey).toEqual(['assistant', 'conversations', 0, 50])
    expect(detailOptions.queryKey).toEqual([
      'assistant',
      'conversation',
      conversationId,
    ])
    expect(listOptions.retry).toBe(false)
    expect(detailOptions.retry).toBe(false)
  })
})
