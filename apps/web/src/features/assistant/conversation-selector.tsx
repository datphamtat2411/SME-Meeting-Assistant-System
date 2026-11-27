import { useState } from 'react'
import { LoaderCircle, Plus } from 'lucide-react'
import type { CoreApiError } from '@/lib/core-api'
import { useUiTranslation } from '@/lib/i18n'
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
  createRetryAt,
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
  createRetryAt: number
  createError: unknown
  uncertainCreation: boolean
  onLoadOlderConversations: () => void
  createOpen: boolean
  onCreateOpenChange: (open: boolean) => void
}) {
  const { t } = useUiTranslation()
  const [search, setSearch] = useState('')
  const matches = allConversations.filter((item) =>
    (item.title || t('assistant:untitled'))
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
        <h2 className='font-semibold'>{t('assistant:conversations')}</h2>
        <Dialog open={createOpen} onOpenChange={onCreateOpenChange}>
          <DialogTrigger asChild>
            <Button
              type='button'
              size='icon'
              variant='outline'
              aria-label={t('assistant:newConversation')}
            >
              <Plus className='size-4' />
            </Button>
          </DialogTrigger>
          <DialogContent className='max-h-[90dvh] overflow-y-auto'>
            <DialogHeader>
              <DialogTitle>{t('assistant:newConversation')}</DialogTitle>
              <DialogDescription>
                {t('assistant:scopeDescription')}
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
              <span>{t('assistant:optionalTitle')}</span>
              <Input
                aria-label={t('assistant:conversationTitle')}
                maxLength={255}
                value={conversationTitle}
                onChange={(event) =>
                  onConversationTitleChange(event.target.value)
                }
                placeholder={t('assistant:titlePlaceholder')}
                disabled={!selectedMeetingReady || createPending}
              />
            </label>
            {createError != null && <AssistantError error={createError} />}
            {uncertainCreation && (
              <p role='status' className='text-sm text-muted-foreground'>
                {t('assistant:creationUnresolved')}
              </p>
            )}
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                onClick={() => onCreateOpenChange(false)}
              >
                {t('assistant:cancel')}
              </Button>
              <Button
                type='button'
                onClick={onCreate}
                disabled={
                  !selectedMeetingReady || createPending || createRetryAt > 0
                }
              >
                {createPending && (
                  <LoaderCircle className='size-4 animate-spin' />
                )}
                {t('assistant:createConversation')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {uncertainCreation && (
        <p role='status' className='text-xs text-muted-foreground'>
          {t('assistant:creationRetry')}
        </p>
      )}
      <Input
        aria-label={t('assistant:searchLoaded')}
        placeholder={t('assistant:searchLoaded')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {conversationsQuery.hasNextPage && (
        <p className='text-xs text-muted-foreground'>
          {t('assistant:searchLoadedOnly')}
        </p>
      )}
      <div className='min-h-0 flex-1 space-y-2 overflow-y-auto'>
        {conversationsQuery.isPending && !conversationsQuery.data ? (
          <RequestLoading label={t('assistant:loadingConversations')} />
        ) : conversationsQuery.isError && !conversationsQuery.data ? (
          <AssistantError
            error={conversationsQuery.error}
            onRetry={() => void conversationsQuery.refetch()}
          />
        ) : !matches.length ? (
          <RequestEmpty
            title={
              search
                ? t('assistant:noMatchingConversations')
                : t('assistant:noConversations')
            }
            description={search ? undefined : t('assistant:startHint')}
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
              aria-label={t(
                selectedConversationId === item.id
                  ? 'assistant:opened'
                  : 'assistant:openConversation',
                { title: item.title || t('assistant:untitled') }
              )}
              onClick={() => onConversationOpen(item)}
              className='h-auto w-full flex-col items-start gap-1 p-3 text-start'
            >
              <span className='w-full truncate font-medium'>
                {item.title || t('assistant:untitled')}
              </span>
              <span className='w-full truncate text-xs font-normal text-muted-foreground'>
                {selectedMeetingId === item.meetingId && selectedMeetingTitle
                  ? selectedMeetingTitle
                  : t('assistant:oneMeeting')}
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
              ? t('assistant:retryOlderConversations')
              : t('assistant:loadOlderConversations')}
          </Button>
        )}
      </div>
    </div>
  )
}
