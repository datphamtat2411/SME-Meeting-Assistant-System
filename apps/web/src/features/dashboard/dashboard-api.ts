import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi } from '@/lib/core-api'
import {
  isValidOffsetDateTime,
  meetingLifecycleStatuses,
} from '@/features/meetings/data/list-api'
import { isValidTimeZone } from '@/lib/presentation-time'

const instant = z.string().refine(isValidOffsetDateTime)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const windowSchema = z.object({
  fromInclusive: instant,
  toExclusive: instant,
  limit: z.number().int().min(1).max(50),
}).refine(
  (window) => Date.parse(window.fromInclusive) < Date.parse(window.toExclusive)
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
export const personalDashboardSchema = z.object({
  asOf: instant,
  timezone: z.string().refine(isValidTimeZone),
  upcomingWindow: windowSchema,
  recentWindow: windowSchema,
  meetingCountsByState: z.partialRecord(z.enum(meetingLifecycleStatuses), count),
  upcomingMeetings: z.array(meetingCard),
  recentMeetings: z.array(meetingCard),
  assignedActionItems: assigned,
}).superRefine((data, context) => {
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
        meeting.status === status && timestamp !== null &&
        Date.parse(timestamp) >= Date.parse(window.fromInclusive) &&
        Date.parse(timestamp) < Date.parse(window.toExclusive) &&
        (status !== 'SCHEDULED' || (
          meeting.scheduledEndAt !== null &&
          Date.parse(meeting.scheduledEndAt) > Date.parse(timestamp)
        ))
      )
    })
  if (!validList(data.upcomingMeetings, data.upcomingWindow, 'SCHEDULED', 'scheduledStartAt')) {
    context.addIssue({ code: 'custom', path: ['upcomingMeetings'], message: 'Invalid upcoming meeting window.' })
  }
  if (!validList(data.recentMeetings, data.recentWindow, 'ENDED', 'endedAt')) {
    context.addIssue({ code: 'custom', path: ['recentMeetings'], message: 'Invalid recent meeting window.' })
  }
  if (Date.parse(data.upcomingWindow.fromInclusive) !== Date.parse(data.asOf) ||
    Date.parse(data.recentWindow.toExclusive) !== Date.parse(data.asOf)) {
    context.addIssue({ code: 'custom', path: ['asOf'], message: 'Reporting windows do not match the snapshot reference time.' })
  }
  const actions = data.assignedActionItems
  if (actions.overdue > actions.open + actions.inProgress) {
    context.addIssue({ code: 'custom', path: ['assignedActionItems', 'overdue'], message: 'Overdue exceeds pending official work.' })
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
export const managementDashboardSchema = z.object({
  asOf: z.string(),
  timezone: z.string(),
  actionItems: z.object({
    open: z.number(),
    inProgress: z.number(),
    done: z.number(),
    overdue: z.number(),
    cancelled: z.number(),
    totalOfficial: z.number(),
  }),
  unavailableMetrics: z.array(
    z.object({ metric: z.string(), reason: z.string() })
  ),
  scope: z.object({
    type: z.string(),
    organizationalUnitIds: z.array(z.string()),
  }),
})
export const personalDashboardQuery = (scope: string) =>
  queryOptions({
    queryKey: ['dashboard', 'me', scope],
    queryFn: async ({ signal }) =>
      parsePersonalDashboard(
        await coreApi.get<unknown>('/dashboard/me', { signal })
      ),
    retry: false,
  })
export function managementDashboardQuery(days = 30) {
  // Anchor to tomorrow's UTC midnight so a rerender never changes the query key.
  const to = new Date((Math.floor(Date.now() / 86400000) + 1) * 86400000)
  const from = new Date(to.getTime() - days * 86400000)
  return queryOptions({
    queryKey: [
      'dashboard',
      'management',
      days,
      from.toISOString(),
      to.toISOString(),
    ],
    queryFn: async ({ signal }) =>
      managementDashboardSchema.parse(
        await coreApi.get<unknown>('/dashboard/management', {
          params: { from: from.toISOString(), to: to.toISOString() },
          signal,
        })
      ),
    retry: false,
  })
}
