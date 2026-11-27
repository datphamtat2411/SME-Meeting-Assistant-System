import { useState } from 'react'
import { LoaderCircle, Plus } from 'lucide-react'
import type { CoreApiError } from '@/lib/core-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { RegionalTimestamp } from '@/components/regional-timestamp'
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
  createOpen,
  onCreateOpenChange,
}: {
  listAccessError?: CoreApiError
  onListAccessRetry: () => void
  selectedMeetingReady: boolean
  selectedMeetingError?: unknown
  onMeetingRetry: () => void
  selectedMeetingId?: string
  selectedMeetingTitle?: string
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
  createOpen: boolean
  onCreateOpenChange: (open: boolean) => void
}) {
  const [search, setSearch] = useState('')
  const matches = allConversations.filter((item) =>
    (item.title || 'Untitled conversation')
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase())
  )
  if (listAccessError)
    return (
      <AssistantError error={listAccessError} onRetry={onListAccessRetry} />
    )

  return (
    <div className='flex h-full min-h-0 flex-col gap-3 p-3'>
      <div className='flex items-center justify-between gap-2'>
        <h2 className='font-semibold'>Conversations</h2>
        <Dialog open={createOpen} onOpenChange={onCreateOpenChange}>
          <DialogTrigger asChild>
            <Button
              type='button'
              size='icon'
              variant='outline'
              aria-label='New conversation'
            >
              <Plus className='size-4' />
            </Button>
          </DialogTrigger>
          <DialogContent className='max-h-[90dvh] overflow-y-auto'>
            <DialogHeader>
              <DialogTitle>New conversation</DialogTitle>
              <DialogDescription>
                Choose one meeting. Questions in this conversation are limited
                to its authorized knowledge.
              </DialogDescription>
            </DialogHeader>
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
                disabled={!selectedMeetingReady || createPending}
              />
            </label>
            {createError != null && <AssistantError error={createError} />}
            {uncertainCreation && (
              <p role='status' className='text-sm text-muted-foreground'>
                The creation outcome is unresolved. Submit the same meeting and
                title to retry safely, or review the conversation list.
              </p>
            )}
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                onClick={() => onCreateOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type='button'
                onClick={onCreate}
                disabled={!selectedMeetingReady || createPending}
              >
                {createPending && (
                  <LoaderCircle className='size-4 animate-spin' />
                )}
                Create conversation
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {uncertainCreation && (
        <p role='status' className='text-xs text-muted-foreground'>
          A creation request is unresolved. Retry with the same meeting and
          title to recover it safely.
        </p>
      )}
      <Input
        aria-label='Search loaded conversations'
        placeholder='Search loaded conversations'
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {conversationsQuery.hasNextPage && (
        <p className='text-xs text-muted-foreground'>
          Search covers loaded conversations only.
        </p>
      )}
      <div className='min-h-0 flex-1 space-y-2 overflow-y-auto'>
        {conversationsQuery.isPending && !conversationsQuery.data ? (
          <RequestLoading label='Loading Assistant conversations…' />
        ) : conversationsQuery.isError && !conversationsQuery.data ? (
          <AssistantError
            error={conversationsQuery.error}
            onRetry={() => void conversationsQuery.refetch()}
          />
        ) : !matches.length ? (
          <RequestEmpty
            title={
              search
                ? 'No matching loaded conversations'
                : 'No conversations yet'
            }
            description={
              search
                ? undefined
                : 'Start a conversation to ask about a meeting.'
            }
          />
        ) : (
          matches.map((item) => (
            <Button
              key={item.id}
              type='button'
              variant={
                selectedConversationId === item.id ? 'secondary' : 'ghost'
              }
              aria-current={
                selectedConversationId === item.id ? 'true' : undefined
              }
              aria-label={
                (selectedConversationId === item.id
                  ? 'Opened: '
                  : 'Open conversation: ') +
                (item.title || 'Untitled conversation')
              }
              onClick={() => onConversationOpen(item)}
              className='h-auto w-full flex-col items-start gap-1 p-3 text-start'
            >
              <span className='w-full truncate font-medium'>
                {item.title || 'Untitled conversation'}
              </span>
              <span className='w-full truncate text-xs font-normal text-muted-foreground'>
                {selectedMeetingId === item.meetingId && selectedMeetingTitle
                  ? selectedMeetingTitle
                  : 'One meeting'}
              </span>
              <time
                className='text-xs font-normal text-muted-foreground'
                dateTime={item.updatedAt}
              >
                <RegionalTimestamp value={item.updatedAt} />
              </time>
            </Button>
          ))
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
            className='w-full'
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
    </div>
  )
}
