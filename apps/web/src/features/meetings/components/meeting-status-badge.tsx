import { Badge } from '@/components/ui/badge'
import type { MeetingStatus } from '../data'
import type { MeetingLifecycleStatus } from '../data/list-api'
import {
  canonicalLabels,
  canonicalStyles,
  meetingStatusLabels,
  meetingStatusStyles,
} from './meeting-status-badge-config'

type MeetingStatusBadgeStatus = MeetingStatus | MeetingLifecycleStatus

function isCanonicalStatus(
  status: MeetingStatusBadgeStatus
): status is MeetingLifecycleStatus {
  return status === status.toUpperCase()
}

export function MeetingStatusBadge({
  status,
}: {
  status: MeetingStatusBadgeStatus
}) {
  const canonical = isCanonicalStatus(status)

  return (
    <Badge
      variant='outline'
      className={
        canonical ? canonicalStyles[status] : meetingStatusStyles[status]
      }
    >
      {canonical ? canonicalLabels[status] : meetingStatusLabels[status]}
    </Badge>
  )
}
