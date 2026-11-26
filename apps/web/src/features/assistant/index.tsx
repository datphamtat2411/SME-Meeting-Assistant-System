import { useSyncExternalStore } from 'react'
import type { AssistantSelection } from './assistant-selection'
import { Bot } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import {
  getAuthLifecycleSnapshot,
  isAuthLifecycleBlocking,
  subscribeAuthLifecycle,
} from '@/features/auth/session/auth-lifecycle'
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
  const discovery = useAssistantMeetingDiscovery()
  const conversation = useAssistantConversation(selection, onSelectionChange)
  const selected = useAssistantMeetingContext(conversation.selectedMeetingId)
  const active = useAssistantMeetingContext(
    conversation.panel.selectedConversation?.meetingId
  )

  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='space-y-6'>
        <div>
          <p className='text-sm font-medium text-primary'>
            Knowledge discovery
          </p>
          <h1 className='flex items-center gap-2 text-3xl font-bold'>
            <Bot className='size-7' /> AI Assistant & search
          </h1>
          <p className='mt-2 text-muted-foreground'>
            Ask questions about an authorized meeting through the Core
            Assistant, or search meeting metadata.
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-2'>
              <Bot className='size-5 text-primary' /> Assistant conversations
            </CardTitle>
            <p className='text-sm text-muted-foreground'>
              Conversations are owned by Core and remain bound to one authorized
              meeting.
            </p>
          </CardHeader>
          <CardContent className='space-y-5'>
            <ConversationSelector
              {...conversation.selector}
              selectedMeetingTitle={selected.meeting?.title}
              selectedMeetingReady={Boolean(selected.meeting)}
              selectedMeetingError={selected.query.error}
              onMeetingRetry={() => void selected.query.refetch()}
            />
            <ConversationPanel
              {...conversation.panel}
              selectedMeetingTitle={active.meeting?.title}
            />
          </CardContent>
        </Card>
        <MeetingSearchCard
          discovery={discovery}
          selectedMeetingId={conversation.selectedMeetingId}
          onMeetingSelect={conversation.selectMeeting}
        />
      </Main>
    </>
  )
}
