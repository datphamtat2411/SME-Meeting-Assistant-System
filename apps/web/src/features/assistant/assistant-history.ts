import type { AssistantConversation, AssistantConversationDetail, AssistantMessage } from './assistant-api'

export function uniqueConversations(
  pages: AssistantConversation[][]
): AssistantConversation[] {
  const seen = new Set<string>()
  return pages.flat().filter((conversation) => {
    if (seen.has(conversation.id)) return false
    seen.add(conversation.id)
    return true
  })
}

export function chronologicalHistoryMessages(
  pages: AssistantConversationDetail[]
): AssistantMessage[] {
  const newestCopyById = new Map<string, AssistantMessage>()
  for (const page of pages) {
    for (const message of page.messages) {
      if (
        !newestCopyById.has(message.id) ||
        message.visibility === 'SOURCE_UNAVAILABLE'
      ) {
        newestCopyById.set(message.id, message)
      }
    }
  }

  const seen = new Set<string>()
  return [...pages].reverse().flatMap((page) =>
    page.messages.flatMap((message) => {
      if (seen.has(message.id)) return []
      seen.add(message.id)
      return [newestCopyById.get(message.id) ?? message]
    })
  )
}

