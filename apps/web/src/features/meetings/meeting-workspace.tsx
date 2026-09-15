import { useEffect, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  CalendarDays,
  ChevronDown,
  Clock3,
  Download,
  FileText,
  ListChecks,
  MapPin,
  MessageSquare,
  Send,
  Sparkles,
  UserRound,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import {
  assistantConversations,
  getActionItemsByMeetingId,
  getMeetingById,
  getMemberById,
  getRoomById,
  getTranscriptByMeetingId,
  keyDecisions,
  meetingSummaries,
  ragSources,
  type ActionItem,
  type AssistantMessage,
  type KeyDecision,
  type Meeting,
  type MeetingRoom,
  type Member,
  type MeetingStatus,
  type RagSource,
  type TranscriptSegment,
} from './data'

type WorkspaceTab = 'overview' | 'transcript' | 'action-items' | 'ask-ai'

const timeZone = 'Asia/Ho_Chi_Minh'
const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone,
})
const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone,
})

const statusLabels: Record<MeetingStatus, string> = {
  scheduled: 'Upcoming',
  in_progress: 'Live',
  processing: 'Processing',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

const statusStyles: Record<MeetingStatus, string> = {
  scheduled:
    'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300',
  in_progress:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  processing:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  completed:
    'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300',
  cancelled:
    'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
}

const sourceTypeLabels: Record<RagSource['sourceType'], string> = {
  transcript: 'Transcript',
  summary: 'Summary',
  decision: 'Decision',
  action_item: 'Action item',
}

const actionStatusLabels: Record<ActionItem['status'], string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
}

const actionStatusStyles: Record<ActionItem['status'], string> = {
  todo: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300',
  in_progress:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  done: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
}

