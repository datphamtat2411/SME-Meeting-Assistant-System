import {
  createFileRoute,
  Outlet,
  useBlocker,
  useMatchRoute,
} from '@tanstack/react-router'
import {
  TranscriptReviewGateBoundary,
  useTranscriptReviewGate,
} from '@/features/meetings/intelligence/transcript-review-gate'
import {
  MeetingSessionProvider,
  useMeetingSession,
} from '@/features/meetings/media/meeting-session-context'
import { MeetingAuthorizationProvider } from '@/features/meetings/meeting-authorization-context'
import { MeetingWorkspacePage } from '@/features/meetings/meeting-workspace'
import {
  activeIntelligenceView,
  meetingWorkspaceSectionSchema,
  remainsInIntelligenceReview,
  normalizeMeetingWorkspaceSearch,
  updateMeetingWorkspaceSearch,
  type MeetingWorkspaceSection,
  type IntelligenceView,
} from '@/features/meetings/meeting-workspace-navigation'

export const Route = createFileRoute('/_authenticated/meetings/$meetingId')({
  validateSearch: normalizeMeetingWorkspaceSearch,
  component: MeetingRoute,
})

// eslint-disable-next-line react-refresh/only-export-components
function MeetingRoute() {
  const { meetingId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const matchRoute = useMatchRoute()
  const isLiveRoute = matchRoute({
    to: '/meetings/$meetingId/live',
    params: { meetingId },
    fuzzy: false,
  })

  function changeSection(
    section: MeetingWorkspaceSection,
    replace = false,
    view?: IntelligenceView
  ) {
    void navigate({
      search: (previous) =>
        updateMeetingWorkspaceSearch(previous, section, view),
      replace,
    })
  }

  function navigateToEvidence(
    transcriptId: string,
    segmentId: string,
    contentRevision?: number
  ) {
    void navigate({
      search: (previous) => ({
        ...updateMeetingWorkspaceSearch(previous, 'transcript'),
        evidenceTranscriptId: transcriptId,
        evidenceSegmentId: segmentId,
        evidenceContentRevision: contentRevision,
        evidenceReferenceIssue: undefined,
        evidenceReturn:
          previous.section === 'action-items'
            ? 'action-items'
            : previous.section === 'intelligence' &&
                activeIntelligenceView(previous) === 'decisions'
              ? 'decisions'
              : undefined,
      }),
    })
  }

  return (
    <MeetingAuthorizationProvider key={meetingId} meetingId={meetingId}>
      <MeetingSessionProvider key={meetingId} meetingId={meetingId}>
        <TranscriptReviewGateBoundary meetingId={meetingId}>
          <MeetingNavigationGuard />
          {isLiveRoute ? (
            <Outlet />
          ) : (
            <MeetingWorkspacePage
              key={meetingId}
              meetingId={meetingId}
              section={
                search.evidenceTranscriptId ||
                search.evidenceSegmentId ||
                search.evidenceReferenceIssue
                  ? meetingWorkspaceSectionSchema.enum.transcript
                  : (search.section ??
                    meetingWorkspaceSectionSchema.enum.overview)
              }
              evidenceTranscriptId={search.evidenceTranscriptId}
              evidenceSegmentId={search.evidenceSegmentId}
              evidenceContentRevision={search.evidenceContentRevision}
              evidenceReferenceIssue={search.evidenceReferenceIssue}
              intelligenceView={activeIntelligenceView(search)}
              evidenceReturn={search.evidenceReturn}
              onSectionChange={changeSection}
              onEvidenceNavigate={navigateToEvidence}
            />
          )}
        </TranscriptReviewGateBoundary>
      </MeetingSessionProvider>
    </MeetingAuthorizationProvider>
  )
}

function MeetingNavigationGuard() {
  const session = useMeetingSession()
  const gate = useTranscriptReviewGate()
  useBlocker({
    enableBeforeUnload: () =>
      session.hasUnsavedResources ||
      session.hasUnsavedTranscriptReview ||
      session.hasUnsavedIntelligence ||
      gate.hasUnresolvedOperation,
    shouldBlockFn: ({ current, next }) => {
      if (
        !session.hasUnsavedResources &&
        !session.hasUnsavedTranscriptReview &&
        !session.hasUnsavedIntelligence &&
        !gate.hasUnresolvedOperation
      ) {
        return false
      }
      const nextMeetingId =
        typeof next.params === 'object' &&
        next.params !== null &&
        'meetingId' in next.params &&
        typeof next.params.meetingId === 'string'
          ? next.params.meetingId
          : undefined
      if (
        session.authorization?.isConfirmedAccessLoss ||
        session.authorization?.status === 'confirmed-authentication-loss' ||
        session.authorization?.status === 'confirmed-authorization-denial'
      ) {
        return false
      }
      const sameMeeting = nextMeetingId === session.meetingId
      if (!sameMeeting && gate.hasUnresolvedOperation) {
        return !window.confirm(
          'A transcript review request is unresolved. Leaving will lose its local recovery key. Leave anyway?'
        )
      }
      const remainsInTranscript =
        sameMeeting &&
        next.routeId === '/_authenticated/meetings/$meetingId' &&
        typeof next.search === 'object' &&
        next.search !== null &&
        (('section' in next.search && next.search.section === 'transcript') ||
          ('evidenceTranscriptId' in next.search &&
            Boolean(next.search.evidenceTranscriptId)) ||
          ('evidenceSegmentId' in next.search &&
            Boolean(next.search.evidenceSegmentId)) ||
          ('evidenceReferenceIssue' in next.search &&
            Boolean(next.search.evidenceReferenceIssue)))
      if (
        session.hasUnsavedTranscriptReview &&
        !remainsInTranscript &&
        session.authorization?.capabilities.authorizationResolution !== 'denied'
      ) {
        return !window.confirm(
          'Unsaved transcript review work may be lost. Leave anyway?'
        )
      }
      const remainsInIntelligence =
        sameMeeting &&
        next.routeId === '/_authenticated/meetings/$meetingId' &&
        remainsInIntelligenceReview(
          normalizeMeetingWorkspaceSearch(current.search),
          normalizeMeetingWorkspaceSearch(next.search)
        )
      if (
        session.hasUnsavedIntelligence &&
        !remainsInIntelligence &&
        session.authorization?.capabilities.authorizationResolution !== 'denied'
      ) {
        return !window.confirm(
          'Unsaved meeting intelligence work may be lost. Leave anyway?'
        )
      }
      if (sameMeeting || !session.hasUnsavedResources) return false
      return !window.confirm(
        'Active or unsaved meeting audio will be lost if you leave this meeting. Leave anyway?'
      )
    },
  })
  return null
}
