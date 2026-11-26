import type { InfiniteData } from '@tanstack/react-query'
import type {
  AssistantConversation,
  AssistantConversationDetail,
} from './assistant-api'

export type Submission = {
  meetingId: string
  conversationId: string
  question: string
  idempotencyKey: string
}

export type ConversationListQuery = {
  data?: InfiniteData<AssistantConversation[]>
  isPending: boolean
  isError: boolean
  error: unknown
  refetch: () => Promise<unknown>
  hasNextPage: boolean
  isFetchingNextPage: boolean
  isFetchNextPageError: boolean
  fetchNextPage: () => Promise<unknown>
}

export type ConversationHistoryQuery = {
  data?: InfiniteData<AssistantConversationDetail>
  isPending: boolean
  isFetching: boolean
  isError: boolean
  error: unknown
  refetch: () => Promise<unknown>
  hasNextPage: boolean
  isFetchingNextPage: boolean
  isFetchNextPageError: boolean
  fetchNextPage: () => Promise<unknown>
}
