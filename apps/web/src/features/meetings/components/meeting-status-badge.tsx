import { Badge } from '@/components/ui/badge'
import type { MeetingStatus } from '../data'

const labels: Record<MeetingStatus, string> = {
  scheduled: 'Upcoming',
  in_progress: 'Live',
  processing: 'Processing',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

const styles: Record<MeetingStatus, string> = {
  scheduled:
    'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300',
  in_progress:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  processing:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  completed:
    'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300',
  cancelled:
    'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
}

export function MeetingStatusBadge({ status }: { status: MeetingStatus }) {
  return (
    <Badge variant='outline' className={styles[status]}>
      {labels[status]}
    </Badge>
  )
}

export { labels as meetingStatusLabels, styles as meetingStatusStyles }
