import { z } from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { MeetingsPage } from '@/features/meetings'
import {
  defaultMeetingSort,
  isValidOffsetDateTime,
  meetingLifecycleStatuses,
  meetingRelationships,
  meetingSortValues,
} from '@/features/meetings/data/list-api'

const meetingSearchSchema = z.object({
  q: z.string().optional().catch(''),
  status: z.enum(meetingLifecycleStatuses).optional().catch(undefined),
  relationship: z.enum(meetingRelationships).optional().catch(undefined),
  from: z
    .string()
    .refine(isValidOffsetDateTime)
    .optional()
    .catch(undefined),
  to: z
    .string()
    .refine(isValidOffsetDateTime)
    .optional()
    .catch(undefined),
  roomId: z.string().optional().catch(undefined),
  organizerId: z.string().optional().catch(undefined),
  sort: z.enum(meetingSortValues).optional().catch(defaultMeetingSort),
  page: z.number().int().min(1).optional().catch(1),
  pageSize: z.number().int().min(1).max(100).optional().catch(10),
})

export const Route = createFileRoute('/_authenticated/meetings/')({
  validateSearch: meetingSearchSchema,
  component: MeetingsPage,
})
