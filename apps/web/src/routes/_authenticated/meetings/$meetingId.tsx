import { createFileRoute, Outlet, useMatchRoute } from '@tanstack/react-router'
import { MeetingWorkspacePage } from '@/features/meetings/meeting-workspace'

export const Route = createFileRoute('/_authenticated/meetings/$meetingId')({
  component: MeetingRoute,
})

// eslint-disable-next-line react-refresh/only-export-components
function MeetingRoute() {
  const { meetingId } = Route.useParams()
  const matchRoute = useMatchRoute()
  const isLiveRoute = matchRoute({
    to: '/meetings/$meetingId/live',
    params: { meetingId },
    fuzzy: false,
  })

  return isLiveRoute ? (
    <Outlet />
  ) : (
    <MeetingWorkspacePage key={meetingId} meetingId={meetingId} />
  )
}
