import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { coreApi } from '@/lib/core-api'

export const minutesSchema = z.object({
  schemaVersion: z.number().int(), assembledAt: z.string(), sourceFingerprint: z.string(),
  completeness: z.string(), proposalsIncluded: z.boolean(), warnings: z.array(z.string()),
  meeting: z.object({ id: z.string().uuid(), title: z.string(), description: z.string().nullable(),
    organizerUserId: z.string().uuid(), status: z.string(), scheduledStartAt: z.string().nullable(),
    scheduledEndAt: z.string().nullable(), startedAt: z.string().nullable(), endedAt: z.string().nullable() }),
  summary: z.object({ availability: z.string(), id: z.string().uuid().nullable(), versionNumber: z.number().nullable(),
    content: z.string().nullable(), sourceType: z.string().nullable(), qualityStatus: z.string().nullable(),
    transcriptId: z.string().uuid().nullable(), contentRevision: z.number().nullable(),
    selectionEpoch: z.number(), isStale: z.boolean(), aiWarnings: z.array(z.string()) }),
  confirmedDecisions: z.array(z.object({ id: z.string().uuid(), content: z.string(), status: z.string(), sourceType: z.string() }).passthrough()),
  officialActionItems: z.array(z.object({ id: z.string().uuid(), title: z.string(), status: z.string(), assigneeUserId: z.string().uuid().nullable(), dueDate: z.string().nullable() }).passthrough()),
  transcript: z.object({ availability: z.string(), id: z.string().uuid().nullable(), versionNumber: z.number().nullable(),
    status: z.string().nullable(), unresolvedSegments: z.number(), unresolvedCoverageRegions: z.number() }).passthrough(),
})
export type MeetingMinutes = z.infer<typeof minutesSchema>
export function minutesQuery(meetingId: string) {
  return queryOptions({
    queryKey: ['minutes', meetingId],
    queryFn: async ({ signal }) => minutesSchema.parse(await coreApi.get<unknown>('/meetings/' + encodeURIComponent(meetingId) + '/minutes', { signal })),
    retry: false,
  })
}
