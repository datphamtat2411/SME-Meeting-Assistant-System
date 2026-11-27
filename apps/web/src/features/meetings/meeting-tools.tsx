import { useUiTranslation } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MeetingActionsPanel } from '@/features/action-items/meeting-actions-panel'
import { DecisionsPanel } from './intelligence/decisions-panel'
import { ExportPanel } from './intelligence/export-panel'
import { MinutesPanel } from './intelligence/minutes-panel'
import { SummaryPanel } from './intelligence/summary-panel'
import { TranscriptReviewWorkspace } from './intelligence/transcript-review-workspace'
import { ProcessingPanel } from './media/processing-panel'
import { RecordingPanel } from './media/recording-panel'
import { UploadPanel } from './media/upload-panel'
import { useMeetingWorkspace } from './meeting-workspace-context'
import type {
  EvidenceReferenceIssue,
  EvidenceReturn,
  IntelligenceView,
  MeetingWorkspaceSection,
} from './meeting-workspace-navigation'

export function MeetingTools({
  meetingId,
  section,
  evidenceTranscriptId,
  evidenceSegmentId,
  evidenceContentRevision,
  evidenceReferenceIssue,
  intelligenceView = 'summary',
  evidenceReturn,
  onSectionChange,
  onEvidenceNavigate,
}: {
  meetingId: string
  section: Exclude<MeetingWorkspaceSection, 'overview'>
  evidenceTranscriptId?: string
  evidenceSegmentId?: string
  evidenceContentRevision?: number
  evidenceReferenceIssue?: EvidenceReferenceIssue
  intelligenceView?: IntelligenceView
  evidenceReturn?: EvidenceReturn
  onSectionChange?: (
    section: MeetingWorkspaceSection,
    replace?: boolean,
    view?: IntelligenceView
  ) => void
  onEvidenceNavigate?: (
    transcriptId: string,
    segmentId: string,
    contentRevision?: number
  ) => void
}) {
  const { t } = useUiTranslation()
  const { capabilities, identity, participants } = useMeetingWorkspace()

  if (section === 'recording') {
    if (!capabilities.canReadMeetingContent) return <WorkspaceAccessMessage />
    return (
      <div className='space-y-5'>
        <FeatureSectionHeading
          title={t('workspace:recordingSection')}
          description={t('workspace:recordingSectionDescription')}
        />
        {!capabilities.canSubmitMedia && (
          <ReadOnlyNote>{t('workspace:recordingReadOnly')}</ReadOnlyNote>
        )}
        <RecordingPanel
          meetingId={meetingId}
          canRecordAudio={capabilities.canRecordAudio}
          canSubmitMedia={capabilities.canSubmitMedia}
        />
        <UploadPanel
          meetingId={meetingId}
          canSubmitMedia={capabilities.canSubmitMedia}
        />
        <ProcessingPanel
          meetingId={meetingId}
          canAdmitProcessing={capabilities.canAdmitProcessing}
          canRecoverProcessing={capabilities.canRecoverProcessing}
        />
      </div>
    )
  }

  if (section === 'transcript') {
    if (!capabilities.canReadMeetingContent) return <WorkspaceAccessMessage />
    return (
      <div className='space-y-5'>
        <FeatureSectionHeading
          title={t('workspace:transcriptSection')}
          description={t('workspace:transcriptSectionDescription')}
        />
        {!capabilities.canCorrectTranscript && (
          <ReadOnlyNote>{t('workspace:transcriptReadOnly')}</ReadOnlyNote>
        )}
        {evidenceReturn === 'decisions' && capabilities.canReadIntelligence && (
          <Button
            variant='outline'
            onClick={() =>
              onSectionChange?.('intelligence', false, 'decisions')
            }
          >
            {t('workspace:backToDecisions')}
          </Button>
        )}
        {evidenceReturn === 'action-items' &&
          capabilities.canReadActionItems && (
            <Button
              variant='outline'
              onClick={() => onSectionChange?.('action-items')}
            >
              {t('workspace:backToActions')}
            </Button>
          )}
        <TranscriptReviewWorkspace
          meetingId={meetingId}
          canReadMeetingContent={capabilities.canReadMeetingContent}
          canCorrectTranscript={capabilities.canCorrectTranscript}
          canMapSpeakers={capabilities.canMapSpeakers}
          canReadMedia={capabilities.canReadMedia}
          evidenceTranscriptId={evidenceTranscriptId}
          evidenceSegmentId={evidenceSegmentId}
          evidenceContentRevision={evidenceContentRevision}
          evidenceReferenceIssue={evidenceReferenceIssue}
        />
      </div>
    )
  }

  if (section === 'intelligence') {
    if (!capabilities.canReadIntelligence) return <WorkspaceAccessMessage />
    return (
      <div className='space-y-5'>
        <FeatureSectionHeading
          title={t('workspace:intelligenceSection')}
          description={t('workspace:intelligenceSectionDescription')}
        />
        {!capabilities.canMutateIntelligence && (
          <ReadOnlyNote>{t('workspace:intelligenceReadOnly')}</ReadOnlyNote>
        )}
        <Tabs
          value={intelligenceView}
          activationMode='manual'
          onValueChange={(value) =>
            onSectionChange?.('intelligence', false, value as IntelligenceView)
          }
        >
          <TabsList
            aria-label={t('workspace:intelligenceViews')}
            className='w-full justify-start sm:w-fit'
          >
            <TabsTrigger value='summary'>{t('workspace:summary')}</TabsTrigger>
            <TabsTrigger value='decisions'>
              {t('workspace:decisions')}
            </TabsTrigger>
            <TabsTrigger value='minutes'>{t('workspace:minutes')}</TabsTrigger>
          </TabsList>
          <TabsContent value='summary'>
            {intelligenceView === 'summary' && (
              <div className='space-y-5'>
                <SummaryPanel
                  meetingId={meetingId}
                  canEdit={capabilities.canMutateIntelligence}
                  canRegenerate={capabilities.canAdmitProcessing}
                />
              </div>
            )}
          </TabsContent>
          <TabsContent value='decisions'>
            {intelligenceView === 'decisions' && (
              <div className='space-y-5'>
                <DecisionsPanel
                  meetingId={meetingId}
                  canManageDecisions={capabilities.canMutateIntelligence}
                  onEvidenceNavigate={onEvidenceNavigate}
                />
              </div>
            )}
          </TabsContent>
          <TabsContent value='minutes'>
            {intelligenceView === 'minutes' && (
              <div className='space-y-5'>
                <MinutesPanel
                  meetingId={meetingId}
                  names={Object.fromEntries([
                    ...participants.flatMap((participant) =>
                      participant.displayName
                        ? [[participant.userId, participant.displayName]]
                        : []
                    ),
                    [identity.userId, identity.displayName],
                  ])}
                  onOpenSummary={
                    onSectionChange
                      ? () => onSectionChange('intelligence', false, 'summary')
                      : undefined
                  }
                  onOpenDecisions={
                    onSectionChange
                      ? () =>
                          onSectionChange('intelligence', false, 'decisions')
                      : undefined
                  }
                  onOpenActions={
                    onSectionChange && capabilities.canReadActionItems
                      ? () => onSectionChange('action-items')
                      : undefined
                  }
                  onOpenTranscript={
                    onSectionChange
                      ? () => onSectionChange('transcript')
                      : undefined
                  }
                />
                <ExportPanel
                  meetingId={meetingId}
                  canExport={capabilities.canReadMeetingContent}
                />
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    )
  }

  if (section === 'action-items') {
    if (!capabilities.canReadActionItems) return <WorkspaceAccessMessage />
    return (
      <div className='space-y-5'>
        <FeatureSectionHeading
          title={t('workspace:actionSection')}
          description={t('workspace:actionSectionDescription')}
        />
        <MeetingActionsPanel
          meetingId={meetingId}
          canManageActionItems={capabilities.canManageActionItems}
          resolveManagementCapability={
            capabilities.actionItemManagementResolution === 'unresolved'
          }
          canReadMeetingContent={capabilities.canReadMeetingContent}
          onEvidenceNavigate={onEvidenceNavigate}
        />
      </div>
    )
  }

  return null
}

function FeatureSectionHeading({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className='space-y-1'>
      <h2 className='text-xl font-semibold tracking-tight'>{title}</h2>
      <p className='max-w-3xl text-sm text-muted-foreground'>{description}</p>
    </div>
  )
}

function ReadOnlyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className='rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground'>
      {children}
    </p>
  )
}

function WorkspaceAccessMessage() {
  const { t } = useUiTranslation()
  return (
    <div
      role='status'
      className='rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground'
    >
      {t('workspace:membershipRequired')}
    </div>
  )
}
