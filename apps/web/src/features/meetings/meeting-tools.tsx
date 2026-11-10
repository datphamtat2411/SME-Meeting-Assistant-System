import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MeetingActionsPanel } from '@/features/action-items/meeting-actions-panel'
import { DecisionsPanel } from './intelligence/decisions-panel'
import { ExportPanel } from './intelligence/export-panel'
import { MinutesPanel } from './intelligence/minutes-panel'
import { SpeakersPanel } from './intelligence/speakers-panel'
import { SummaryPanel } from './intelligence/summary-panel'
import { TranscriptPanel } from './intelligence/transcript-panel'
import { ProcessingPanel } from './media/processing-panel'
import { RecordingPanel } from './media/recording-panel'
import { UploadPanel } from './media/upload-panel'

export function MeetingTools({ meetingId }: { meetingId: string }) {
  return (
    <section className='space-y-4'>
      <div>
        <h2 className='text-xl font-bold'>Meeting intelligence workspace</h2>
        <p className='text-sm text-muted-foreground'>
          Source media, asynchronous processing and human-reviewed results
          remain distinct.
        </p>
      </div>
      <Tabs defaultValue='media' className='w-full'>
        <TabsList className='flex h-auto flex-wrap justify-start gap-1'>
          <TabsTrigger value='media'>Recording & media</TabsTrigger>
          <TabsTrigger value='processing'>Processing</TabsTrigger>
          <TabsTrigger value='transcript'>Transcript</TabsTrigger>
          <TabsTrigger value='speakers'>Speakers</TabsTrigger>
          <TabsTrigger value='summary'>Summary</TabsTrigger>
          <TabsTrigger value='decisions'>Decisions</TabsTrigger>
        <TabsTrigger value='actions'>Action items</TabsTrigger>
          <TabsTrigger value='minutes'>Minutes</TabsTrigger>
          <TabsTrigger value='export'>Export</TabsTrigger>
        </TabsList>
        <TabsContent value='media' className='mt-4 space-y-4'>
          <RecordingPanel meetingId={meetingId} />
          <UploadPanel meetingId={meetingId} />
        </TabsContent>
        <TabsContent value='processing' className='mt-4'>
          <ProcessingPanel meetingId={meetingId} />
        </TabsContent>
        <TabsContent value='transcript' className='mt-4'>
          <TranscriptPanel meetingId={meetingId} />
        </TabsContent>
        <TabsContent value='speakers' className='mt-4'>
          <SpeakersPanel meetingId={meetingId} />
        </TabsContent>
        <TabsContent value='summary' className='mt-4'>
          <SummaryPanel meetingId={meetingId} />
        </TabsContent>
        <TabsContent value='decisions' className='mt-4'>
          <DecisionsPanel meetingId={meetingId} />
        </TabsContent>
        <TabsContent value='actions' className='mt-4'><MeetingActionsPanel meetingId={meetingId} /></TabsContent>
      <TabsContent value='minutes' className='mt-4'>
          <MinutesPanel meetingId={meetingId} />
        </TabsContent>
        <TabsContent value='export' className='mt-4'>
          <ExportPanel meetingId={meetingId} />
        </TabsContent>
      </Tabs>
    </section>
  )
}
