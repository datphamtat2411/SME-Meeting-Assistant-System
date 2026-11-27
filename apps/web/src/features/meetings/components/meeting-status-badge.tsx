import { useUiTranslation } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import type { MeetingStatus } from '../data'
import type { MeetingLifecycleStatus } from '../data/list-api'
import {
  canonicalStyles,
  meetingStatusStyles,
  meetingStatusTranslationKeys,
} from './meeting-status-badge-config'

type MeetingStatusBadgeStatus = MeetingStatus | MeetingLifecycleStatus

function isCanonicalStatus(
  status: MeetingStatusBadgeStatus
): status is MeetingLifecycleStatus {
  return status === status.toUpperCase()
}

export function MeetingStatusBadge({
  status,
  className,
}: {
  status: MeetingStatusBadgeStatus
  className?: string
}) {
  const { t } = useUiTranslation()
  const canonical = isCanonicalStatus(status)

  return (
    <Badge
      variant='outline'
      className={cn(
        canonical ? canonicalStyles[status] : meetingStatusStyles[status],
        className
      )}
    >
      {t(meetingStatusTranslationKeys[status])}
    </Badge>
  )
}
