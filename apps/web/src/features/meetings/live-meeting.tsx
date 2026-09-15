import { useEffect, useState, type ChangeEvent, type DragEvent } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  FileAudio,
  FileText,
  Loader2,
  MapPin,
  Mic,
  Pause,
  Play,
  Radio,
  Sparkles,
  Square,
  Upload,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import {
  getMeetingById,
  getMemberById,
  getRoomById,
  getTranscriptByMeetingId,
  type Meeting,
  type MeetingStatus,
  type Member,
  type ProcessingStage,
  updateMeetingProcessingState,
} from './data'
import { ParticipantAvatar, TranscriptSegmentRow } from './meeting-workspace'

type ProcessingSource = 'live' | 'upload'
type LiveFlow =
  | { mode: 'live' }
  | {
      mode: 'processing'
      source: ProcessingSource
      fileName?: string
      initialStage: ProcessingStage
    }

type ProcessingStageDefinition = {
  value: ProcessingStage
  label: string
  description: string
}

const processingStages: ProcessingStageDefinition[] = [
  {
    value: 'uploaded',
    label: 'Recording received',
    description: 'The meeting source is ready for the intelligence pipeline.',
  },
  {
    value: 'transcribing',
    label: 'Transcribing',
    description: 'Converting the meeting conversation into timestamped text.',
  },
  {
    value: 'diarizing',
    label: 'Speaker diarization',
    description: 'Associating detected speakers with meeting participants.',
  },
  {
    value: 'summarizing',
    label: 'Generating summary',
    description: 'Preparing a concise overview and meeting highlights.',
  },
  {
    value: 'extracting',
    label: 'Extracting decisions & action items',
    description: 'Linking decisions and follow-up work to transcript evidence.',
  },
  {
    value: 'indexing',
    label: 'Indexing meeting knowledge',
    description: 'Making the completed meeting knowledge ready to revisit.',
  },
  {
    value: 'ready',
    label: 'Ready',
    description: 'The completed meeting workspace is available.',
  },
]

