import { useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  CalendarClock,
  ExternalLink,
  FileText,
  ListChecks,
  Plus,
  Search as SearchIcon,
  Send,
  Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import {
  actionItems,
  assistantConversations,
  currentDemoUser,
  getMeetingById,
  getMemberById,
  keyDecisions,
  meetingSummaries,
  members,
  ragSources,
  type AssistantMessage,
  type RagSource,
} from '@/features/meetings/data'

const suggestedQuestions = [
  'Những quyết định quan trọng gần đây là gì?',
  'Ai đang phụ trách các đầu việc chưa hoàn thành?',
  'Những deadline nào được thống nhất gần đây?',
  'Tôi còn những action item nào chưa hoàn thành?',
]

const sourceTypeLabels: Record<RagSource['sourceType'], string> = {
  transcript: 'Transcript',
  summary: 'Summary',
  decision: 'Decision',
  action_item: 'Action item',
}

const dateFormatter = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Asia/Ho_Chi_Minh',
})

const timeFormatter = new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Ho_Chi_Minh',
})

export function AssistantPage() {
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null)
  const [newConversationMessages, setNewConversationMessages] = useState<
    AssistantMessage[]
  >([])
  const [question, setQuestion] = useState('')
  const [search, setSearch] = useState('')
  const [mobileConversationOpen, setMobileConversationOpen] = useState(false)

  const selectedConversation = assistantConversations.find(
    (conversation) => conversation.id === selectedConversationId
  )
  const messages = selectedConversation?.messages ?? newConversationMessages
  const filteredConversations = assistantConversations.filter((conversation) =>
    conversation.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  )

  const startNewConversation = () => {
    setSelectedConversationId(null)
    setNewConversationMessages([])
    setQuestion('')
    setMobileConversationOpen(true)
  }

  const selectConversation = (conversationId: string) => {
    setSelectedConversationId(conversationId)
    setMobileConversationOpen(true)
  }

  const askQuestion = (value: string) => {
    const trimmedQuestion = value.trim()
    if (!trimmedQuestion) return

    const requestId = `${Date.now()}`
    const response = resolveQuestion(trimmedQuestion)
    setSelectedConversationId(null)
    setNewConversationMessages((currentMessages) => [
      ...currentMessages,
      {
        id: `question-${requestId}`,
        conversationId: 'conversation-current',
        role: 'user',
        content: trimmedQuestion,
        createdAt: new Date().toISOString(),
      },
      {
        id: `answer-${requestId}`,
        conversationId: 'conversation-current',
        role: 'assistant',
        content: response.content,
        createdAt: new Date(Date.now() + 1000).toISOString(),
        sourceIds: response.sourceIds,
      },
    ])
    setQuestion('')
    setMobileConversationOpen(true)
  }

  const submitQuestion = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    askQuestion(question)
  }

  return (
    <>
      <Header fixed>
        <Search className='me-auto' />
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </Header>

      <Main fixed className='gap-4 sm:gap-6'>
        <div className='flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between'>
          <div>
            <p className='text-sm font-medium text-primary'>Meeting knowledge</p>
            <h1 className='text-2xl font-bold tracking-tight sm:text-3xl'>
              AI Assistant
            </h1>
            <p className='mt-1 max-w-2xl text-sm text-muted-foreground'>
              Ask grounded questions across completed meetings, decisions,
              transcripts, and follow-up work.
            </p>
          </div>
          <Badge variant='outline' className='w-fit gap-1.5'>
            <Sparkles className='size-3.5 text-primary' />
            Meeting knowledge only
          </Badge>
        </div>

        <section className='relative grid min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-sm md:grid-cols-[280px_minmax(0,1fr)]'>
          <aside
            className={cn(
              'flex min-h-0 flex-col border-e bg-muted/20',
              mobileConversationOpen && 'hidden md:flex'
            )}
          >
            <div className='space-y-3 p-4'>
              <div className='flex items-center justify-between gap-2'>
                <div>
                  <p className='font-semibold'>Recent Conversations</p>
                  <p className='text-xs text-muted-foreground'>
                    Meeting-focused history
                  </p>
                </div>
                <Button
                  size='icon'
                  variant='outline'
                  aria-label='New conversation'
                  onClick={startNewConversation}
                >
                  <Plus />
                </Button>
              </div>
              <label className='flex h-9 items-center rounded-md border bg-background px-2 focus-within:ring-2 focus-within:ring-ring/50'>
                <SearchIcon className='me-2 size-4 text-muted-foreground' />
                <span className='sr-only'>Search conversations</span>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder='Search conversations...'
                  className='min-w-0 flex-1 bg-transparent text-sm outline-none'
                />
              </label>
            </div>
            <Separator />
            <ScrollArea className='min-h-0 flex-1'>
              <div className='space-y-1 p-2'>
                {filteredConversations.map((conversation) => {
                  const lastMessage =
                    conversation.messages[conversation.messages.length - 1]
                  const isGlobal = !conversation.meetingId

                  return (
                    <button
                      key={conversation.id}
                      type='button'
                      className={cn(
                        'w-full rounded-lg p-3 text-start transition-colors hover:bg-accent',
                        selectedConversationId === conversation.id && 'bg-accent'
                      )}
                      onClick={() => selectConversation(conversation.id)}
                    >
                      <span className='flex items-center gap-2'>
                        {isGlobal ? (
                          <Sparkles className='size-4 shrink-0 text-primary' />
                        ) : (
                          <FileText className='size-4 shrink-0 text-muted-foreground' />
                        )}
                        <span className='truncate text-sm font-medium'>
                          {conversation.title}
                        </span>
                      </span>
                      <span className='mt-1.5 line-clamp-2 block text-xs leading-5 text-muted-foreground'>
                        {lastMessage?.content}
                      </span>
                      <Badge variant='secondary' className='mt-2 text-[10px]'>
                        {isGlobal ? 'Cross-meeting' : 'One meeting'}
                      </Badge>
                    </button>
                  )
                })}
              </div>
            </ScrollArea>
          </aside>

          <div
            className={cn(
              'min-h-0 flex-col bg-background md:flex',
              mobileConversationOpen ? 'flex' : 'hidden'
            )}
          >
            <div className='flex items-center gap-3 border-b px-4 py-3 sm:px-5'>
              <Button
                size='icon'
                variant='ghost'
                className='md:hidden'
                aria-label='Back to conversations'
                onClick={() => setMobileConversationOpen(false)}
              >
                <ArrowLeft />
              </Button>
              <div className='flex size-9 items-center justify-center rounded-full bg-primary/10'>
                <Sparkles className='size-4 text-primary' />
              </div>
              <div className='min-w-0'>
                <p className='truncate font-semibold'>
                  {selectedConversation?.title ?? 'New conversation'}
                </p>
                <p className='text-xs text-muted-foreground'>
                  Answers are limited to available meeting evidence
                </p>
              </div>
            </div>

            <ScrollArea className='min-h-0 flex-1'>
              {messages.length ? (
                <div className='mx-auto max-w-4xl space-y-5 p-4 sm:p-6'>
                  {messages.map((message) => (
                    <MessageBubble key={message.id} message={message} />
                  ))}
                </div>
              ) : (
                <EmptyAssistantState onQuestion={askQuestion} />
              )}
            </ScrollArea>

            <div className='border-t bg-background p-3 sm:p-4'>
              <form
                onSubmit={submitQuestion}
                className='mx-auto flex max-w-4xl items-end gap-2 rounded-xl border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40'
              >
                <Textarea
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      askQuestion(question)
                    }
                  }}
                  rows={1}
                  placeholder='Ask about decisions, owners, deadlines, or action items...'
                  aria-label='Ask about meeting knowledge'
                  className='min-h-10 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent'
                />
                <Button size='icon' type='submit' disabled={!question.trim()}>
                  <Send />
                  <span className='sr-only'>Send question</span>
                </Button>
              </form>
              <p className='mx-auto mt-2 max-w-4xl text-center text-[11px] text-muted-foreground'>
                Prototype answers use deterministic shared meeting data. No
                external knowledge or AI service is queried.
              </p>
            </div>
          </div>

        </section>
      </Main>
    </>
  )
}

