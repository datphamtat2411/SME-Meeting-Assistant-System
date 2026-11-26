import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { CoreApiError } from '@/lib/core-api'
import { resetRequestRecoveryState } from '@/lib/request-recovery'
import {
  assertAssistantHistoryResultCurrent,
  beginAssistantQuestion,
  captureAssistantAccess,
  captureAssistantCreationAccess,
  containAssistantAccessFailure,
  guardAssistantHistoryCache,
  invalidateAssistantHistory,
  isAssistantAccessCurrent,
  readAssistantHistoryProtected,
  readAssistantProtected,
  retryAssistantAccess,
} from './assistant-access'
import type { AssistantConversationDetail } from './assistant-api'

describe('Assistant protected operation ownership', () => {
  it('clears a denied resource and fences a previously started read and mutation', async () => {
    const client = new QueryClient()
    client.setQueryData(['assistant', 'conversation', 'a', 'history'], {
      content: 'protected',
    })
    client.setQueryData(['assistant', 'turn', 'a', 'latest-accepted'], {
      content: 'protected',
    })
    const operation = beginAssistantQuestion(client, 'a')
    let complete!: (value: string) => void
    const delayed = readAssistantProtected(
      client,
      'a',
      () =>
        new Promise<string>((resolve) => {
          complete = resolve
        })
    )
    const denied = new CoreApiError({
      status: 403,
      kind: 'http',
      message: 'Denied',
    })
    expect(
      containAssistantAccessFailure(
        client,
        captureAssistantAccess(client, 'a'),
        denied
      )
    ).toBe(true)
    expect(
      client.getQueryData(['assistant', 'conversation', 'a', 'history'])
    ).toBeUndefined()
    expect(
      client.getQueryData(['assistant', 'turn', 'a', 'latest-accepted'])
    ).toBeUndefined()
    expect(isAssistantAccessCurrent(client, operation)).toBe(false)
    retryAssistantAccess(client, 'a')
    complete('old protected response')
    await expect(delayed).rejects.toMatchObject({
      code: 'ASSISTANT_OPERATION_OBSOLETE',
    })
    expect(isAssistantAccessCurrent(client, operation)).toBe(false)
  })

  it('rejects a delayed result after the existing session generation changes', async () => {
    const client = new QueryClient()
    const operation = captureAssistantAccess(client, 'a')
    let complete!: (value: string) => void
    const pending = readAssistantProtected(
      client,
      'a',
      () =>
        new Promise<string>((resolve) => {
          complete = resolve
        })
    )
    resetRequestRecoveryState()
    complete('previous session')
    await expect(pending).rejects.toMatchObject({
      code: 'ASSISTANT_OPERATION_OBSOLETE',
    })
    expect(isAssistantAccessCurrent(client, operation)).toBe(false)
  })

  it('redacts cached history copies and rejects a delayed pre-redaction read', async () => {
    const client = new QueryClient()
    const conversation = {
      id: 'a',
      meetingId: 'meeting',
      title: null,
      status: 'ACTIVE',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }
    const visible: AssistantConversationDetail = {
      conversation,
      page: 0,
      size: 50,
      hasMore: false,
      messages: [
        {
          id: 'message',
          role: 'ASSISTANT',
          content: 'old confidential answer',
          answerStatus: 'GROUNDED',
          visibility: 'VISIBLE',
          claims: [],
          citations: [],
          createdAt: conversation.createdAt,
        },
      ],
    }
    const redacted: AssistantConversationDetail = {
      ...visible,
      messages: visible.messages.map((message) => ({
        ...message,
        content: null,
        visibility: 'SOURCE_UNAVAILABLE',
      })),
    }
    const pageKey = ['assistant', 'conversation', 'a', 'page', 0, 50]
    const historyKey = ['assistant', 'conversation', 'a', 'history', 50]
    client.setQueryData(pageKey, visible)
    client.setQueryData(historyKey, { pages: [visible], pageParams: [0] })
    let complete!: (value: AssistantConversationDetail) => void
    const pending = readAssistantHistoryProtected(
      client,
      'a',
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const earlierResult = await readAssistantHistoryProtected(
      client,
      'a',
      async () => visible
    )
    await readAssistantHistoryProtected(client, 'a', async () => redacted)
    expect(() =>
      assertAssistantHistoryResultCurrent(client, 'a', earlierResult)
    ).toThrow()
    expect(() => guardAssistantHistoryCache(undefined, earlierResult)).toThrow()
    const laterResult = await readAssistantHistoryProtected(
      client,
      'a',
      async () => visible
    )
    expect(laterResult.messages[0]?.content).toBeNull()
    expect(client.getQueryData(pageKey)).toEqual(redacted)
    expect(client.getQueryData(historyKey)).toEqual({
      pages: [redacted],
      pageParams: [0],
    })
    complete(visible)
    await expect(pending).rejects.toMatchObject({
      code: 'ASSISTANT_OPERATION_OBSOLETE',
    })
    invalidateAssistantHistory(client, 'a')
    expect(() =>
      assertAssistantHistoryResultCurrent(client, 'a', laterResult)
    ).toThrow()
  })

  it('does not restore visible content when redaction races an anchored page append', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const historyKey = [
      'assistant',
      'conversation',
      'a',
      'history',
      50,
    ] as const
    const visible: AssistantConversationDetail = {
      conversation: {
        id: 'a',
        meetingId: 'meeting',
        title: null,
        status: 'ACTIVE',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      page: 0,
      size: 50,
      hasMore: true,
      nextBeforeMessageId: 'message',
      messages: [
        {
          id: 'message',
          role: 'ASSISTANT',
          content: 'protected answer',
          answerStatus: 'GROUNDED',
          visibility: 'VISIBLE',
          claims: [],
          citations: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    }
    const redacted: AssistantConversationDetail = {
      ...visible,
      messages: visible.messages.map((message) => ({
        ...message,
        content: null,
        visibility: 'SOURCE_UNAVAILABLE',
      })),
    }
    let finish!: (value: AssistantConversationDetail) => void
    let started!: () => void
    const olderStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const older = new Promise<AssistantConversationDetail>((resolve) => {
      finish = resolve
    })
    const options = {
      queryKey: historyKey,
      initialPageParam: null as string | null,
      queryFn: ({ pageParam }: { pageParam: string | null }) =>
        readAssistantHistoryProtected(client, 'a', () => {
          if (pageParam === null) return Promise.resolve(visible)
          started()
          return older
        }),
      getNextPageParam: (page: AssistantConversationDetail) =>
        page.nextBeforeMessageId ?? undefined,
      structuralSharing: guardAssistantHistoryCache,
      retry: false as const,
    }
    await client.fetchInfiniteQuery(options)
    const observer = new InfiniteQueryObserver(client, options)
    const append = observer.fetchNextPage()
    await olderStarted
    await readAssistantHistoryProtected(client, 'a', async () => redacted)
    finish({ ...visible, hasMore: false, nextBeforeMessageId: null })
    await append
    const cached = observer.getCurrentResult().data
    expect(
      cached?.pages
        .flatMap((page) => page.messages)
        .every((message) => message.content === null)
    ).toBe(true)
    expect(cached?.pages[0]?.messages[0]?.visibility).toBe('SOURCE_UNAVAILABLE')
    observer.destroy()
    client.clear()
  })

  it('sanitizes earlier pages when a sequential refetch discovers redaction', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const historyKey = ['assistant', 'conversation', 'a', 'history', 50]
    const visible: AssistantConversationDetail = {
      conversation: {
        id: 'a',
        meetingId: 'meeting',
        title: null,
        status: 'ACTIVE',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      page: 0,
      size: 50,
      hasMore: true,
      nextBeforeMessageId: 'head',
      messages: [{
        id: 'head',
        role: 'ASSISTANT',
        content: 'current answer',
        answerStatus: 'GROUNDED',
        visibility: 'VISIBLE',
        claims: [],
        citations: [],
        createdAt: '2026-01-01T00:00:00Z',
      }],
    }
    let redact = false
    const options = {
      queryKey: historyKey,
      initialPageParam: null as string | null,
      queryFn: ({ pageParam }: { pageParam: string | null }) =>
        readAssistantHistoryProtected(client, 'a', async () =>
          pageParam === null
            ? visible
            : {
                ...visible,
                hasMore: false,
                nextBeforeMessageId: null,
                messages: visible.messages.map((message) => ({
                  ...message,
                  id: 'older',
                  content: redact ? null : 'old answer',
                  visibility: redact ? 'SOURCE_UNAVAILABLE' : 'VISIBLE',
                })),
              }
        ),
      getNextPageParam: (page: AssistantConversationDetail) =>
        page.nextBeforeMessageId ?? undefined,
      structuralSharing: guardAssistantHistoryCache,
      retry: false as const,
    }
    const observer = new InfiniteQueryObserver(client, options)
    await observer.refetch()
    await observer.fetchNextPage()
    redact = true
    const result = await observer.refetch({ throwOnError: true })
    expect(result.data?.pages).toHaveLength(2)
    expect(result.data?.pages[0]?.messages[0]?.content).toBe('current answer')
    expect(result.data?.pages[1]?.messages[0]?.content).toBeNull()
    expect(result.data?.pages[1]?.messages[0]?.visibility).toBe(
      'SOURCE_UNAVAILABLE'
    )
    const old = result.data
    invalidateAssistantHistory(client, 'a')
    expect(() => guardAssistantHistoryCache(undefined, old)).toThrow()
    observer.destroy()
    client.clear()
  })

  it('fences an in-flight history read whose meeting was not cached yet', async () => {
    const client = new QueryClient()
    let finish!: (detail: AssistantConversationDetail) => void
    const pending = readAssistantHistoryProtected(
      client,
      'a',
      () => new Promise((resolve) => { finish = resolve })
    )
    const denied = new CoreApiError({
      status: 403,
      kind: 'http',
      message: 'Denied',
    })
    containAssistantAccessFailure(
      client,
      captureAssistantCreationAccess(client, 'meeting-a'),
      denied
    )
    finish({
      conversation: {
        id: 'a',
        meetingId: 'meeting-a',
        title: null,
        status: 'ACTIVE',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      page: 0,
      size: 50,
      hasMore: false,
      messages: [],
    })
    await expect(pending).rejects.toBe(denied)
    expect(isAssistantAccessCurrent(client, captureAssistantAccess(client, 'a'))).toBe(false)
    client.clear()
  })

  it('contains meeting creation denial without invalidating other resources', () => {
    const client = new QueryClient()
    const list = captureAssistantAccess(client)
    const existing = captureAssistantAccess(client, 'a')
    const deniedCreation = captureAssistantCreationAccess(client, 'meeting-a')
    const otherCreation = captureAssistantCreationAccess(client, 'meeting-b')
    const related = { id: 'related', meetingId: 'meeting-a' }
    const unrelated = { id: 'a', meetingId: 'meeting-b' }
    const listKey = ['assistant', 'conversations', 0, 20]
    client.setQueryData(listKey, [related, unrelated])
    client.setQueryData(
      ['assistant', 'conversation', 'related', 'summary'],
      related
    )
    client.setQueryData(['assistant', 'conversation', 'a', 'history'], {
      content: 'authorized',
    })
    const relatedOperation = captureAssistantAccess(client, 'related')
    const denied = new CoreApiError({
      status: 403,
      kind: 'http',
      message: 'Denied',
    })
    expect(containAssistantAccessFailure(client, deniedCreation, denied)).toBe(
      true
    )
    expect(isAssistantAccessCurrent(client, deniedCreation)).toBe(false)
    expect(isAssistantAccessCurrent(client, otherCreation)).toBe(true)
    expect(isAssistantAccessCurrent(client, list)).toBe(false)
    expect(isAssistantAccessCurrent(client, existing)).toBe(true)
    expect(isAssistantAccessCurrent(client, relatedOperation)).toBe(false)
    expect(client.getQueryData(listKey)).toEqual([unrelated])
    expect(
      client.getQueryData(['assistant', 'conversation', 'related', 'summary'])
    ).toBeUndefined()
    expect(
      client.getQueryData(['assistant', 'conversation', 'a', 'history'])
    ).toEqual({ content: 'authorized' })
  })

  it('does not let an earlier question overwrite a newer operation', () => {
    const client = new QueryClient()
    const earlier = beginAssistantQuestion(client, 'a')
    const newer = beginAssistantQuestion(client, 'a')
    expect(isAssistantAccessCurrent(client, earlier)).toBe(false)
    expect(isAssistantAccessCurrent(client, newer)).toBe(true)
  })
})
