import { useState, useSyncExternalStore } from 'react'
import { ArrowLeft, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import {
  getAuthLifecycleSnapshot,
  isAuthLifecycleBlocking,
  subscribeAuthLifecycle,
} from '@/features/auth/session/auth-lifecycle'
import type { AssistantSelection } from './assistant-selection'
import { ConversationPanel } from './conversation-panel'
import { ConversationSelector } from './conversation-selector'
import { MeetingSearchCard } from './meeting-discovery'
import { useAssistantConversation } from './use-assistant-conversation'
import {
  useAssistantMeetingContext,
  useAssistantMeetingDiscovery,
} from './use-assistant-meeting-discovery'

type SelectionProps = {
  selection: AssistantSelection
  onSelectionChange: (selection: AssistantSelection) => void
}

export function AssistantPage(props: SelectionProps) {
  const generation = useSyncExternalStore(
    subscribeAuthLifecycle,
    () => getAuthLifecycleSnapshot().generation
  )
  if (isAuthLifecycleBlocking()) return null
  return <AssistantWorkspace key={generation} {...props} />
}

function AssistantWorkspace({ selection, onSelectionChange }: SelectionProps) {
  const [view, setView] = useState<'assistant' | 'discovery'>('assistant')
  const [createOpen, setCreateOpen] = useState(false)
  const [mobileBackFor, setMobileBackFor] = useState<string>()
  const discovery = useAssistantMeetingDiscovery()
  const conversation = useAssistantConversation(selection, (next) => {
    if (next.conversationId !== selection.conversationId) {
      setCreateOpen(false)
      setMobileBackFor(undefined)
    }
    onSelectionChange(next)
  })
  const selected = useAssistantMeetingContext(conversation.selectedMeetingId)
  const active = useAssistantMeetingContext(
    conversation.panel.selectedConversation?.meetingId
  )
  const mobileChat = Boolean(
    selection.conversationId && mobileBackFor !== selection.conversationId
  )

  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main fixed fluid className='min-h-0 gap-4'>
        <div className='shrink-0 space-y-2'>
          <h1 className='flex items-center gap-2 text-xl font-bold sm:text-2xl'>
            <Bot className='size-6 text-primary' /> AI Assistant & search
          </h1>
          <p className='text-sm text-muted-foreground'>
            Ask questions grounded in one authorized meeting or find meetings by
            their metadata.
          </p>
          <nav
            aria-label='Assistant views'
            className='flex gap-2 border-b pb-2'
          >
            <Button
              type='button'
              variant={view === 'assistant' ? 'secondary' : 'ghost'}
              aria-pressed={view === 'assistant'}
              onClick={() => {
                if (view === 'discovery' && selection.conversationId)
                  conversation.panel.onRefresh()
                setView('assistant')
              }}
            >
              Assistant
            </Button>
            <Button
              type='button'
              variant={view === 'discovery' ? 'secondary' : 'ghost'}
              aria-pressed={view === 'discovery'}
              onClick={() => {
                setCreateOpen(false)
                setView('discovery')
              }}
            >
              Find meetings
            </Button>
          </nav>
        </div>
        {view === 'assistant' ? (
          <div className='flex min-h-0 flex-1 overflow-hidden rounded-xl border bg-card'>
            <aside
              className={
                (mobileChat ? 'hidden md:flex' : 'flex') +
                ' min-h-0 w-full flex-col md:w-72 md:shrink-0 md:border-e xl:w-80'
              }
            >
              <ConversationSelector
                {...conversation.selector}
                selectedMeetingTitle={selected.meeting?.title}
                selectedMeetingReady={Boolean(selected.meeting)}
                selectedMeetingError={selected.query.error}
                onMeetingRetry={() => void selected.query.refetch()}
                createOpen={createOpen}
                onCreateOpenChange={setCreateOpen}
                onConversationOpen={(item) => {
                  setMobileBackFor(undefined)
                  conversation.selector.onConversationOpen(item)
                }}
              />
            </aside>
            <section
              className={
                (mobileChat ? 'flex' : 'hidden md:flex') +
                ' min-h-0 min-w-0 flex-1 flex-col'
              }
            >
              {selection.conversationId && (
                <div className='border-b p-2 md:hidden'>
                  <Button
                    type='button'
                    size='sm'
                    variant='ghost'
                    onClick={() => setMobileBackFor(selection.conversationId)}
                  >
                    <ArrowLeft className='size-4' /> Conversations
                  </Button>
                </div>
              )}
              {selection.conversationId ? (
                <ConversationPanel
                  key={selection.conversationId}
                  {...conversation.panel}
                  selectedMeetingTitle={active.meeting?.title}
                />
              ) : (
                <div className='flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center'>
                  <Bot className='size-12 text-muted-foreground' />
                  <h2 className='text-xl font-semibold'>Ask about a meeting</h2>
                  <p className='max-w-md text-sm text-muted-foreground'>
                    Open an existing conversation or select an authorized
                    meeting to start asking questions.
                  </p>
                  <Button
                    type='button'
                    onClick={() => setCreateOpen(true)}
                    disabled={Boolean(conversation.selector.listAccessError)}
                  >
                    Start a conversation
                  </Button>
                </div>
              )}
            </section>
          </div>
        ) : (
          <div className='min-h-0 flex-1 overflow-y-auto'>
            <MeetingSearchCard
              discovery={discovery}
              selectedMeetingId={conversation.selectedMeetingId}
              onMeetingSelect={(id) => {
                conversation.selectMeeting(id)
                if (selection.conversationId) conversation.panel.onRefresh()
                setMobileBackFor(selection.conversationId)
                setCreateOpen(true)
                setView('assistant')
              }}
            />
          </div>
        )}
      </Main>
    </>
  )
}
