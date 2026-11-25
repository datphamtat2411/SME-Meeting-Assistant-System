import { createFileRoute, Outlet, useMatchRoute } from '@tanstack/react-router'
import { MeetingSessionProvider } from '@/features/meetings/media/meeting-session-context'
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
    <MeetingSessionProvider key={meetingId} meetingId={meetingId}>
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
  )
}
