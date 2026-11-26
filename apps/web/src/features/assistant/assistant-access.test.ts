import { QueryClient } from '@tanstack/react-query'
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
    expect(() =>
      guardAssistantHistoryCache(undefined, earlierResult)
    ).toThrow()
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

  it('contains meeting creation denial without invalidating other resources', () => {
    const client = new QueryClient()
    const list = captureAssistantAccess(client)
    const existing = captureAssistantAccess(client, 'a')
    const deniedCreation = captureAssistantCreationAccess(client, 'meeting-a')
    const otherCreation = captureAssistantCreationAccess(client, 'meeting-b')
    client.setQueryData(['assistant', 'conversation', 'a', 'history'], {
      content: 'authorized',
    })
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
    expect(isAssistantAccessCurrent(client, list)).toBe(true)
    expect(isAssistantAccessCurrent(client, existing)).toBe(true)
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