const priorityLabels: Record<ActionItem['priority'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

const priorityStyles: Record<ActionItem['priority'], string> = {
  low: 'border-slate-200 text-slate-600 dark:border-slate-800 dark:text-slate-400',
  medium: 'border-sky-200 text-sky-700 dark:border-sky-900 dark:text-sky-300',
  high: 'border-red-200 text-red-700 dark:border-red-900 dark:text-red-300',
}

export function MeetingWorkspacePage({ meetingId }: { meetingId: string }) {
  const meeting = getMeetingById(meetingId)

  return (
    <>
      <Header fixed>
        <Search className='me-auto' />
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </Header>

      <Main className='flex flex-1 flex-col gap-6'>
        <Button asChild variant='ghost' className='-ms-3 w-fit'>
          <Link to='/meetings'>
            <ArrowLeft />
            Back to Meetings
          </Link>
        </Button>

        {meeting ? <MeetingWorkspace meeting={meeting} /> : <MeetingNotFound />}
      </Main>
    </>
  )
}

function MeetingWorkspace({ meeting }: { meeting: Meeting }) {
  const participants = meeting.participantIds
    .map((memberId) => getMemberById(memberId))
    .filter((member): member is Member => Boolean(member))
  const organizer = getMemberById(meeting.organizerId)
  const room = getRoomById(meeting.roomId)
  const summary = meetingSummaries.find(
    (meetingSummary) => meetingSummary.meetingId === meeting.id
  )
  const decisions = keyDecisions.filter(
    (decision) => decision.meetingId === meeting.id
  )
  const transcript = getTranscriptByMeetingId(meeting.id)
  const meetingActionItems = getActionItemsByMeetingId(meeting.id)
  const conversation = assistantConversations.find(
    (assistantConversation) => assistantConversation.meetingId === meeting.id
  )
  const meetingSources = ragSources.filter(
    (source) => source.meetingId === meeting.id
  )
  const speakerMappings = getSpeakerMappings(transcript)

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('overview')
  const [highlightedSegmentId, setHighlightedSegmentId] = useState<
    string | null
  >(null)
  const [assistantMessages, setAssistantMessages] = useState<
    AssistantMessage[]
  >(() => conversation?.messages ?? [])

  useEffect(() => {
    if (activeTab !== 'transcript' || !highlightedSegmentId) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      document
        .getElementById(`transcript-${highlightedSegmentId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 0)
    const clearHighlightId = window.setTimeout(
      () => setHighlightedSegmentId(null),
      2200
    )

    return () => {
      window.clearTimeout(timeoutId)
      window.clearTimeout(clearHighlightId)
    }
  }, [activeTab, highlightedSegmentId])

  const viewTranscriptSegment = (segmentId: string) => {
    setHighlightedSegmentId(segmentId)
    setActiveTab('transcript')
  }

  const askQuestion = (question: string) => {
    const normalizedQuestion = question.trim().toLocaleLowerCase()
    if (!normalizedQuestion) {
      return
    }

    if (!conversation) {
      toast.info('No saved demo answer is available for this meeting yet.')
      return
    }

    const questionIndex = conversation.messages.findIndex(
      (message) =>
        message.role === 'user' &&
        message.content.trim().toLocaleLowerCase() === normalizedQuestion
    )
    const savedQuestion =
      questionIndex >= 0 ? conversation.messages[questionIndex] : undefined
    const savedAnswer =
      savedQuestion &&
      conversation.messages[questionIndex + 1]?.role === 'assistant'
        ? conversation.messages[questionIndex + 1]
        : undefined

    if (!savedQuestion || !savedAnswer) {
      toast.error('Choose one of the supported questions for this meeting.')
      return
    }

    const requestId = `${Date.now()}`
    const createdAt = new Date().toISOString()
    setAssistantMessages((messages) => [
      ...messages,
      {
        ...savedQuestion,
        id: `${conversation.id}-question-${requestId}`,
        createdAt,
      },
      {
        ...savedAnswer,
        id: `${conversation.id}-answer-${requestId}`,
        createdAt: new Date(Date.now() + 1000).toISOString(),
      },
    ])
  }

  if (meeting.status !== 'completed') {
    return (
      <>
        <MeetingHeader
          meeting={meeting}
          organizer={organizer}
          participants={participants}
          room={room}
        />
        <LifecycleState meeting={meeting} />
      </>
    )
  }

  return (
    <>
      <MeetingHeader
        meeting={meeting}
        organizer={organizer}
        participants={participants}
        room={room}
        summary={summary}
        decisions={decisions}
        meetingActionItems={meetingActionItems}
      />

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as WorkspaceTab)}
        className='gap-6'
      >
        <TabsList className='h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b bg-transparent p-0'>
          <TabsTrigger
            value='overview'
            className='min-w-28 rounded-none border-b-2 border-transparent py-3 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none'
          >
            <Sparkles />
            Overview
          </TabsTrigger>
          <TabsTrigger
            value='transcript'
            className='min-w-28 rounded-none border-b-2 border-transparent py-3 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none'
          >
            <MessageSquare />
            Transcript
          </TabsTrigger>
          <TabsTrigger
            value='action-items'
            className='min-w-28 rounded-none border-b-2 border-transparent py-3 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none'
          >
            <ListChecks />
            Action Items
          </TabsTrigger>
          <TabsTrigger
            value='ask-ai'
            className='min-w-28 rounded-none border-b-2 border-transparent py-3 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none'
          >
            <Sparkles />
            Ask AI
          </TabsTrigger>
        </TabsList>

        <TabsContent value='overview'>
          <OverviewTab
            meeting={meeting}
            organizer={organizer}
            participants={participants}
            room={room}
            summary={summary}
            decisions={decisions}
            onViewSource={viewTranscriptSegment}
          />
        </TabsContent>
        <TabsContent value='transcript'>
          <TranscriptTab
            segments={transcript}
            speakerMappings={speakerMappings}
            highlightedSegmentId={highlightedSegmentId}
          />
        </TabsContent>
        <TabsContent value='action-items'>
          <ActionItemsTab
            actionItems={meetingActionItems}
            onViewSource={viewTranscriptSegment}
          />
        </TabsContent>
        <TabsContent value='ask-ai'>
          <AskAiTab
            meeting={meeting}
            conversation={conversation}
            messages={assistantMessages}
            sources={meetingSources}
            onAskQuestion={askQuestion}
            onViewSource={viewTranscriptSegment}
          />
        </TabsContent>
      </Tabs>
    </>
  )
}

function MeetingHeader({
  meeting,
  organizer,
  participants,
  room,
  summary,
  decisions,
  meetingActionItems,
}: {
  meeting: Meeting
  organizer?: Member
  participants: Member[]
  room?: MeetingRoom
  summary?: (typeof meetingSummaries)[number]
  decisions?: KeyDecision[]
  meetingActionItems?: ActionItem[]
}) {
  return (
    <section className='space-y-5'>
      <div className='flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between'>
        <div className='min-w-0 space-y-3'>
          <div className='flex flex-wrap items-center gap-2'>
            <MeetingStatusBadge status={meeting.status} />
            {meeting.status === 'completed' && (
              <Badge variant='outline' className='gap-1 text-muted-foreground'>
                <Sparkles />
                Intelligence ready
              </Badge>
            )}
          </div>
          <div>
            <h1 className='text-2xl font-bold tracking-tight sm:text-3xl'>
              {meeting.title}
            </h1>
            <p className='mt-2 max-w-3xl text-muted-foreground'>
              {meeting.description}
            </p>
          </div>
          <div className='flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground'>
            <span className='inline-flex items-center gap-1.5'>
              <CalendarDays className='size-4' />
              {formatMeetingDate(meeting)}
            </span>
            <span className='inline-flex items-center gap-1.5'>
              <Clock3 className='size-4' />
              {formatMeetingTimeRange(meeting)}
            </span>
            <span className='inline-flex items-center gap-1.5'>
              <MapPin className='size-4' />
              {room?.name ?? 'Room not assigned'}
            </span>
          </div>
        </div>

        {meeting.status === 'completed' && (
          <ExportMinutesMenu
            meeting={meeting}
            organizer={organizer}
            participants={participants}
            room={room}
            summary={summary}
            decisions={decisions ?? []}
            meetingActionItems={meetingActionItems ?? []}
          />
        )}
      </div>

      <div className='flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between'>
        <div className='flex min-w-0 items-center gap-3'>
          <ParticipantAvatarStack members={participants} />
          <div className='min-w-0'>
            <p className='font-medium'>
              {participants.length} participant
              {participants.length === 1 ? '' : 's'}
            </p>
            <p className='truncate text-sm text-muted-foreground'>
              {formatParticipantNames(participants)}
            </p>
          </div>
        </div>
        <div className='text-sm text-muted-foreground sm:text-end'>
          Organized by{' '}
          <span className='font-medium text-foreground'>
            {organizer?.name ?? 'Unknown organizer'}
          </span>
        </div>
      </div>
    </section>
  )
}

function OverviewTab({
  meeting,
  organizer,
  participants,
  room,
  summary,
  decisions,
  onViewSource,
}: {
  meeting: Meeting
  organizer?: Member
  participants: Member[]
  room?: MeetingRoom
  summary?: (typeof meetingSummaries)[number]
  decisions: KeyDecision[]
  onViewSource: (segmentId: string) => void
}) {
  return (
    <div className='grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.8fr)]'>
      <div className='space-y-6'>
        <Card>
          <CardHeader className='border-b'>
            <CardTitle className='flex items-center gap-2'>
              <Sparkles className='size-4 text-primary' />
              AI Summary
            </CardTitle>
            <CardDescription>
              A structured view of what happened in this meeting.
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-5 pt-6'>
            {summary ? (
              <>
                <p className='text-base leading-7'>{summary.overview}</p>
                <div className='space-y-3'>
                  <p className='text-sm font-semibold'>Highlights</p>
                  <ul className='grid gap-3 sm:grid-cols-2'>
                    {summary.highlights.map((highlight) => (
                      <li
                        key={highlight}
                        className='flex gap-2 text-sm leading-6 text-muted-foreground'
                      >
                        <span className='mt-2 size-1.5 shrink-0 rounded-full bg-primary' />
                        <span>{highlight}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <EmptyInlineState text='No summary is available for this meeting.' />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className='border-b'>
            <CardTitle className='flex items-center gap-2'>
              <ListChecks className='size-4 text-primary' />
              Key Decisions
            </CardTitle>
            <CardDescription>
              Decisions remain linked to the transcript evidence that supports
              them.
            </CardDescription>
          </CardHeader>
          <CardContent className='pt-6'>
            {decisions.length ? (
              <div className='space-y-4'>
                {decisions.map((decision, index) => (
                  <div key={decision.id} className='flex gap-3'>
                    <span className='flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary'>
                      {index + 1}
                    </span>
                    <div className='min-w-0 space-y-2'>
                      <p className='leading-6'>{decision.text}</p>
                      {decision.sourceSegmentId && (
                        <Button
                          variant='link'
                          size='sm'
                          className='h-auto px-0 text-xs'
                          onClick={() =>
                            onViewSource(decision.sourceSegmentId!)
                          }
                        >
                          View in transcript
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyInlineState text='No key decisions are available for this meeting.' />
            )}
          </CardContent>
        </Card>
      </div>

      <div className='space-y-6'>
        <MeetingInformationCard
          meeting={meeting}
          organizer={organizer}
          room={room}
        />
        <ParticipantsCard participants={participants} />
      </div>
    </div>
  )
}

function MeetingInformationCard({
  meeting,
  organizer,
  room,
}: {
  meeting: Meeting
  organizer?: Member
  room?: MeetingRoom
}) {
  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle className='flex items-center gap-2'>
          <FileText className='size-4 text-primary' />
          Meeting Information
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-4 pt-6'>
        <InfoRow label='Date' value={formatMeetingDate(meeting)} />
        <InfoRow label='Time' value={formatMeetingTimeRange(meeting)} />
        <InfoRow
          label='Room'
          value={room ? `${room.name} · ${room.location}` : 'Not assigned'}
        />
        <InfoRow label='Organizer' value={organizer?.name ?? 'Unknown'} />
        <div className='flex items-center justify-between gap-4 text-sm'>
          <span className='text-muted-foreground'>Status</span>
          <MeetingStatusBadge status={meeting.status} />
        </div>
      </CardContent>
    </Card>
  )
}

function ParticipantsCard({ participants }: { participants: Member[] }) {
  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle className='flex items-center gap-2'>
          <Users className='size-4 text-primary' />
          Participants
        </CardTitle>
        <CardDescription>
          {participants.length} people in this meeting.
        </CardDescription>
      </CardHeader>
      <CardContent className='pt-5'>
        <div className='space-y-4'>
          {participants.length ? (
            participants.map((participant) => (
              <div key={participant.id} className='flex items-center gap-3'>
                <ParticipantAvatar member={participant} />
                <div className='min-w-0'>
                  <p className='truncate text-sm font-medium'>
                    {participant.name}
                  </p>
                  <p className='truncate text-xs text-muted-foreground'>
                    {participant.department}
                  </p>
                </div>
              </div>
            ))
          ) : (
            <EmptyInlineState text='No participants are listed.' />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function TranscriptTab({
  segments,
  speakerMappings,
  highlightedSegmentId,
}: {
  segments: TranscriptSegment[]
  speakerMappings: SpeakerMapping[]
  highlightedSegmentId: string | null
}) {
  return (
    <div className='grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]'>
      <Card className='min-w-0'>
        <CardHeader className='border-b'>
          <CardTitle className='flex items-center gap-2'>
            <MessageSquare className='size-4 text-primary' />
            Vietnamese Transcript
          </CardTitle>
          <CardDescription>
            Speaker-aware transcript segments from the completed meeting.
          </CardDescription>
        </CardHeader>
        <CardContent className='pt-6'>
          {segments.length ? (
            <ScrollArea className='h-[560px] max-h-[65vh] pe-3'>
              <div className='space-y-2'>
                {segments.map((segment) => (
                  <TranscriptSegmentRow
                    key={segment.id}
                    segment={segment}
                    highlighted={highlightedSegmentId === segment.id}
                  />
                ))}
              </div>
            </ScrollArea>
          ) : (
            <EmptyInlineState text='No transcript segments are available for this meeting.' />
          )}
        </CardContent>
      </Card>

      <SpeakerMappingCard mappings={speakerMappings} />
    </div>
  )
}

export function TranscriptSegmentRow({
  segment,
  highlighted,
}: {
  segment: TranscriptSegment
  highlighted: boolean
}) {
  const participant = segment.participantId
    ? getMemberById(segment.participantId)
    : undefined
  const speakerLabel = formatSpeakerLabel(segment.speakerLabel)

  return (
    <div
      id={`transcript-${segment.id}`}
      className={cn(
        'rounded-lg border p-4 transition-colors',
        highlighted && 'border-primary bg-primary/5 ring-2 ring-primary/30'
      )}
    >
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='flex min-w-0 items-center gap-3'>
          {participant ? (
            <ParticipantAvatar member={participant} />
          ) : (
            <Avatar className='size-9'>
              <AvatarFallback className='bg-muted text-xs'>
                {speakerLabel.slice(0, 2)}
              </AvatarFallback>
            </Avatar>
          )}
          <div className='min-w-0'>
            <p className='truncate font-medium'>
              {participant?.name ?? speakerLabel}
            </p>
            <p className='text-xs text-muted-foreground'>
              {participant ? speakerLabel : 'Participant not mapped'}
            </p>
          </div>
        </div>
        <div className='flex items-center gap-2'>
          <Badge variant='outline' className='font-mono text-[11px]'>
            {formatTranscriptTimestamp(segment.startMs)}
          </Badge>
          {!segment.isFinal && (
            <Badge
              variant='outline'
              className='text-amber-700 dark:text-amber-300'
            >
              Draft
            </Badge>
          )}
        </div>
      </div>
      <p className='mt-4 leading-7 text-foreground/90'>{segment.text}</p>
    </div>
  )
}

type SpeakerMapping = {
  detectedLabel: string
  member?: Member
}

function SpeakerMappingCard({ mappings }: { mappings: SpeakerMapping[] }) {
  return (
    <Card className='h-fit'>
      <CardHeader className='border-b'>
        <CardTitle className='flex items-center gap-2'>
          <UserRound className='size-4 text-primary' />
          Speaker Mapping
        </CardTitle>
        <CardDescription>
          Detected speaker labels linked to meeting participants.
        </CardDescription>
      </CardHeader>
      <CardContent className='pt-5'>
        {mappings.length ? (
          <div className='space-y-3'>
            {mappings.map((mapping) => (
              <div
                key={mapping.detectedLabel}
                className='flex items-center gap-2 text-sm'
              >
                <Badge variant='outline' className='font-mono text-[11px]'>
                  {formatSpeakerLabel(mapping.detectedLabel)}
                </Badge>
                <span className='text-muted-foreground'>→</span>
                <span className='min-w-0 truncate font-medium'>
                  {mapping.member?.name ?? 'Not mapped'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyInlineState text='No detected speakers are available.' />
        )}
      </CardContent>
    </Card>
  )
}

function ActionItemsTab({
  actionItems,
  onViewSource,
}: {
  actionItems: ActionItem[]
  onViewSource: (segmentId: string) => void
}) {
  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle className='flex items-center gap-2'>
          <ListChecks className='size-4 text-primary' />
          Action Items
        </CardTitle>
        <CardDescription>
          Only action items extracted from this meeting are shown here.
        </CardDescription>
      </CardHeader>
      <CardContent className='p-0'>
        {actionItems.length ? (
          <Table className='min-w-[850px]'>
            <TableHeader>
              <TableRow>
                <TableHead className='w-[34%]'>Task</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead>Due date</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className='text-end'>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {actionItems.map((actionItem) => {
                const assignee = getMemberById(actionItem.assigneeId)

                return (
                  <TableRow key={actionItem.id}>
                    <TableCell className='whitespace-normal'>
                      <div className='min-w-56 space-y-1'>
                        <p className='font-medium'>{actionItem.title}</p>
                        <p className='text-xs leading-5 text-muted-foreground'>
                          {actionItem.description}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      {assignee ? (
                        <div className='flex items-center gap-2'>
                          <ParticipantAvatar
                            member={assignee}
                            className='size-7'
                          />
                          <span>{assignee.name}</span>
                        </div>
                      ) : (
                        'Unassigned'
                      )}
                    </TableCell>
                    <TableCell>{formatDateOnly(actionItem.dueDate)}</TableCell>
                    <TableCell>
                      <Badge
                        variant='outline'
                        className={priorityStyles[actionItem.priority]}
                      >
                        {priorityLabels[actionItem.priority]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant='outline'
                        className={actionStatusStyles[actionItem.status]}
                      >
                        {actionStatusLabels[actionItem.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className='text-end'>
                      {actionItem.sourceSegmentId && (
                        <Button
                          variant='link'
                          size='sm'
                          className='h-auto px-0'
                          onClick={() =>
                            onViewSource(actionItem.sourceSegmentId!)
                          }
                        >
                          View source
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : (
          <div className='p-6'>
            <EmptyInlineState text='No action items are available for this meeting.' />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function AskAiTab({
  meeting,
  conversation,
  messages,
  sources,
  onAskQuestion,
  onViewSource,
}: {
  meeting: Meeting
  conversation?: (typeof assistantConversations)[number]
  messages: AssistantMessage[]
  sources: RagSource[]
  onAskQuestion: (question: string) => void
  onViewSource: (segmentId: string) => void
}) {
  const [question, setQuestion] = useState('')
  const suggestedQuestions = conversation?.messages.filter(
    (message) => message.role === 'user'
  )
  const sourceById = new Map(sources.map((source) => [source.id, source]))

  const submitQuestion = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onAskQuestion(question)
    setQuestion('')
  }

  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle className='flex items-center gap-2'>
          <Sparkles className='size-4 text-primary' />
          Ask about this meeting
        </CardTitle>
        <CardDescription>
          Ask a supported question about {meeting.title}. Answers stay scoped to
          this meeting.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-6 pt-6'>
        {conversation ? (
          <>
            <div className='space-y-4'>
              {messages.map((message) => (
                <AssistantMessageBubble
                  key={message.id}
                  message={message}
                  sourceById={sourceById}
                  onViewSource={onViewSource}
                />
              ))}
            </div>

            <div className='space-y-3 border-t pt-5'>
              <p className='text-sm font-medium'>Suggested questions</p>
              <div className='flex flex-wrap gap-2'>
                {suggestedQuestions?.map((suggestedQuestion) => (
                  <Button
                    key={suggestedQuestion.id}
                    type='button'
                    variant='outline'
                    size='sm'
                    className='h-auto text-start whitespace-normal'
                    onClick={() => onAskQuestion(suggestedQuestion.content)}
                  >
                    {suggestedQuestion.content}
                  </Button>
                ))}
              </div>
            </div>

            <form onSubmit={submitQuestion} className='flex gap-2'>
              <Input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder='Enter a supported question...'
                aria-label='Ask a question about this meeting'
              />
              <Button type='submit' disabled={!question.trim()}>
                <Send />
                Ask
              </Button>
            </form>
          </>
        ) : (
          <div className='rounded-lg border border-dashed p-8 text-center'>
            <MessageSquare className='mx-auto size-8 text-muted-foreground' />
            <p className='mt-3 font-medium'>No saved demo questions yet</p>
            <p className='mt-1 text-sm text-muted-foreground'>
              Meeting-scoped AI examples will appear here when shared assistant
              knowledge is available.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function AssistantMessageBubble({
  message,
  sourceById,
  onViewSource,
}: {
  message: AssistantMessage
  sourceById: Map<string, RagSource>
  onViewSource: (segmentId: string) => void
}) {
  const isUser = message.role === 'user'
  const sources = (message.sourceIds ?? [])
    .map((sourceId) => sourceById.get(sourceId))
    .filter((source): source is RagSource => Boolean(source))

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-3xl rounded-xl border px-4 py-3',
          isUser
            ? 'border-primary bg-primary text-primary-foreground'
            : 'bg-muted/30'
        )}
      >
        <div className='flex items-center justify-between gap-4'>
          <p className='text-xs font-medium opacity-75'>
            {isUser ? 'You' : 'Meeting Assistant'}
          </p>
          <p className='text-[11px] opacity-60'>
            {formatMessageTime(message.createdAt)}
          </p>
        </div>
        <p className='mt-2 text-sm leading-6'>{message.content}</p>
        {sources.length > 0 && (
          <div className='mt-4 space-y-2 border-t border-current/10 pt-3'>
            <p className='text-xs font-medium opacity-75'>
              Supporting evidence
            </p>
            {sources.map((source) => (
              <SourceReference
                key={source.id}
                source={source}
                onViewSource={onViewSource}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SourceReference({
  source,
  onViewSource,
}: {
  source: RagSource
  onViewSource: (segmentId: string) => void
}) {
  return (
    <button
      type='button'
      className='flex w-full flex-col gap-1 rounded-md border bg-background/70 p-3 text-start transition-colors hover:bg-accent'
      onClick={() => onViewSource(source.segmentId)}
    >
      <span className='flex flex-wrap items-center gap-2 text-xs font-medium'>
        <Badge variant='outline'>{sourceTypeLabels[source.sourceType]}</Badge>
        <span className='text-muted-foreground'>
          Transcript · {formatTranscriptTimestamp(source.timestampMs)}
        </span>
      </span>
      <span className='text-sm leading-5 text-muted-foreground'>
        {source.excerpt}
      </span>
    </button>
  )
}

function LifecycleState({ meeting }: { meeting: Meeting }) {
  if (meeting.status === 'completed') {
    return null
  }

  const stateCopy: Record<Exclude<MeetingStatus, 'completed'>, string> = {
    scheduled:
      'This meeting has not started yet. Transcript and meeting intelligence will appear after it is completed.',
    in_progress:
      'This meeting is currently live. Meeting intelligence will be available after it ends.',
    processing:
      'Meeting intelligence is being generated. The completed workspace will be available when processing finishes.',
    cancelled:
      'This meeting was cancelled. Completed-meeting intelligence is not available.',
  }

  return (
    <Card className='border-dashed'>
      <CardContent className='flex flex-col items-center justify-center px-6 py-16 text-center'>
        <div className='flex size-12 items-center justify-center rounded-full bg-muted'>
          {meeting.status === 'processing' ? (
            <Sparkles className='size-5 text-amber-600 dark:text-amber-400' />
          ) : meeting.status === 'in_progress' ? (
            <MessageSquare className='size-5 text-emerald-600 dark:text-emerald-400' />
          ) : (
            <Clock3 className='size-5 text-muted-foreground' />
          )}
        </div>
        <Badge
          variant='outline'
          className={cn('mt-4', statusStyles[meeting.status])}
        >
          {statusLabels[meeting.status]}
        </Badge>
        <h2 className='mt-4 text-lg font-semibold'>
          {meeting.status === 'scheduled'
            ? 'Meeting not started'
            : meeting.status === 'in_progress'
              ? 'Meeting is live'
              : meeting.status === 'processing'
                ? 'Preparing meeting intelligence'
                : 'Meeting cancelled'}
        </h2>
        <p className='mt-2 max-w-lg text-sm leading-6 text-muted-foreground'>
          {stateCopy[meeting.status]}
        </p>
        {meeting.status === 'processing' && meeting.processingStage && (
          <p className='mt-4 text-xs text-muted-foreground'>
            Current stage: {formatProcessingStage(meeting.processingStage)}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function ExportMinutesMenu({
  meeting,
  organizer,
  participants,
  room,
  summary,
  decisions,
  meetingActionItems,
}: {
  meeting: Meeting
  organizer?: Member
  participants: Member[]
  room?: MeetingRoom
  summary?: (typeof meetingSummaries)[number]
  decisions: KeyDecision[]
  meetingActionItems: ActionItem[]
}) {
  const exportMarkdown = () => {
    const markdown = buildMinutesMarkdown({
      meeting,
      organizer,
      participants,
      room,
      summary,
      decisions,
      meetingActionItems,
    })
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${meeting.id}-minutes.md`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    toast.success('Markdown meeting minutes exported.')
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Download />
          Export Minutes
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuItem onSelect={exportMarkdown}>
          <FileText />
          Export Markdown
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            toast.info(
              'PDF meeting minutes are represented as a prototype action.'
            )
          }
        >
          <Download />
          Export PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MeetingStatusBadge({ status }: { status: MeetingStatus }) {
  return (
    <Badge variant='outline' className={statusStyles[status]}>
      {statusLabels[status]}
    </Badge>
  )
}

export function ParticipantAvatar({
  member,
  className,
}: {
  member: Member
  className?: string
}) {
  return (
    <Avatar className={cn('size-9', className)}>
      {member.avatar && <AvatarImage src={member.avatar} alt={member.name} />}
      <AvatarFallback className='bg-primary/10 text-xs font-medium text-primary'>
        {getInitials(member.name)}
      </AvatarFallback>
    </Avatar>
  )
}

function ParticipantAvatarStack({ members }: { members: Member[] }) {
  return (
    <div className='flex shrink-0 items-center ps-1'>
      {members.slice(0, 5).map((member, index) => (
        <ParticipantAvatar
          key={member.id}
          member={member}
          className={cn('border-2 border-card', index > 0 && '-ms-2')}
        />
      ))}
      {members.length > 5 && (
        <span className='-ms-2 flex size-9 items-center justify-center rounded-full border-2 border-card bg-muted text-xs font-medium'>
          +{members.length - 5}
        </span>
      )}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex items-start justify-between gap-4 text-sm'>
      <span className='text-muted-foreground'>{label}</span>
      <span className='max-w-[65%] text-end font-medium'>{value}</span>
    </div>
  )
}

function EmptyInlineState({ text }: { text: string }) {
  return <p className='text-sm text-muted-foreground'>{text}</p>
}

function MeetingNotFound() {
  return (
    <Card>
      <CardContent className='flex flex-col items-center justify-center px-6 py-16 text-center'>
        <FileText className='size-10 text-muted-foreground' />
        <h1 className='mt-4 text-xl font-semibold'>Meeting not found</h1>
        <p className='mt-2 text-sm text-muted-foreground'>
          The meeting ID does not match a meeting in the shared workspace.
        </p>
        <Button asChild className='mt-6'>
          <Link to='/meetings'>Back to Meetings</Link>
        </Button>
      </CardContent>
    </Card>
  )
}

function getSpeakerMappings(segments: TranscriptSegment[]): SpeakerMapping[] {
  const labels = Array.from(
    new Set(segments.map((segment) => segment.speakerLabel))
  )

  return labels.map((detectedLabel) => {
    const mappedSegment = segments.find(
      (segment) =>
        segment.speakerLabel === detectedLabel && segment.participantId
    )

    return {
      detectedLabel,
      member: mappedSegment?.participantId
        ? getMemberById(mappedSegment.participantId)
        : undefined,
    }
  })
}

function formatMeetingDate(meeting: Meeting) {
  return dateFormatter.format(new Date(meeting.startsAt))
}

function formatMeetingTimeRange(meeting: Meeting) {
  return `${timeFormatter.format(new Date(meeting.startsAt))} - ${timeFormatter.format(new Date(meeting.endsAt))}`
}

function formatDateOnly(date: string) {
  return dateFormatter.format(new Date(`${date}T12:00:00+07:00`))
}

function formatTranscriptTimestamp(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatMessageTime(date: string) {
  return timeFormatter.format(new Date(date))
}

function formatSpeakerLabel(label: string) {
  const match = /^SPEAKER_(\d+)$/i.exec(label)
  return match ? `Speaker ${Number(match[1])}` : label
}

function formatProcessingStage(stage: NonNullable<Meeting['processingStage']>) {
  const labels: Record<NonNullable<Meeting['processingStage']>, string> = {
    uploaded: 'Uploaded',
    transcribing: 'Transcribing',
    diarizing: 'Identifying speakers',
    summarizing: 'Summarizing',
    extracting: 'Extracting decisions and action items',
    indexing: 'Indexing meeting knowledge',
    ready: 'Ready',
  }

  return labels[stage]
}

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toLocaleUpperCase()
  }

  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toLocaleUpperCase()
}

function formatParticipantNames(participants: Member[]) {
  const names = participants.map((participant) => participant.name)
  if (!names.length) {
    return 'No participants listed'
  }

  const visibleNames = names.slice(0, 3).join(', ')
  return names.length > 3
    ? `${visibleNames} +${names.length - 3} more`
    : visibleNames
}

function buildMinutesMarkdown({
  meeting,
  organizer,
  participants,
  room,
  summary,
  decisions,
  meetingActionItems,
}: {
  meeting: Meeting
  organizer?: Member
  participants: Member[]
  room?: MeetingRoom
  summary?: (typeof meetingSummaries)[number]
  decisions: KeyDecision[]
  meetingActionItems: ActionItem[]
}) {
  const lines = [
    `# ${meeting.title}`,
    '',
    '## Meeting Information',
    `- Date: ${formatMeetingDate(meeting)}`,
    `- Time: ${formatMeetingTimeRange(meeting)}`,
    `- Room: ${room?.name ?? 'Not assigned'}`,
    `- Organizer: ${organizer?.name ?? 'Unknown'}`,
    `- Participants: ${formatParticipantNames(participants)}`,
    '',
    '## Summary',
    summary?.overview ?? 'No summary is available for this meeting.',
    '',
    '## Key Decisions',
    ...(decisions.length
      ? decisions.map((decision) => `- ${decision.text}`)
      : ['- No key decisions are available.']),
    '',
    '## Action Items',
    ...(meetingActionItems.length
      ? meetingActionItems.map(
          (actionItem) =>
            `- ${actionItem.title} — ${getMemberById(actionItem.assigneeId)?.name ?? 'Unassigned'} — due ${formatDateOnly(actionItem.dueDate)} — ${actionStatusLabels[actionItem.status]}`
        )
      : ['- No action items are available.']),
    '',
  ]

  return lines.join('\n')
}