const meetingStatusLabels: Record<MeetingStatus, string> = {
  scheduled: 'Upcoming',
  in_progress: 'Live',
  processing: 'Processing',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

const meetingStatusStyles: Record<MeetingStatus, string> = {
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

export function LiveMeetingPage({ meetingId }: { meetingId: string }) {
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

        {meeting ? <LiveMeetingFlow meeting={meeting} /> : <MeetingNotFound />}
      </Main>
    </>
  )
}

function LiveMeetingFlow({ meeting }: { meeting: Meeting }) {
  const [flow, setFlow] = useState<LiveFlow>(() =>
    meeting.status === 'processing'
      ? {
          mode: 'processing',
          source: 'live',
          initialStage: meeting.processingStage ?? 'uploaded',
        }
      : { mode: 'live' }
  )
  const [isUploadOpen, setIsUploadOpen] = useState(false)

  const startProcessing = (source: ProcessingSource, fileName?: string) => {
    updateMeetingProcessingState(meeting.id, 'processing', 'uploaded')
    setIsUploadOpen(false)
    setFlow({
      mode: 'processing',
      source,
      fileName,
      initialStage: 'uploaded',
    })
  }

  return (
    <>
      {flow.mode === 'processing' ? (
        <ProcessingExperience
          meeting={meeting}
          source={flow.source}
          fileName={flow.fileName}
          initialStage={flow.initialStage}
        />
      ) : meeting.status === 'in_progress' ? (
        <LiveSession
          meeting={meeting}
          onEndMeeting={() => startProcessing('live')}
          onUploadRecording={() => setIsUploadOpen(true)}
        />
      ) : (
        <LifecycleLanding
          meeting={meeting}
          onUploadRecording={() => setIsUploadOpen(true)}
        />
      )}

      {meeting.status !== 'cancelled' && flow.mode !== 'processing' && (
        <UploadRecordingDialog
          open={isUploadOpen}
          onOpenChange={setIsUploadOpen}
          onProcess={startProcessing}
        />
      )}
    </>
  )
}

function LiveSession({
  meeting,
  onEndMeeting,
  onUploadRecording,
}: {
  meeting: Meeting
  onEndMeeting: () => void
  onUploadRecording: () => void
}) {
  const participants = getParticipants(meeting)
  const room = getRoomById(meeting.roomId)
  const transcript = getTranscriptByMeetingId(meeting.id)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [visibleSegmentCount, setVisibleSegmentCount] = useState(
    transcript.length ? 1 : 0
  )
  const [microphoneOn, setMicrophoneOn] = useState(true)
  const [transcriptPaused, setTranscriptPaused] = useState(false)
  const [isEndConfirmationOpen, setIsEndConfirmationOpen] = useState(false)

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setElapsedSeconds((seconds) => seconds + 1)
    }, 1000)

    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (
      transcriptPaused ||
      visibleSegmentCount >= transcript.length ||
      !transcript.length
    ) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setVisibleSegmentCount((count) => Math.min(count + 1, transcript.length))
    }, 1600)

    return () => window.clearTimeout(timeoutId)
  }, [transcript.length, transcriptPaused, visibleSegmentCount])

  return (
    <>
      <section className='space-y-5'>
        <div className='flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between'>
          <div className='min-w-0 space-y-3'>
            <div className='flex flex-wrap items-center gap-2'>
              <Badge
                variant='outline'
                className='gap-1.5 border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
              >
                <span className='size-2 animate-pulse rounded-full bg-emerald-500' />
                Live meeting
              </Badge>
              <Badge variant='outline'>Frontend simulation</Badge>
            </div>
            <div>
              <h1 className='text-2xl font-bold tracking-tight sm:text-3xl'>
                {meeting.title}
              </h1>
              <p className='mt-2 max-w-3xl text-muted-foreground'>
                Conversation capture is simulated locally. No microphone or
                recording service is connected.
              </p>
            </div>
          </div>

          <div className='flex flex-wrap gap-2'>
            <Button variant='outline' onClick={onUploadRecording}>
              <Upload />
              Upload Recording
            </Button>
            <AlertDialog
              open={isEndConfirmationOpen}
              onOpenChange={setIsEndConfirmationOpen}
            >
              <AlertDialogTrigger asChild>
                <Button variant='destructive'>
                  <Square />
                  End Meeting
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>End this live meeting?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The live simulation will stop and the meeting will move
                    through the processing pipeline.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep Meeting Live</AlertDialogCancel>
                  <AlertDialogAction onClick={onEndMeeting}>
                    End Meeting
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
          <LiveMetric
            label='Live status'
            value='Recording'
            icon={<Radio className='text-emerald-600 dark:text-emerald-400' />}
            detail='Active now'
          />
          <LiveMetric
            label='Elapsed time'
            value={formatDuration(elapsedSeconds)}
            icon={<Clock3 className='text-primary' />}
            detail='Local session timer'
          />
          <LiveMetric
            label='Room'
            value={room?.name ?? 'Room not assigned'}
            icon={<MapPin className='text-primary' />}
            detail={room?.location ?? 'No room location'}
          />
          <LiveMetric
            label='Participants'
            value={`${participants.length}`}
            icon={<Users className='text-primary' />}
            detail='People in this meeting'
          />
        </div>
      </section>

      <div className='grid gap-6 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.35fr)]'>
        <div className='space-y-6'>
          <Card>
            <CardHeader className='border-b'>
              <CardTitle className='flex items-center gap-2'>
                <Mic className='size-4 text-primary' />
                Capture Status
              </CardTitle>
              <CardDescription>
                Visual-only states for this frontend demo.
              </CardDescription>
            </CardHeader>
            <CardContent className='space-y-4 pt-5'>
              <CaptureStatusRow label='Recording' value='Active' active />
              <CaptureStatusRow
                label='Microphone'
                value={microphoneOn ? 'On' : 'Muted'}
                active={microphoneOn}
              />
              <CaptureStatusRow
                label='Speech Recognition'
                value={transcriptPaused ? 'Paused' : 'Listening'}
                active={!transcriptPaused}
              />
              <div className='flex flex-wrap gap-2 border-t pt-4'>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => setMicrophoneOn((on) => !on)}
                >
                  {microphoneOn ? <VolumeX /> : <Volume2 />}
                  {microphoneOn ? 'Mute' : 'Unmute'}
                </Button>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => setTranscriptPaused((paused) => !paused)}
                >
                  {transcriptPaused ? <Play /> : <Pause />}
                  {transcriptPaused ? 'Resume Transcript' : 'Pause Transcript'}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className='border-b'>
              <CardTitle className='flex items-center gap-2'>
                <Users className='size-4 text-primary' />
                Participants
              </CardTitle>
              <CardDescription>
                {participants.length} participant
                {participants.length === 1 ? '' : 's'} in this meeting.
              </CardDescription>
            </CardHeader>
            <CardContent className='space-y-4 pt-5'>
              {participants.length ? (
                participants.map((participant, index) => (
                  <div
                    key={participant.id}
                    className='flex items-center justify-between gap-3'
                  >
                    <div className='flex min-w-0 items-center gap-3'>
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
                    {index === 0 && !transcriptPaused && (
                      <Badge variant='outline' className='shrink-0 gap-1'>
                        <span className='size-1.5 rounded-full bg-emerald-500' />
                        Speaking
                      </Badge>
                    )}
                  </div>
                ))
              ) : (
                <p className='text-sm text-muted-foreground'>
                  No participants are listed.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className='min-w-0'>
          <CardHeader className='border-b'>
            <div className='flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between'>
              <div>
                <CardTitle className='flex items-center gap-2'>
                  <Sparkles className='size-4 text-primary' />
                  Live Transcript
                </CardTitle>
                <CardDescription>
                  Speaker-aware segments appear as the demo advances.
                </CardDescription>
              </div>
              <Badge variant='outline'>
                {visibleSegmentCount} / {transcript.length} segments
              </Badge>
            </div>
          </CardHeader>
          <CardContent className='pt-5'>
            {transcript.length ? (
              <ScrollArea className='h-[620px] max-h-[65vh] pe-3'>
                <div className='space-y-3'>
                  {transcript.slice(0, visibleSegmentCount).map((segment) => (
                    <TranscriptSegmentRow
                      key={segment.id}
                      segment={segment}
                      highlighted={false}
                    />
                  ))}
                  {visibleSegmentCount < transcript.length && (
                    <div className='flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground'>
                      <Loader2 className='size-4 animate-spin' />
                      Listening for the next segment...
                    </div>
                  )}
                </div>
              </ScrollArea>
            ) : (
              <div className='rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground'>
                No transcript segments are available for this meeting.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}

function ProcessingExperience({
  meeting,
  source,
  fileName,
  initialStage,
}: {
  meeting: Meeting
  source: ProcessingSource
  fileName?: string
  initialStage: ProcessingStage
}) {
  const [currentStage, setCurrentStage] =
    useState<ProcessingStage>(initialStage)
  const currentStageIndex = getProcessingStageIndex(currentStage)
  const isReady = currentStage === 'ready'

  useEffect(() => {
    updateMeetingProcessingState(
      meeting.id,
      isReady ? 'completed' : 'processing',
      currentStage
    )

    if (isReady) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      const nextStage = processingStages[currentStageIndex + 1]
      if (nextStage) {
        setCurrentStage(nextStage.value)
      }
    }, 1100)

    return () => window.clearTimeout(timeoutId)
  }, [currentStage, currentStageIndex, isReady, meeting.id])

  return (
    <>
      <section className='space-y-4'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between'>
          <div className='space-y-3'>
            <div className='flex flex-wrap items-center gap-2'>
              <Badge
                variant='outline'
                className={cn(
                  isReady
                    ? meetingStatusStyles.completed
                    : meetingStatusStyles.processing
                )}
              >
                {isReady ? (
                  <CheckCircle2 />
                ) : (
                  <Loader2 className='animate-spin' />
                )}
                {isReady ? 'Ready' : 'Processing'}
              </Badge>
              <Badge variant='outline'>Frontend simulation</Badge>
            </div>
            <div>
              <h1 className='text-2xl font-bold tracking-tight sm:text-3xl'>
                Processing {meeting.title}
              </h1>
              <p className='mt-2 max-w-3xl text-muted-foreground'>
                The shared meeting pipeline is preparing transcript and meeting
                intelligence for the workspace.
              </p>
            </div>
          </div>
          <Button asChild variant='ghost' className='-me-3 w-fit'>
            <Link to='/meetings/$meetingId' params={{ meetingId: meeting.id }}>
              View meeting details
            </Link>
          </Button>
        </div>
      </section>

      <div className='grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]'>
        <Card>
          <CardHeader className='border-b'>
            <div className='flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between'>
              <div>
                <CardTitle className='flex items-center gap-2'>
                  <Sparkles className='size-4 text-primary' />
                  Meeting intelligence pipeline
                </CardTitle>
                <CardDescription>
                  Completed, current, and pending stages are shown below.
                </CardDescription>
              </div>
              <span className='text-sm font-medium text-muted-foreground'>
                {isReady
                  ? 100
                  : Math.round(
                      (currentStageIndex / (processingStages.length - 1)) * 100
                    )}
                %
              </span>
            </div>
            <div className='h-2 overflow-hidden rounded-full bg-muted'>
              <div
                className='h-full rounded-full bg-primary transition-[width] duration-500'
                style={{
                  width: `${isReady ? 100 : (currentStageIndex / (processingStages.length - 1)) * 100}%`,
                }}
              />
            </div>
          </CardHeader>
          <CardContent className='pt-5'>
            <ol className='space-y-1'>
              {processingStages.map((stage, index) => {
                const completed = index < currentStageIndex || isReady
                const current = !isReady && index === currentStageIndex

                return (
                  <li
                    key={stage.value}
                    aria-current={current ? 'step' : undefined}
                    className={cn(
                      'flex gap-3 rounded-lg p-3 transition-colors',
                      current && 'bg-primary/5'
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                        completed &&
                          'border-primary bg-primary text-primary-foreground',
                        current &&
                          'border-primary bg-background text-primary ring-4 ring-primary/10',
                        !completed &&
                          !current &&
                          'border-muted-foreground/30 text-muted-foreground'
                      )}
                    >
                      {completed ? (
                        <Check />
                      ) : current ? (
                        <Loader2 className='size-3.5 animate-spin' />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <span className='min-w-0 pt-0.5'>
                      <span
                        className={cn(
                          'block font-medium',
                          !completed && !current && 'text-muted-foreground'
                        )}
                      >
                        {stage.value === 'uploaded' && source === 'upload'
                          ? 'Audio uploaded'
                          : stage.label}
                      </span>
                      <span className='mt-1 block text-sm leading-5 text-muted-foreground'>
                        {stage.description}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ol>
          </CardContent>
        </Card>

        <div className='space-y-6'>
          <Card>
            <CardHeader className='border-b'>
              <CardTitle className='flex items-center gap-2'>
                <FileAudio className='size-4 text-primary' />
                Processing source
              </CardTitle>
            </CardHeader>
            <CardContent className='space-y-4 pt-5'>
              <div className='flex items-start gap-3 rounded-lg border bg-muted/30 p-3'>
                <div className='flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary'>
                  {source === 'upload' ? <Upload /> : <Radio />}
                </div>
                <div className='min-w-0'>
                  <p className='font-medium'>
                    {source === 'upload'
                      ? 'Uploaded recording'
                      : 'Ended live meeting'}
                  </p>
                  <p className='mt-1 truncate text-sm text-muted-foreground'>
                    {fileName ?? meeting.title}
                  </p>
                </div>
              </div>
              <p className='text-sm leading-6 text-muted-foreground'>
                This prototype advances through predetermined states and uses
                the meeting data already available in the workspace. No audio is
                uploaded or analyzed.
              </p>
            </CardContent>
          </Card>

          <Card className={cn(isReady && 'border-primary/30 bg-primary/5')}>
            <CardContent className='flex flex-col items-start gap-4 p-5'>
              <div className='flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary'>
                {isReady ? (
                  <CheckCircle2 />
                ) : (
                  <Loader2 className='animate-spin' />
                )}
              </div>
              <div>
                <h2 className='font-semibold'>
                  {isReady
                    ? 'Meeting intelligence is ready'
                    : 'Preparing your workspace'}
                </h2>
                <p className='mt-1 text-sm leading-6 text-muted-foreground'>
                  {isReady
                    ? 'Open the existing Meeting Workspace to review the transcript, summary, decisions, and action items.'
                    : 'The next pipeline stage will appear automatically in this demo.'}
                </p>
              </div>
              {isReady && (
                <Button asChild>
                  <Link
                    to='/meetings/$meetingId'
                    params={{ meetingId: meeting.id }}
                  >
                    <FileText />
                    View Meeting
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}

function LifecycleLanding({
  meeting,
  onUploadRecording,
}: {
  meeting: Meeting
  onUploadRecording: () => void
}) {
  const participants = getParticipants(meeting)
  const room = getRoomById(meeting.roomId)
  const copy = getLifecycleCopy(meeting.status)

  return (
    <>
      <section className='space-y-5'>
        <div className='space-y-3'>
          <div className='flex flex-wrap items-center gap-2'>
            <Badge
              variant='outline'
              className={meetingStatusStyles[meeting.status]}
            >
              {meetingStatusLabels[meeting.status]}
            </Badge>
            <Badge variant='outline'>Live route</Badge>
          </div>
          <div>
            <h1 className='text-2xl font-bold tracking-tight sm:text-3xl'>
              {meeting.title}
            </h1>
            <p className='mt-2 max-w-3xl text-muted-foreground'>
              {copy.description}
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
            <span className='inline-flex items-center gap-1.5'>
              <Users className='size-4' />
              {participants.length} participant
              {participants.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      </section>

      <Card className='border-dashed'>
        <CardContent className='flex flex-col items-center justify-center px-6 py-16 text-center'>
          <div className='flex size-12 items-center justify-center rounded-full bg-muted'>
            {meeting.status === 'completed' ? (
              <CheckCircle2 className='size-5 text-primary' />
            ) : meeting.status === 'cancelled' ? (
              <FileText className='size-5 text-muted-foreground' />
            ) : (
              <Clock3 className='size-5 text-muted-foreground' />
            )}
          </div>
          <h2 className='mt-4 text-lg font-semibold'>{copy.title}</h2>
          <p className='mt-2 max-w-lg text-sm leading-6 text-muted-foreground'>
            {copy.detail}
          </p>
          <div className='mt-6 flex flex-wrap justify-center gap-2'>
            {meeting.status === 'completed' && (
              <Button asChild>
                <Link
                  to='/meetings/$meetingId'
                  params={{ meetingId: meeting.id }}
                >
                  <FileText />
                  View Meeting
                </Link>
              </Button>
            )}
            {meeting.status !== 'cancelled' && (
              <Button variant='outline' onClick={onUploadRecording}>
                <Upload />
                Upload Recording
              </Button>
            )}
            {meeting.status !== 'completed' && (
              <Button asChild variant='outline'>
                <Link
                  to='/meetings/$meetingId'
                  params={{ meetingId: meeting.id }}
                >
                  <ArrowLeft />
                  Back to Meeting
                </Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </>
  )
}

function UploadRecordingDialog({
  open,
  onOpenChange,
  onProcess,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onProcess: (source: ProcessingSource, fileName?: string) => void
}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleFile = (file?: File) => {
    if (!file) {
      return
    }

    const fileName = file.name.toLocaleLowerCase()
    if (!fileName.endsWith('.mp3') && !fileName.endsWith('.wav')) {
      setSelectedFile(null)
      setError('Choose a demo recording with an .mp3 or .wav extension.')
      return
    }

    setSelectedFile(file)
    setError(null)
  }

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleFile(event.target.files?.[0])
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    handleFile(event.dataTransfer.files?.[0])
  }

  const processRecording = () => {
    if (!selectedFile) {
      return
    }

    onProcess('upload', selectedFile.name)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSelectedFile(null)
      setError(null)
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>Upload Meeting Recording</DialogTitle>
          <DialogDescription>
            Select a demo audio file to enter the same processing pipeline. The
            file is not uploaded or inspected.
          </DialogDescription>
        </DialogHeader>

        <div
          className='flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center'
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <div className='flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary'>
            <Upload />
          </div>
          <div>
            <p className='font-medium'>Drop audio file here</p>
            <p className='mt-1 text-sm text-muted-foreground'>
              or choose a file from this device
            </p>
          </div>
          <Input
            id='meeting-recording-file'
            type='file'
            accept='.mp3,.wav,audio/mpeg,audio/wav'
            onChange={handleInputChange}
            className='sr-only'
          />
          <Button asChild variant='outline'>
            <label htmlFor='meeting-recording-file'>
              <FileAudio />
              Choose File
            </label>
          </Button>
          <p className='text-xs text-muted-foreground'>
            Supported demo formats: .mp3, .wav
          </p>
        </div>

        {error && <p className='text-sm text-destructive'>{error}</p>}

        {selectedFile && (
          <div className='flex items-center gap-3 rounded-lg border p-3'>
            <div className='flex size-9 shrink-0 items-center justify-center rounded-md bg-muted'>
              <FileAudio className='size-4' />
            </div>
            <div className='min-w-0'>
              <p className='truncate text-sm font-medium'>
                {selectedFile.name}
              </p>
              <p className='text-xs text-muted-foreground'>
                {formatFileSize(selectedFile.size)}
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant='outline'>Cancel</Button>
          </DialogClose>
          <Button
            type='button'
            disabled={!selectedFile}
            onClick={processRecording}
          >
            <Sparkles />
            Process Recording
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LiveMetric({
  label,
  value,
  detail,
  icon,
}: {
  label: string
  value: string
  detail: string
  icon: React.ReactNode
}) {
  return (
    <Card>
      <CardContent className='flex items-start gap-3 p-4'>
        <div className='flex size-9 shrink-0 items-center justify-center rounded-md bg-muted'>
          {icon}
        </div>
        <div className='min-w-0'>
          <p className='text-sm text-muted-foreground'>{label}</p>
          <p className='truncate text-lg font-semibold'>{value}</p>
          <p className='truncate text-xs text-muted-foreground'>{detail}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function CaptureStatusRow({
  label,
  value,
  active,
}: {
  label: string
  value: string
  active: boolean
}) {
  return (
    <div className='flex items-center justify-between gap-4 text-sm'>
      <span className='text-muted-foreground'>{label}</span>
      <span className='flex items-center gap-2 font-medium'>
        <span
          className={cn(
            'size-2 rounded-full',
            active ? 'bg-emerald-500' : 'bg-muted-foreground/40'
          )}
        />
        {value}
      </span>
    </div>
  )
}

function getParticipants(meeting: Meeting) {
  return meeting.participantIds
    .map((memberId) => getMemberById(memberId))
    .filter((member): member is Member => Boolean(member))
}

function getProcessingStageIndex(stage: ProcessingStage) {
  return Math.max(
    0,
    processingStages.findIndex(
      (processingStage) => processingStage.value === stage
    )
  )
}

function getLifecycleCopy(status: MeetingStatus) {
  const copy: Record<
    MeetingStatus,
    { title: string; description: string; detail: string }
  > = {
    scheduled: {
      title: 'Meeting has not started',
      description:
        'This meeting is scheduled and does not have a live session yet.',
      detail:
        'Return to the meeting page for schedule details, or process a recording attached to this meeting.',
    },
    in_progress: {
      title: 'Meeting is live',
      description: 'This meeting is currently in progress.',
      detail:
        'Open the live meeting route to view the simulated capture experience.',
    },
    processing: {
      title: 'Meeting is processing',
      description: 'Meeting intelligence is being prepared.',
      detail:
        'The processing pipeline will be available when this route is loaded again.',
    },
    completed: {
      title: 'Meeting is no longer live',
      description:
        'This meeting has completed and its intelligence is available.',
      detail:
        'Open the Meeting Workspace to review the completed transcript and intelligence.',
    },
    cancelled: {
      title: 'Meeting is unavailable',
      description:
        'This meeting was cancelled and cannot be opened as a live session.',
      detail:
        'No live capture or processing session is available for this meeting.',
    },
  }

  return copy[status]
}

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatMeetingDate(meeting: Meeting) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(meeting.startsAt))
}

function formatMeetingTimeRange(meeting: Meeting) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
  })

  return `${formatter.format(new Date(meeting.startsAt))} - ${formatter.format(new Date(meeting.endsAt))}`
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
