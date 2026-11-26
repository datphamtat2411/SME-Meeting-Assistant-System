import { LoaderCircle } from 'lucide-react'
import type { CoreApiError } from '@/lib/core-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RequestEmpty, RequestLoading } from '@/components/request-state'
import type { AssistantConversation } from './assistant-api'
import { AssistantError } from './assistant-error'
import type { ConversationListQuery } from './assistant-types'

export function ConversationSelector({
  listAccessError,
  onListAccessRetry,
  meetings,
  selectedMeetingId,
  selectedMeetingTitle,
  conversations,
  allConversations,
  conversationsQuery,
  selectedConversationId,
  conversationTitle,
  onMeetingChange,
  onConversationOpen,
  onConversationTitleChange,
  onCreate,
  createPending,
  createError,
  onLoadOlderConversations,
}: {
  listAccessError?: CoreApiError
  onListAccessRetry: () => void
  meetings: Array<{ id: string; title: string }>
  selectedMeetingId?: string
  selectedMeetingTitle?: string
  conversations: AssistantConversation[]
  allConversations: AssistantConversation[]
  conversationsQuery: ConversationListQuery
  selectedConversationId?: string
  conversationTitle: string
  onMeetingChange: (meetingId: string) => void
  onConversationOpen: (conversation: AssistantConversation) => void
  onConversationTitleChange: (title: string) => void
  onCreate: () => void
  createPending: boolean
  createError: unknown
  onLoadOlderConversations: () => void
}) {
  return listAccessError ? (
    <AssistantError error={listAccessError} onRetry={onListAccessRetry} />
  ) : conversationsQuery.isPending && !conversationsQuery.data ? (
    <RequestLoading label='Loading Assistant conversations…' />
  ) : conversationsQuery.isError && !conversationsQuery.data ? (
    <AssistantError
      error={conversationsQuery.error}
      onRetry={() => void conversationsQuery.refetch()}
    />
  ) : (
    <>
      <div className='grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'>
        <label className='space-y-1.5 text-sm font-medium'>
          <span>Meeting scope</span>
          <select
            aria-label='Assistant meeting'
            className='flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
            value={selectedMeetingId ?? ''}
            onChange={(event) => onMeetingChange(event.target.value)}
          >
            <option value=''>Select an authorized meeting</option>
            {meetings.map((meeting) => (
              <option key={meeting.id} value={meeting.id}>
                {meeting.title}
              </option>
            ))}
          </select>
        </label>
        <label className='space-y-1.5 text-sm font-medium'>
          <span>Conversation title (optional)</span>
          <Input
            aria-label='Conversation title'
            maxLength={255}
            value={conversationTitle}
            onChange={(event) =>
              onConversationTitleChange(event.target.value)
            }
            placeholder='Questions about this meeting'
            disabled={!selectedMeetingId || createPending}
          />
        </label>
      </div>

      <div className='space-y-2'>
        <div className='flex items-center justify-between gap-3'>
          <h3 className='font-semibold'>
            {selectedMeetingTitle
              ? `Conversations for ${selectedMeetingTitle}`
              : 'Existing conversations'}
          </h3>
          <Button
            type='button'
            onClick={onCreate}
            disabled={!selectedMeetingId || createPending}
          >
            {createPending && (
              <LoaderCircle className='size-4 animate-spin' />
            )}
            Create conversation
          </Button>
        </div>
        {selectedMeetingId && conversations.length ? (
          <div className='space-y-2'>
            {conversations.map((conversation) => (
              <div
                className='flex items-center justify-between gap-3 rounded-md border p-3'
                key={conversation.id}
              >
                <div className='min-w-0'>
                  <p className='truncate font-medium'>
                    {conversation.title || 'Untitled conversation'}
                  </p>
                  <p className='text-xs text-muted-foreground'>
                    {conversation.status}
                  </p>
                </div>
                <Button
                  type='button'
                  size='sm'
                  variant={
                    selectedConversationId === conversation.id
                      ? 'default'
                      : 'outline'
                  }
                  onClick={() => onConversationOpen(conversation)}
                >
                  {selectedConversationId === conversation.id
                    ? 'Opened'
                    : 'Open conversation'}
                </Button>
              </div>
            ))}
          </div>
        ) : allConversations.length && !selectedMeetingId ? (
          <RequestEmpty
            title='Select a meeting to browse conversations'
            description='Core only exposes conversations that belong to your authorized meeting scope.'
          />
        ) : (
          <RequestEmpty
            title={
              selectedMeetingId
                ? 'No conversation for this meeting'
                : 'Choose an authorized meeting'
            }
            description={
              selectedMeetingId
                ? 'Create a conversation explicitly to start asking questions.'
                : undefined
            }
          />
        )}
        {conversationsQuery.isFetchNextPageError && (
          <AssistantError
            error={conversationsQuery.error}
            onRetry={onLoadOlderConversations}
          />
        )}
        {conversationsQuery.hasNextPage && (
          <Button
            type='button'
            variant='outline'
            disabled={conversationsQuery.isFetchingNextPage}
            onClick={onLoadOlderConversations}
          >
            {conversationsQuery.isFetchingNextPage && (
              <LoaderCircle className='size-4 animate-spin' />
            )}
            {conversationsQuery.isFetchNextPageError
              ? 'Retry loading older conversations'
              : 'Load older conversations'}
          </Button>
        )}
      </div>

      {createError && <AssistantError error={createError} />}
    </>
  )
}
