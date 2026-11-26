import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { isValidTimeZone } from '@/lib/presentation-time'
import {
  isValidOffsetDateTime,
  meetingLifecycleStatuses,
} from '@/features/meetings/data/list-api'

const instant = z.string().refine(isValidOffsetDateTime)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const windowSchema = z
  .object({
    fromInclusive: instant,
    toExclusive: instant,
    limit: z.number().int().min(1).max(50),
  })
  .refine(
    (window) =>
      Date.parse(window.fromInclusive) < Date.parse(window.toExclusive)
  )

const meetingCard = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: z.enum(meetingLifecycleStatuses),
  scheduledStartAt: instant.nullable(),
  scheduledEndAt: instant.nullable(),
  endedAt: instant.nullable(),
})
const assigned = z.object({
  open: count,
  inProgress: count,
  done: count,
  overdue: count,
})
export const personalDashboardSchema = z
  .object({
    asOf: instant,
    timezone: z.string().refine(isValidTimeZone),
    upcomingWindow: windowSchema,
    recentWindow: windowSchema,
    meetingCountsByState: z.partialRecord(
      z.enum(meetingLifecycleStatuses),
      count
    ),
    upcomingMeetings: z.array(meetingCard),
    recentMeetings: z.array(meetingCard),
    assignedActionItems: assigned,
  })
  .superRefine((data, context) => {
    const validList = (
      meetings: z.infer<typeof meetingCard>[],
      window: z.infer<typeof windowSchema>,
      status: 'SCHEDULED' | 'ENDED',
      field: 'scheduledStartAt' | 'endedAt'
    ) =>
      meetings.length <= window.limit &&
      new Set(meetings.map((meeting) => meeting.id)).size === meetings.length &&
      meetings.every((meeting) => {
        const timestamp = meeting[field]
        return (
          meeting.status === status &&
          timestamp !== null &&
          Date.parse(timestamp) >= Date.parse(window.fromInclusive) &&
          Date.parse(timestamp) < Date.parse(window.toExclusive) &&
          (status !== 'SCHEDULED' ||
            (meeting.scheduledEndAt !== null &&
              Date.parse(meeting.scheduledEndAt) > Date.parse(timestamp)))
        )
      })
    if (
      !validList(
        data.upcomingMeetings,
        data.upcomingWindow,
        'SCHEDULED',
        'scheduledStartAt'
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['upcomingMeetings'],
        message: 'Invalid upcoming meeting window.',
      })
    }
    if (
      !validList(data.recentMeetings, data.recentWindow, 'ENDED', 'endedAt')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['recentMeetings'],
        message: 'Invalid recent meeting window.',
      })
    }
    if (
      Date.parse(data.upcomingWindow.fromInclusive) !== Date.parse(data.asOf) ||
      Date.parse(data.recentWindow.toExclusive) !== Date.parse(data.asOf)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['asOf'],
        message: 'Reporting windows do not match the snapshot reference time.',
      })
    }
    const actions = data.assignedActionItems
    if (actions.overdue > actions.open + actions.inProgress) {
      context.addIssue({
        code: 'custom',
        path: ['assignedActionItems', 'overdue'],
        message: 'Overdue exceeds pending official work.',
      })
    }
  })

export type PersonalDashboard = z.infer<typeof personalDashboardSchema>

export function parsePersonalDashboard(value: unknown): PersonalDashboard {
  const result = personalDashboardSchema.safeParse(value)
  if (!result.success) {
    throw new CoreApiError({
      message: 'Core API returned an invalid personal dashboard response.',
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
      cause: result.error,
    })
  }
  return result.data
}
export const personalDashboardQuery = (scope: string) =>
  queryOptions({
    queryKey: ['dashboard', 'me', scope],
    queryFn: async ({ signal }) =>
      parsePersonalDashboard(
        await coreApi.get<unknown>('/dashboard/me', { signal })
      ),
    retry: false,
  })
export type ManagementSelection = {
  from: string
  to: string
  orgUnitId?: string
}

export const managementDashboardSchema = z
  .object({
    asOf: instant,
    timezone: z.string().refine(isValidTimeZone),
    period: z.object({
      fromInclusive: instant,
      toExclusive: instant,
      cohortTimeField: z.literal('ACTION_ITEM_CREATED_AT'),
      statusTimeSemantics: z.literal('CURRENT_STATE'),
    }),
    actionItems: z.object({
      open: count,
      inProgress: count,
      done: count,
      overdue: count,
      cancelled: count,
      totalOfficial: count,
    }),
    unavailableMetrics: z.array(
      z.object({ metric: z.string().min(1), reason: z.string().min(1) })
    ),
    scope: z.object({
      type: z.literal('MANAGED_OFFICIAL_ACTION_ITEMS'),
      organizationalUnitIds: z.array(z.string().uuid()).min(1),
    }),
  })
  .superRefine((data, context) => {
    const { open, inProgress, done, cancelled, overdue, totalOfficial } =
      data.actionItems
    const ids = data.scope.organizationalUnitIds
    if (
      overdue > open + inProgress ||
      open + inProgress + done + cancelled !== totalOfficial ||
      new Set(ids).size !== ids.length ||
      Date.parse(data.period.fromInclusive) >= Date.parse(data.period.toExclusive)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Contradictory management reporting projection.',
      })
    }
  })

export function parseManagementDashboard(
  value: unknown,
  selection: ManagementSelection,
  authorizedUnitIds: readonly string[]
) {
  const result = managementDashboardSchema.safeParse(value)
  if (!result.success) {
    throw new CoreApiError({
      message: 'Core API returned an invalid management dashboard response.',
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
      cause: result.error,
    })
  }
  const data = result.data
  if (
    Date.parse(data.period.fromInclusive) !== Date.parse(selection.from) ||
    Date.parse(data.period.toExclusive) !== Date.parse(selection.to)
  ) {
    throw new CoreApiError({
      message: 'The returned reporting period does not match your selection.',
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
    })
  }
  const expected = selection.orgUnitId
    ? [selection.orgUnitId]
    : [...new Set(authorizedUnitIds)]
  const actual = data.scope.organizationalUnitIds
  if (
    expected.some((id) => !authorizedUnitIds.includes(id)) ||
    actual.length !== expected.length ||
    actual.some((id) => !expected.includes(id))
  ) {
    throw new CoreApiError({
      message: 'Your management scope has changed. Verify your access again.',
      code: 'DASHBOARD_SCOPE_CHANGED',
      kind: 'malformed',
    })
  }
  return data
}

export function managementDashboardQuery(
  contextKey: string,
  authorizedUnitIds: readonly string[],
  selection: ManagementSelection
) {
  return queryOptions({
    queryKey: [
      'dashboard',
      'management',
      contextKey,
      [...new Set(authorizedUnitIds)].sort(),
      selection,
    ],
    queryFn: async ({ signal }) =>
      parseManagementDashboard(
        await coreApi.get<unknown>('/dashboard/management', {
          params: selection,
          signal,
        }),
        selection,
        authorizedUnitIds
      ),
    retry: false,
  })
}
