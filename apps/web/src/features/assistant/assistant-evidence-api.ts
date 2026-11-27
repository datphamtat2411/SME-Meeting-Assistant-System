import { z } from 'zod'
import type { QueryClient } from '@tanstack/react-query'
import { CoreApiError, coreApi, normalizeCoreApiError } from '@/lib/core-api'
import type { MeetingWorkspaceSearch } from '@/features/meetings/meeting-workspace-navigation'
import {
  assistantHistoryEpoch,
  captureAssistantAccess,
  invalidateAssistantHistory,
  isAssistantAccessCurrent,
  readAssistantProtected,
} from './assistant-access'
import type { AssistantMessage } from './assistant-api'

const targets = {
  TRANSCRIPT: 'MEETING_TRANSCRIPT',
  SUMMARY: 'MEETING_SUMMARY',
  DECISION: 'MEETING_DECISIONS',
  ACTION_ITEM: 'MEETING_ACTION_ITEMS',
} as const

const evidenceSchema = z.object({
  citationId: z.string().min(1),
  sourceType: z.enum(['TRANSCRIPT', 'SUMMARY', 'DECISION', 'ACTION_ITEM']),
  sourceId: z.string().uuid(),
  sourceRevision: z.number().int().nonnegative(),
  label: z.string().min(1),
  meetingTitle: z.string().min(1),
  preview: z
    .string()
    .refine((text) => [...text].length <= 500)
    .nullable(),
  claimIds: z.array(z.string().min(1)),
  navigation: z.object({
    target: z.enum([
      'MEETING_TRANSCRIPT',
      'MEETING_SUMMARY',
      'MEETING_DECISIONS',
      'MEETING_ACTION_ITEMS',
    ]),
    precision: z.literal('SOURCE'),
  }),
})

const responseSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  meetingId: z.string().uuid(),
  evidence: z.array(evidenceSchema).max(64),
})

export type AssistantEvidence = z.infer<typeof evidenceSchema>
export type AssistantMessageEvidence = z.infer<typeof responseSchema>

function malformed() {
  return new CoreApiError({
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    message: 'Core returned inconsistent Assistant evidence.',
  })
}

function obsolete() {
  return new CoreApiError({
    code: 'ASSISTANT_OPERATION_OBSOLETE',
    kind: 'http',
    message: 'Assistant history changed before evidence was available.',
  })
}

/** Evidence is deliberately read on demand, not persisted or independently cached. */
export async function readAssistantMessageEvidence(
  client: QueryClient,
  conversationId: string,
  meetingId: string,
  message: AssistantMessage,
  signal?: AbortSignal
): Promise<AssistantMessageEvidence> {
  if (message.role !== 'ASSISTANT' || message.visibility !== 'VISIBLE') {
    throw obsolete()
  }
  const access = captureAssistantAccess(client, conversationId)
  const epoch = assistantHistoryEpoch(client, conversationId)
  const current = () =>
    isAssistantAccessCurrent(client, access) &&
    assistantHistoryEpoch(client, conversationId) === epoch &&
    !signal?.aborted
  try {
    const evidence = await readAssistantProtected(
      client,
      conversationId,
      async () => {
        const response = await coreApi.getWithMeta<unknown>(
          `/assistant/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(message.id)}/evidence`,
          { ...(signal ? { signal } : {}) }
        )
        const parsed = responseSchema.safeParse(response.data)
        if (!parsed.success) throw malformed()
        const result = parsed.data
        if (
          result.conversationId !== conversationId ||
          result.meetingId !== meetingId ||
          result.messageId !== message.id ||
          result.evidence.length !== message.citations.length ||
          result.evidence.some((entry, index) => {
            const citation = message.citations[index]
            return (
              citation.meetingId !== meetingId ||
              entry.citationId !== citation.citationId ||
              entry.sourceId !== citation.sourceId ||
              entry.sourceType !== citation.sourceType ||
              entry.sourceRevision !== citation.sourceRevision ||
              entry.navigation.target !== targets[entry.sourceType] ||
              (entry.sourceType === 'TRANSCRIPT' && entry.preview !== null) ||
              entry.claimIds.length !== citation.claimIds.length ||
              entry.claimIds.some((id, i) => id !== citation.claimIds[i])
            )
          })
        ) {
          throw malformed()
        }
        return result
      }
    )
    if (!current()) throw obsolete()
    return evidence
  } catch (error) {
    if (
      current() &&
      normalizeCoreApiError(error).code === 'ASSISTANT_SOURCE_STALE'
    ) {
      invalidateAssistantHistory(client, conversationId)
    }
    throw error
  }
}

export function evidenceWorkspaceSearch(
  evidence: AssistantEvidence
): MeetingWorkspaceSearch {
  switch (evidence.navigation.target) {
    case 'MEETING_TRANSCRIPT':
      return { section: 'transcript' }
    case 'MEETING_SUMMARY':
      return { section: 'intelligence', intelligenceView: 'summary' }
    case 'MEETING_DECISIONS':
      return { section: 'intelligence', intelligenceView: 'decisions' }
    case 'MEETING_ACTION_ITEMS':
      return { section: 'action-items' }
  }
}
