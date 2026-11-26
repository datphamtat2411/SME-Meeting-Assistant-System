import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  assistantAccessError,
  assistantHistoryEpoch,
  invalidateAssistantHistory,
} from './assistant-access'
import type { AssistantMessage } from './assistant-api'
import {
  evidenceWorkspaceSearch,
  readAssistantMessageEvidence,
} from './assistant-evidence-api'

const conversationId = '11111111-1111-4111-8111-111111111111'
const meetingId = '22222222-2222-4222-8222-222222222222'
const messageId = '33333333-3333-4333-8333-333333333333'
const sourceId = '44444444-4444-4444-8444-444444444444'
const message: AssistantMessage = {
  id: messageId,
  role: 'ASSISTANT',
  visibility: 'VISIBLE',
  answerStatus: 'GROUNDED',
  content: 'Answer',
  createdAt: '2026-11-26T00:00:00Z',
  claims: [
    { claimId: 'A1', text: 'Answer', support: 'SUPPORTED', citationIds: ['C1'] },
  ],
  citations: [
    {
      citationId: 'C1',
      sourceId,
      sourceType: 'DECISION',
      sourceRevision: 2,
      meetingId,
      retrievalChunkId: 'chunk',
      claimIds: ['A1'],
    },
  ],
}
const evidence = {
  citationId: 'C1',
  sourceId,
  sourceType: 'DECISION',
  sourceRevision: 2,
  label: 'Confirmed decision',
  meetingTitle: 'Planning',
  preview: 'Approved',
  claimIds: ['A1'],
  navigation: { target: 'MEETING_DECISIONS', precision: 'SOURCE' },
}
const data = { conversationId, meetingId, messageId, evidence: [evidence] }

describe('Assistant evidence boundary', () => {
  it('resolves the canonical citation and maps its source-level destination', async () => {
    const client = new QueryClient()
    const request = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValueOnce({ data, meta: {} })
    try {
      const result = await readAssistantMessageEvidence(
        client,
        conversationId,
        meetingId,
        message
      )
      expect(result.evidence).toEqual([evidence])
      expect(request).toHaveBeenCalledWith(
        `/assistant/conversations/${conversationId}/messages/${messageId}/evidence`,
        {}
      )
      expect(evidenceWorkspaceSearch(result.evidence[0])).toEqual({
        section: 'intelligence',
        intelligenceView: 'decisions',
      })
    } finally {
      request.mockRestore()
    }
  })

  it('rejects altered source identity, claim association, or navigation', async () => {
    const client = new QueryClient()
    const request = vi.spyOn(coreApi, 'getWithMeta')
    try {
      for (const changed of [
        { ...evidence, sourceRevision: 3 },
        { ...evidence, claimIds: ['foreign'] },
        { ...evidence, preview: '😀'.repeat(501) },
        {
          ...evidence,
          navigation: { target: 'MEETING_TRANSCRIPT', precision: 'SOURCE' },
        },
      ]) {
        request.mockResolvedValueOnce({
          data: { ...data, evidence: [changed] },
          meta: {},
        })
        await expect(
          readAssistantMessageEvidence(client, conversationId, meetingId, message)
        ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      }
    } finally {
      request.mockRestore()
    }
  })

  it('invalidates history on stale evidence but does not deny a scoped missing message', async () => {
    const client = new QueryClient()
    const request = vi.spyOn(coreApi, 'getWithMeta')
    const epoch = assistantHistoryEpoch(client, conversationId)
    try {
      request.mockRejectedValueOnce(
        new CoreApiError({
          status: 409,
          code: 'ASSISTANT_SOURCE_STALE',
          kind: 'http',
          message: 'Stale',
        })
      )
      await expect(
        readAssistantMessageEvidence(client, conversationId, meetingId, message)
      ).rejects.toMatchObject({ code: 'ASSISTANT_SOURCE_STALE' })
      expect(assistantHistoryEpoch(client, conversationId)).toBe(epoch + 1)
      request.mockRejectedValueOnce(
        new CoreApiError({
          status: 404,
          code: 'ASSISTANT_MESSAGE_NOT_FOUND',
          kind: 'http',
          message: 'Missing',
        })
      )
      await expect(
        readAssistantMessageEvidence(client, conversationId, meetingId, message)
      ).rejects.toMatchObject({ code: 'ASSISTANT_MESSAGE_NOT_FOUND' })
      expect(assistantAccessError(client, conversationId)).toBeUndefined()
    } finally {
      request.mockRestore()
    }
  })

  it('rejects evidence that arrives after history invalidation', async () => {
    const client = new QueryClient()
    let finish!: (value: { data: typeof data; meta: object }) => void
    const request = vi.spyOn(coreApi, 'getWithMeta').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    try {
      const pending = readAssistantMessageEvidence(
        client,
        conversationId,
        meetingId,
        message
      )
      invalidateAssistantHistory(client, conversationId)
      finish({ data, meta: {} })
      await expect(pending).rejects.toMatchObject({
        code: 'ASSISTANT_OPERATION_OBSOLETE',
      })
    } finally {
      request.mockRestore()
    }
  })
})