function EmptyAssistantState({
  onQuestion,
}: {
  onQuestion: (question: string) => void
}) {
  return (
    <div className='mx-auto flex min-h-full max-w-4xl flex-col items-center justify-center px-4 py-10 text-center sm:py-16'>
      <div className='flex size-14 items-center justify-center rounded-2xl bg-primary/10'>
        <Sparkles className='size-6 text-primary' />
      </div>
      <h2 className='mt-5 text-xl font-semibold'>Ask about your meeting knowledge</h2>
      <p className='mt-2 max-w-xl text-sm leading-6 text-muted-foreground'>
        Find decisions, owners, deadlines, and outcomes across completed
        meetings. Every meaningful answer links back to supporting evidence.
      </p>
      <div className='mt-7 grid w-full gap-2 sm:grid-cols-2'>
        {suggestedQuestions.map((suggestion, index) => (
          <button
            key={suggestion}
            type='button'
            className='flex items-start gap-3 rounded-lg border bg-card p-3 text-start text-sm transition-colors hover:bg-accent'
            onClick={() => onQuestion(suggestion)}
          >
            {index === 0 ? (
              <Sparkles className='mt-0.5 size-4 shrink-0 text-primary' />
            ) : index === 2 ? (
              <CalendarClock className='mt-0.5 size-4 shrink-0 text-primary' />
            ) : (
              <ListChecks className='mt-0.5 size-4 shrink-0 text-primary' />
            )}
            <span className='leading-5'>{suggestion}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function MessageBubble({ message }: { message: AssistantMessage }) {
  const isUser = message.role === 'user'
  const sources = (message.sourceIds ?? [])
    .map((sourceId) => ragSources.find((source) => source.id === sourceId))
    .filter((source): source is RagSource => Boolean(source))

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-3xl rounded-2xl px-4 py-3',
          isUser
            ? 'rounded-br-sm bg-primary text-primary-foreground'
            : 'rounded-bl-sm border bg-card shadow-sm'
        )}
      >
        <div className='flex items-center justify-between gap-5 text-xs opacity-70'>
          <span className='font-medium'>{isUser ? 'You' : 'Meeting Assistant'}</span>
          <span>{timeFormatter.format(new Date(message.createdAt))}</span>
        </div>
        <p className='mt-2 whitespace-pre-line text-sm leading-6'>{message.content}</p>
        {sources.length > 0 && (
          <div className='mt-4 space-y-2 border-t border-current/10 pt-3'>
            <p className='text-xs font-semibold opacity-75'>Supporting evidence</p>
            {sources.map((source) => (
              <SourceReference key={source.id} source={source} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SourceReference({ source }: { source: RagSource }) {
  const meeting = getMeetingById(source.meetingId)
  if (!meeting) return null

  return (
    <Button
      asChild
      variant='outline'
      className='h-auto w-full justify-start whitespace-normal bg-background/80 p-3 text-start'
    >
      <Link to='/meetings/$meetingId' params={{ meetingId: meeting.id }}>
        <span className='min-w-0 flex-1 space-y-1'>
          <span className='flex flex-wrap items-center gap-2'>
            <span className='truncate text-xs font-semibold'>{meeting.title}</span>
            <Badge variant='secondary' className='text-[10px]'>
              {sourceTypeLabels[source.sourceType]}
            </Badge>
            <span className='font-mono text-[10px] text-muted-foreground'>
              {formatTimestamp(source.timestampMs)}
            </span>
          </span>
          <span className='line-clamp-2 block text-xs leading-5 text-muted-foreground'>
            {source.excerpt}
          </span>
        </span>
        <ExternalLink className='ms-2 size-3.5 shrink-0 text-muted-foreground' />
      </Link>
    </Button>
  )
}

function resolveQuestion(question: string): {
  content: string
  sourceIds?: string[]
} {
  const normalized = normalizeText(question)
  const savedQuestion = assistantConversations
    .flatMap((conversation) => conversation.messages)
    .find(
      (message) =>
        message.role === 'user' && normalizeText(message.content) === normalized
    )

  if (savedQuestion) {
    const conversation = assistantConversations.find(
      (item) => item.id === savedQuestion.conversationId
    )
    const questionIndex = conversation?.messages.findIndex(
      (message) => message.id === savedQuestion.id
    )
    const answer =
      questionIndex !== undefined && questionIndex >= 0
        ? conversation?.messages[questionIndex + 1]
        : undefined
    if (answer?.role === 'assistant') {
      return { content: answer.content, sourceIds: answer.sourceIds }
    }
  }

  if (normalized.includes('quyet dinh')) {
    const decisions = keyDecisions.filter((decision) =>
      getMeetingById(decision.meetingId)?.status === 'completed'
    )
    const sourceIds = decisions
      .map((decision) =>
        ragSources.find(
          (source) =>
            source.meetingId === decision.meetingId &&
            source.segmentId === decision.sourceSegmentId
        )
      )
      .filter((source): source is RagSource => Boolean(source))
      .map((source) => source.id)

    return {
      content: `Các cuộc họp đã ghi nhận ${decisions.length} quyết định. Nổi bật:\n${decisions
        .slice(0, 5)
        .map((decision) => `• ${decision.text}`)
        .join('\n')}`,
      sourceIds: Array.from(new Set(sourceIds)).slice(0, 5),
    }
  }

  if (
    normalized.includes('toi') &&
    (normalized.includes('action item') || normalized.includes('dau viec'))
  ) {
    const openItems = actionItems.filter(
      (item) =>
        item.assigneeId === currentDemoUser.id && item.status !== 'done'
    )
    return {
      content: `${currentDemoUser.name} còn ${openItems.length} đầu việc chưa hoàn thành:\n${openItems
        .map(
          (item) =>
            `• ${item.title} — hạn ${formatDate(item.dueDate)} (${getMeetingById(item.meetingId)?.title ?? 'Cuộc họp không xác định'})`
        )
        .join('\n')}`,
      sourceIds: getActionItemSourceIds(openItems),
    }
  }

  if (normalized.includes('deadline') || normalized.includes('han')) {
    const openItems = [...actionItems]
      .filter((item) => item.status !== 'done')
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 6)
    return {
      content: `Các deadline gần nhất trong dữ liệu cuộc họp:\n${openItems
        .map(
          (item) =>
            `• ${formatDate(item.dueDate)} — ${item.title} (${getMemberById(item.assigneeId)?.name ?? 'Chưa phân công'})`
        )
        .join('\n')}`,
      sourceIds: getActionItemSourceIds(openItems),
    }
  }

  if (normalized.includes('phu trach') || normalized.includes('trach nhiem')) {
    const openItems = actionItems.filter((item) => item.status !== 'done')
    const grouped = members
      .map((member) => ({
        member,
        items: openItems.filter((item) => item.assigneeId === member.id),
      }))
      .filter(({ items }) => items.length)
    return {
      content: `Các đầu việc mở đang được phân công như sau:\n${grouped
        .map(
          ({ member, items }) =>
            `• ${member.name}: ${items.map((item) => item.title).join('; ')}`
        )
        .join('\n')}`,
      sourceIds: getActionItemSourceIds(openItems).slice(0, 5),
    }
  }

  if (normalized.includes('phan hoi khach hang')) {
    const summary = meetingSummaries.find(
      (item) => item.meetingId === 'meeting-02-customer-feedback'
    )
    return {
      content: summary
        ? `${summary.overview} Các điểm chính: ${summary.highlights.join(' ')}`
        : 'Chưa có bản tóm tắt phản hồi khách hàng trong dữ liệu cuộc họp.',
      sourceIds: ['rag-customer-decision'],
    }
  }

  return {
    content:
      'Prototype này chỉ hỗ trợ câu hỏi liên quan đến kiến thức cuộc họp trong dữ liệu demo hiện có. Hãy thử một câu hỏi gợi ý về quyết định, người phụ trách, deadline hoặc action item.',
  }
}

function getActionItemSourceIds(items: typeof actionItems) {
  return Array.from(
    new Set(
      items
        .map((item) =>
          ragSources.find(
            (source) =>
              source.sourceType === 'action_item' &&
              source.meetingId === item.meetingId &&
              source.segmentId === item.sourceSegmentId
          )
        )
        .filter((source): source is RagSource => Boolean(source))
        .map((source) => source.id)
    )
  )
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLocaleLowerCase()
    .trim()
}

function formatDate(date: string) {
  return dateFormatter.format(new Date(`${date}T12:00:00+07:00`))
}

function formatTimestamp(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
