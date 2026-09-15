import { createFileRoute } from '@tanstack/react-router'
import { MeetingWorkspacePage } from '@/features/meetings/meeting-workspace'

export const Route = createFileRoute('/_authenticated/meetings/$meetingId')({
  component: MeetingRoute,
})

// eslint-disable-next-line react-refresh/only-export-components
function MeetingRoute() {
  const { meetingId } = Route.useParams()

  return <MeetingWorkspacePage key={meetingId} meetingId={meetingId} />
}
