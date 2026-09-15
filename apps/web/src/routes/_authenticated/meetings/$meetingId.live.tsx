import { createFileRoute } from '@tanstack/react-router'
import { LiveMeetingPage } from '@/features/meetings/live-meeting'

export const Route = createFileRoute(
  '/_authenticated/meetings/$meetingId/live'
)({
  component: LiveMeetingRoute,
})

// eslint-disable-next-line react-refresh/only-export-components
function LiveMeetingRoute() {
  const { meetingId } = Route.useParams()

  return <LiveMeetingPage key={meetingId} meetingId={meetingId} />
}
