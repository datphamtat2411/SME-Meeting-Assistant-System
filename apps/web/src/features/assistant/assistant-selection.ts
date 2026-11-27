import { z } from 'zod'

const selectionSchema = z.object({
  meetingId: z.string().uuid().optional().catch(undefined),
  conversationId: z.string().uuid().optional().catch(undefined),
})

export type AssistantSelection = z.infer<typeof selectionSchema>

export function parseAssistantSelection(
  search: Record<string, unknown>
): AssistantSelection {
  return selectionSchema.parse(search)
}
