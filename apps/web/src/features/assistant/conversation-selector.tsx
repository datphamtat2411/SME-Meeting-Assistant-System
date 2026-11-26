import { LoaderCircle } from 'lucide-react'
import type { CoreApiError } from '@/lib/core-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RequestEmpty, RequestLoading } from '@/components/request-state'
import type { AssistantConversation } from './assistant-api'
import { AssistantError } from './assistant-error'
import type { ConversationListQuery } from './assistant-types'
import { MeetingScopePicker } from './meeting-scope-picker'

export function ConversationSelector({
  listAccessError,
  onListAccessRetry,
  selectedMeetingReady,
  selectedMeetingError,
  onMeetingRetry,
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
  uncertainCreation,
  onLoadOlderConversations,
}: {
  listAccessError?: CoreApiError
  onListAccessRetry: () => void
  selectedMeetingReady: boolean
  selectedMeetingError?: unknown
  onMeetingRetry: () => void
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
  uncertainCreation: boolean
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
        <div className='space-y-2'>
          <MeetingScopePicker
            selectedMeetingId={selectedMeetingId}
            selectedMeetingTitle={selectedMeetingTitle}
            onMeetingChange={onMeetingChange}
          />
          {selectedMeetingError != null && (
            <AssistantError
              error={selectedMeetingError}
              onRetry={onMeetingRetry}
            />
          )}
        </div>
        <label className='space-y-1.5 text-sm font-medium'>
          <span>Conversation title (optional)</span>
          <Input
            aria-label='Conversation title'
            maxLength={255}
            value={conversationTitle}
            onChange={(event) => onConversationTitleChange(event.target.value)}
            placeholder='Questions about this meeting'
            disabled={!selectedMeetingReady || createPending}
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
            disabled={!selectedMeetingReady || createPending}
          >
            {createPending && <LoaderCircle className='size-4 animate-spin' />}
            Create conversation
          </Button>
        </div>
        {conversations.length ? (
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
      {uncertainCreation && <p role='status' className='text-sm text-muted-foreground'>The creation outcome is unresolved. Review the refreshed conversation list before creating another.</p>}
    </>
  )
}
