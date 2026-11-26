import { z } from 'zod'
import { CoreApiError } from '@/lib/core-api'
import type {
  ActionItem,
  ActionStatus,
} from '@/features/action-items/action-api'
import type { PersonalDashboard } from './dashboard-api'

export const actionPreviewLimit = 5

export function orderedUpcoming(data: PersonalDashboard) {
  return [...data.upcomingMeetings].sort(
    (a, b) =>
      Date.parse(a.scheduledStartAt ?? '') -
        Date.parse(b.scheduledStartAt ?? '') || a.id.localeCompare(b.id)
  )
}

export function orderedRecent(data: PersonalDashboard) {
  return [...data.recentMeetings].sort(
    (a, b) =>
      Date.parse(b.endedAt ?? '') - Date.parse(a.endedAt ?? '') ||
      b.id.localeCompare(a.id)
  )
}

export function mergeAssignedWork(
  open: ActionItem[],
  inProgress: ActionItem[],
  actorId: string
) {
  const validate = (items: ActionItem[], status: ActionStatus) => {
    if (
      items.some(
        (item) =>
          item.status !== status ||
          !item.isOfficial ||
          item.assigneeUserId !== actorId ||
          (item.dueDate !== null &&
            !z.iso.date().safeParse(item.dueDate).success)
      )
    ) {
      throw new CoreApiError({
        message:
          'Core API returned work outside the requested assigned-work scope.',
        code: 'MALFORMED_RESPONSE',
        kind: 'malformed',
      })
    }
  }
  validate(open, 'OPEN')
  validate(inProgress, 'IN_PROGRESS')
  // Core sorts ascending due dates with nulls last and id as the tie breaker.
  // An item can move between states between the two reads. Reconcile by
  // canonical entity version, not by the order in which results are merged.
  const unique = new Map<string, ActionItem>()
  for (const item of [...open, ...inProgress]) {
    const existing = unique.get(item.id)
    if (existing?.version === item.version && existing.status !== item.status) {
      throw new CoreApiError({
        message: 'Core API returned conflicting assigned-work versions.',
        code: 'MALFORMED_RESPONSE',
        kind: 'malformed',
      })
    }
    if (!existing || item.version > existing.version) {
      unique.set(item.id, item)
    }
  }
  return [...unique.values()]
    .sort((a, b) => {
      if (a.dueDate === null && b.dueDate !== null) return 1
      if (b.dueDate === null && a.dueDate !== null) return -1
      return (
        (a.dueDate ?? '').localeCompare(b.dueDate ?? '') ||
        a.id.localeCompare(b.id)
      )
    })
    .slice(0, actionPreviewLimit)
}
