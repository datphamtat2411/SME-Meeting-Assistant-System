import { MeetingActionsPanel } from '@/features/action-items/meeting-actions-panel'
import { DecisionsPanel } from './intelligence/decisions-panel'
import { ExportPanel } from './intelligence/export-panel'
import { MinutesPanel } from './intelligence/minutes-panel'
import { SummaryPanel } from './intelligence/summary-panel'
import {
  TranscriptReviewAdmissionPanel,
  TranscriptReviewWorkflowStatus,
} from './intelligence/transcript-review-admission-panel'
import {
  TranscriptReviewGateBoundary,
  useOptionalTranscriptReviewGate,
} from './intelligence/transcript-review-gate'
import { TranscriptReviewWorkspace } from './intelligence/transcript-review-workspace'
import { MeetingSessionBoundary } from './media/meeting-session-context'
import { ProcessingPanel } from './media/processing-panel'
import { RecordingPanel } from './media/recording-panel'
import { UploadPanel } from './media/upload-panel'
import { useMeetingWorkspace } from './meeting-workspace-context'
import type {
  EvidenceReferenceIssue,
  MeetingWorkspaceSection,
} from './meeting-workspace-navigation'

export function MeetingTools({
  meetingId,
  section,
  evidenceTranscriptId,
  evidenceSegmentId,
  evidenceContentRevision,
  evidenceReferenceIssue,
  onSectionChange,
  onEvidenceNavigate,
}: {
  meetingId: string
  section: Exclude<MeetingWorkspaceSection, 'overview'>
  evidenceTranscriptId?: string
  evidenceSegmentId?: string
  evidenceContentRevision?: number
  evidenceReferenceIssue?: EvidenceReferenceIssue
  onSectionChange?: (
    section: MeetingWorkspaceSection,
    replace?: boolean
  ) => void
  onEvidenceNavigate?: (
    transcriptId: string,
    segmentId: string,
    contentRevision?: number
  ) => void
}) {
  const { capabilities, identity, participants } = useMeetingWorkspace()
  const reviewGate = useOptionalTranscriptReviewGate()

  if (section === 'recording') {
    if (!capabilities.canReadMeetingContent) return <WorkspaceAccessMessage />
    return (
      <div className='space-y-5'>
        <FeatureSectionHeading
          title='Recording & source media'
          description='Capture or add a source recording, review available files, and open processing details when needed.'
        />
        {!capabilities.canSubmitMedia && (
          <ReadOnlyNote>
            Source media is available to review. Only the meeting organizer can
            add a recording or request processing.
          </ReadOnlyNote>
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
    const content = (
      <div className='space-y-5'>
        <FeatureSectionHeading
          title='Transcript & speakers'
          description='Review the available transcript and its speaker identities. Results appear only when Core confirms they exist.'
        />
        {!capabilities.canCorrectTranscript && (
          <ReadOnlyNote>
            You can review this transcript. Corrections and speaker mapping are
            organizer operations.
          </ReadOnlyNote>
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
        <TranscriptReviewAdmissionPanel
          onNavigateToIntelligence={() => onSectionChange?.('intelligence')}
        />
      </div>
    )
    if (reviewGate) return content
    return (
      <MeetingSessionBoundary
        meetingId={meetingId}
        fallbackCapabilities={{
          canAdmitProcessing: capabilities.canAdmitProcessing,
          canReadMedia: capabilities.canReadMedia,
          canReadProcessing: capabilities.canReadProcessing,
        }}
      >
        <TranscriptReviewGateBoundary
          meetingId={meetingId}
          fallbackCanManageReview={capabilities.canAdmitProcessing}
        >
          {content}
        </TranscriptReviewGateBoundary>
      </MeetingSessionBoundary>
    )
  }

  if (section === 'intelligence') {
    if (!capabilities.canReadIntelligence) return <WorkspaceAccessMessage />
    return (
      <div className='space-y-5'>
        <FeatureSectionHeading
          title='Meeting intelligence'
          description='Review confirmed meeting results and their current source state. AI proposals remain distinct from approved records.'
        />
        {!capabilities.canMutateIntelligence && (
          <ReadOnlyNote>
            You can review available results. Editing, review, and regeneration
            operations are available to the meeting organizer.
          </ReadOnlyNote>
        )}
        <TranscriptReviewWorkflowStatus
          onReview={() => onSectionChange?.('transcript')}
        />
        <SummaryPanel
          meetingId={meetingId}
          canEdit={capabilities.canMutateIntelligence}
          canRegenerate={capabilities.canAdmitProcessing}
        />
        <DecisionsPanel
          meetingId={meetingId}
          canManageDecisions={capabilities.canMutateIntelligence}
          onEvidenceNavigate={onEvidenceNavigate}
        />
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
          onOpenActions={onSectionChange ? () => onSectionChange('action-items') : undefined}
          onOpenTranscript={onSectionChange ? () => onSectionChange('transcript') : undefined}
        />
        <ExportPanel
          meetingId={meetingId}
          canExport={capabilities.canReadMeetingContent}
        />
      </div>
    )
  }

  if (section === 'action-items') {
    if (!capabilities.canReadActionItems) return <WorkspaceAccessMessage />
    return (
      <div className='space-y-5'>
        <FeatureSectionHeading
          title='Action items'
          description='Track official work and review eligible proposals. Assignment and scoped management permissions are enforced by Core.'
        />
        <MeetingActionsPanel
          meetingId={meetingId}
          canManageActionItems={capabilities.canManageActionItems}
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
  return (
    <div
      role='status'
      className='rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground'
    >
      Meeting membership must be verified before this section can be opened.
    </div>
  )
}
