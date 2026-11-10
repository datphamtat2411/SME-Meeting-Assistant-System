import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { coreApi } from '@/lib/core-api'

const meetingCard = z.object({
  id: z.string().uuid(), title: z.string(), status: z.string(),
  scheduledStartAt: z.string().nullable(), scheduledEndAt: z.string().nullable(), endedAt: z.string().nullable(),
})
const assigned = z.object({ open: z.number(), inProgress: z.number(), done: z.number(), overdue: z.number() })
export const personalDashboardSchema = z.object({
  asOf: z.string(), timezone: z.string(),
  meetingCountsByState: z.record(z.string(), z.number()),
  upcomingMeetings: z.array(meetingCard), recentMeetings: z.array(meetingCard),
  assignedActionItems: assigned,
})
export const managementDashboardSchema = z.object({
  asOf: z.string(), timezone: z.string(),
  actionItems: assigned.extend({ cancelled: z.number(), totalOfficial: z.number() }),
  unavailableMetrics: z.array(z.object({ metric: z.string(), reason: z.string() })),
  scope: z.object({ type: z.string(), organizationalUnitIds: z.array(z.string()) }),
})
export const personalDashboardQuery = () => queryOptions({
  queryKey: ['dashboard', 'me'],
  queryFn: async ({ signal }) => personalDashboardSchema.parse(await coreApi.get<unknown>('/dashboard/me', { signal })),
  retry: false,
})
export function managementDashboardQuery(days = 30) {
  const to = new Date(), from = new Date(to.getTime() - days * 86400000)
  return queryOptions({
    queryKey: ['dashboard', 'management', days],
    queryFn: async ({ signal }) => managementDashboardSchema.parse(await coreApi.get<unknown>('/dashboard/management', { params: { from: from.toISOString(), to: to.toISOString() }, signal })),
    retry: false,
  })
}
