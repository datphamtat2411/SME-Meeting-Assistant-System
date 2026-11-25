import {
  createFileRoute,
  Outlet,
  useBlocker,
  useMatchRoute,
} from '@tanstack/react-router'
import {
  MeetingSessionProvider,
  useMeetingSession,
} from '@/features/meetings/media/meeting-session-context'
import { MeetingAuthorizationProvider } from '@/features/meetings/meeting-authorization-context'
import { MeetingWorkspacePage } from '@/features/meetings/meeting-workspace'
import {
  meetingWorkspaceSectionSchema,
  normalizeMeetingWorkspaceSearch,
  updateMeetingWorkspaceSearch,
  type MeetingWorkspaceSection,
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

  function changeSection(section: MeetingWorkspaceSection, replace = false) {
    void navigate({
      search: (previous) => updateMeetingWorkspaceSearch(previous, section),
      replace,
    })
  }

  return (
    <MeetingAuthorizationProvider key={meetingId} meetingId={meetingId}>
      <MeetingSessionProvider key={meetingId} meetingId={meetingId}>
        <MeetingNavigationGuard />
        {isLiveRoute ? (
          <Outlet />
        ) : (
          <MeetingWorkspacePage
            key={meetingId}
            meetingId={meetingId}
            section={
              search.section ?? meetingWorkspaceSectionSchema.enum.overview
            }
            onSectionChange={changeSection}
          />
        )}
      </MeetingSessionProvider>
    </MeetingAuthorizationProvider>
  )
}

function MeetingNavigationGuard() {
  const session = useMeetingSession()
  useBlocker({
    enableBeforeUnload: () =>
      session.hasUnsavedResources || session.hasUnsavedTranscriptReview,
    shouldBlockFn: ({ next }) => {
      if (!session.hasUnsavedResources && !session.hasUnsavedTranscriptReview) {
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
      const remainsInTranscript =
        sameMeeting &&
        next.routeId === '/_authenticated/meetings/$meetingId' &&
        typeof next.search === 'object' &&
        next.search !== null &&
        'section' in next.search &&
        next.search.section === 'transcript'
      if (
        session.hasUnsavedTranscriptReview &&
        !remainsInTranscript &&
        session.authorization?.capabilities.authorizationResolution !== 'denied'
      ) {
        return !window.confirm(
          'Unsaved transcript review work may be lost. Leave anyway?'
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
