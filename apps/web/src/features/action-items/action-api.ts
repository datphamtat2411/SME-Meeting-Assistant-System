import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi, normalizeCoreApiError } from '@/lib/core-api'
import {
  paginationParams,
  validatedPageInfo,
  type PageInfo,
} from '@/lib/list-pagination'

const capabilitySchema = z.object({
  canEdit: z.boolean(),
  canAssign: z.boolean(),
  canConfirm: z.boolean(),
  canReject: z.boolean(),
  canStart: z.boolean(),
  canComplete: z.boolean(),
  canCancel: z.boolean(),
  canReopen: z.boolean(),
  canAccessMeeting: z.boolean(),
  canAccessEvidence: z.boolean(),
})

const assigneeSchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().nullable(),
    active: z.boolean(),
  })
  .nullable()

const evidenceSchema = z.object({
  availability: z.enum([
    'AVAILABLE',
    'UNAVAILABLE',
    'STALE',
    'RESTRICTED',
    'NOT_APPLICABLE',
  ]),
  transcriptId: z.string().uuid().nullable(),
  contentRevision: z.number().int().nonnegative().nullable(),
  freshness: z.enum([
    'CURRENT',
    'STALE',
    'UNKNOWN',
    'RESTRICTED',
    'NOT_APPLICABLE',
  ]),
  references: z.array(
    z.object({
      segmentId: z.string().uuid(),
      ordinal: z.number().int().nonnegative().nullable(),
      preview: z.string().nullable(),
    })
  ),
  limitation: z.string().nullable(),
})

export const actionSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  title: z.string(),
  details: z.string().nullable(),
  status: z.enum(['PROPOSED', 'OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']),
  assigneeUserId: z.string().uuid().nullable(),
  dueDate: z.string().nullable(),
  overdue: z.boolean(),
  sourceType: z.string(),
  processingJobId: z.string().uuid().nullable(),
  transcriptId: z.string().uuid().nullable(),
  contentRevision: z.number().int().nonnegative().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  confirmedByUserId: z.string().uuid().nullable(),
  confirmedAt: z.string().nullable(),
  completedByUserId: z.string().uuid().nullable(),
  completedAt: z.string().nullable(),
  cancelledByUserId: z.string().uuid().nullable(),
  cancelledAt: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isOfficial: z.boolean(),
  capabilities: capabilitySchema,
  assignee: assigneeSchema,
  meeting: z.object({
    id: z.string().uuid(),
    label: z.string(),
    restricted: z.boolean(),
  }),
  evidence: evidenceSchema,
})
export type ActionItem = z.infer<typeof actionSchema>
export type ActionStatus = ActionItem['status']
export type ActionSort =
  | 'createdAt,asc'
  | 'createdAt,desc'
  | 'dueDate,asc'
  | 'dueDate,desc'
  | 'status,asc'
  | 'status,desc'
  | 'title,asc'
  | 'title,desc'

export type ActionFilter = {
  page: number
  q: string
  status: ActionStatus | 'all'
  official: boolean | 'all'
  assignee: 'me' | 'all' | string
  overdue: boolean
  meetingId?: string
  sort: ActionSort
}

export function serializeActionFilter(
  filter: ActionFilter,
  size = 20
): Record<string, string> {
  const params: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(paginationParams(filter.page, size)).map(
        ([key, value]) => [key, String(value)]
      )
    ),
    sort: filter.sort,
  }
  if (filter.q.trim()) params.q = filter.q.trim()
  if (filter.status !== 'all') params.status = filter.status
  if (filter.official !== 'all') params.official = String(filter.official)
  if (filter.assignee !== 'all') params.assignee = filter.assignee
  if (filter.overdue) params.overdue = 'true'
  if (filter.meetingId) params.meetingId = filter.meetingId
  return params
}

export type ActionPage = { items: ActionItem[]; page: PageInfo }

function malformedActionResponse(
  message: string,
  cause?: unknown
): CoreApiError {
  return new CoreApiError({
    message,
    code: 'MALFORMED_RESPONSE',
    kind: 'malformed',
    cause,
  })
}

function parseAction(
  value: unknown,
  message = 'Core API returned a malformed Action Item response.'
) {
  const parsed = actionSchema.safeParse(value)
  if (!parsed.success) throw malformedActionResponse(message, parsed.error)
  if (parsed.data.meeting.id !== parsed.data.meetingId) {
    throw malformedActionResponse(
      'Core API returned an Action Item with inconsistent meeting identity.'
    )
  }
  return parsed.data
}

function parseActions(value: unknown): ActionItem[] {
  const parsed = actionSchema.array().safeParse(value)
  if (!parsed.success) {
    throw malformedActionResponse(
      'Core API returned a malformed Action Item collection.',
      parsed.error
    )
  }
  return parsed.data.map((item) => parseAction(item))
}

export function actionItemsQuery(filter: ActionFilter) {
  const params = serializeActionFilter(filter)
  return queryOptions({
    queryKey: ['action-items', 'list', params, filter.meetingId] as const,
    queryFn: async ({ signal }): Promise<ActionPage> => {
      const response = await coreApi.getWithMeta<unknown>('/action-items', {
        params,
        signal,
      })
      const items = parseActions(response.data)
      if (
        filter.meetingId &&
        items.some((item) => item.meetingId !== filter.meetingId)
      ) {
        throw malformedActionResponse(
          'Core API returned an Action Item outside the requested meeting.'
        )
      }
      return {
        items,
        page: (() => {
          try {
            return validatedPageInfo(response.meta.pagination, {
              requestedPage: Number(params.page),
              requestedSize: Number(params.size),
              itemCount: items.length,
            })
          } catch (error) {
            throw malformedActionResponse(
              'Core API returned inconsistent Action Item pagination metadata.',
              error
            )
          }
        })(),
      }
    },
    retry: false,
  })
}

function requireEtag(value: string | undefined): string {
  if (!value)
    throw new CoreApiError({
      message: 'Core API did not provide an Action Item concurrency token.',
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
    })
  return value
}

function parseActionResult(
  response: {
    data: unknown
    etag?: string
  },
  expected?: { id?: string; meetingId?: string }
): ActionMutationResult {
  const item = parseAction(response.data)
  if (expected?.id && item.id !== expected.id) {
    throw malformedActionResponse(
      'Core API returned a different Action Item than the requested resource.'
    )
  }
  if (expected?.meetingId && item.meetingId !== expected.meetingId) {
    throw malformedActionResponse(
      'Core API returned an Action Item from a different meeting.'
    )
  }
  return { item, etag: requireEtag(response.etag) }
}

export type ActionMutationResult = { item: ActionItem; etag: string }

export async function actionDetail(
  id: string,
  expectedMeetingId?: string
): Promise<ActionMutationResult> {
  const response = await coreApi.getWithMetaAndEtag<unknown>(
    '/action-items/' + encodeURIComponent(id)
  )
  return parseActionResult(response, { id, meetingId: expectedMeetingId })
}

export function actionDetailQuery(id?: string, meetingId?: string) {
  return queryOptions({
    queryKey: ['action-items', 'detail', id, meetingId] as const,
    queryFn: () => actionDetail(id as string, meetingId),
    enabled: Boolean(id),
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  })
}

export interface ActionDraft {
  meetingId: string
  title: string
  details: string | null
  assigneeUserId: string
  dueDate: string | null
}

export async function createAction(
  data: ActionDraft,
  idempotencyKey: string
): Promise<ActionMutationResult> {
  try {
    const response = await coreApi.postWithMetaAndEtag<unknown>(
      '/action-items',
      data,
      { headers: { 'Idempotency-Key': idempotencyKey } }
    )
    return parseActionResult(response, { meetingId: data.meetingId })
  } catch (error) {
    const failure = normalizeCoreApiError(error)
    if (
      failure.isNetworkError ||
      failure.isServerError ||
      failure.kind === 'malformed' ||
      failure.recoveryOutcome === 'uncertain'
    ) {
      throw new CoreApiError({
        message:
          'Action Item creation could not be verified. Retry this same intent to recover it.',
        code: 'ACTION_ITEM_CREATION_UNCERTAIN',
        kind: failure.kind,
        recoveryOutcome: 'uncertain',
        cause: error,
      })
    }
    throw error
  }
}

export type ActionEditValues = {
  title: string
  details: string
  assigneeUserId: string
  dueDate: string
}

export function buildActionPatch(
  snapshot: ActionItem,
  values: ActionEditValues
): {
  title?: string
  details?: string | null
  assigneeUserId?: string | null
  dueDate?: string | null
} {
  const patch: {
    title?: string
    details?: string | null
    assigneeUserId?: string | null
    dueDate?: string | null
  } = {}
  const title = values.title.trim()
  const details = values.details.trim() || null
  const assigneeUserId = values.assigneeUserId || null
  const dueDate = values.dueDate || null
  if (title !== snapshot.title) patch.title = title
  if (details !== snapshot.details) patch.details = details
  if (assigneeUserId !== snapshot.assigneeUserId) {
    patch.assigneeUserId = assigneeUserId
  }
  if (dueDate !== snapshot.dueDate) patch.dueDate = dueDate
  return patch
}

/** Keep only the user's explicitly changed fields when reviewing a new baseline. */
export function rebaseActionDraft(
  reviewed: ActionItem,
  latest: ActionItem,
  pending: ActionEditValues
): ActionEditValues {
  const changed = buildActionPatch(reviewed, pending)
  return {
    title: changed.title ?? latest.title,
    details:
      (changed.details !== undefined ? changed.details : latest.details) ?? '',
    assigneeUserId:
      (changed.assigneeUserId !== undefined
        ? changed.assigneeUserId
        : latest.assigneeUserId) ?? '',
    dueDate:
      (changed.dueDate !== undefined ? changed.dueDate : latest.dueDate) ?? '',
  }
}

export async function patchAction(
  id: string,
  etag: string,
  patch: ReturnType<typeof buildActionPatch>,
  expectedMeetingId?: string
): Promise<ActionMutationResult> {
  if (!Object.keys(patch).length) {
    throw new Error('No Action Item changes to save.')
  }
  const response = await coreApi.patchWithMetaAndEtag<unknown>(
    '/action-items/' + encodeURIComponent(id),
    patch,
    { headers: { 'If-Match': etag } }
  )
  return parseActionResult(response, { id, meetingId: expectedMeetingId })
}

export type ActionCommand =
  | 'confirm'
  | 'reject'
  | 'start'
  | 'complete'
  | 'cancel'
  | 'reopen'

export async function actionCommand(
  id: string,
  command: ActionCommand,
  etag: string,
  expectedMeetingId?: string
): Promise<ActionMutationResult> {
  const response = await coreApi.postWithMetaAndEtag<unknown>(
    '/action-items/' + encodeURIComponent(id) + '/' + command,
    undefined,
    { headers: { 'If-Match': etag } }
  )
  return parseActionResult(response, { id, meetingId: expectedMeetingId })
}

const lookupPaginationSchema = z.object({
  page: z.number().int().nonnegative(),
  size: z.number().int().min(1).max(20),
  totalElements: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  hasNext: z.boolean(),
  hasPrevious: z.boolean(),
})

const lookupPage = z.object({
  data: z.array(z.unknown()),
  meta: z.object({ pagination: lookupPaginationSchema }),
})

export type ManagementTarget = {
  id: string
  label: string
}

export type AssigneeCandidate = {
  id: string
  displayName: string
  email: string
  organizationalUnitName: string | null
  active: boolean
}

async function lookupQuery<T>(
  path: string,
  params: Record<string, string>,
  schema: z.ZodType<T>,
  signal?: AbortSignal
) {
  const response = await coreApi.getWithMeta<unknown>(path, { params, signal })
  const envelope = lookupPage.parse(response)
  const items = z.array(schema).parse(envelope.data)
  return {
    items,
    page: validatedPageInfo(envelope.meta.pagination, {
      requestedPage: Number(params.page),
      requestedSize: Number(params.size),
      itemCount: items.length,
    }),
  }
}

export function managementTargetsQuery(search: string, page = 0) {
  const params = {
    ...Object.fromEntries(
      Object.entries(paginationParams(page, 20)).map(([key, value]) => [
        key,
        String(value),
      ])
    ),
    q: search.trim(),
  }
  return queryOptions({
    queryKey: ['action-items', 'management-targets', params] as const,
    queryFn: ({ signal }) =>
      lookupQuery(
        '/action-items/management-targets',
        params,
        z.object({ id: z.string().uuid(), label: z.string() }),
        signal
      ),
    enabled: search.trim().length >= 2,
    retry: false,
  })
}

export function managementCapabilityQuery() {
  return queryOptions({
    queryKey: ['action-items', 'management-capability'] as const,
    queryFn: async () => {
      const response = await coreApi.getWithMeta<unknown>(
        '/action-items/management-capability'
      )
      return z.object({ canCreate: z.boolean() }).parse(response.data)
    },
    retry: false,
  })
}

export function assigneeCandidatesQuery(
  search: string,
  meetingId: string,
  page = 0
) {
  const params = {
    ...Object.fromEntries(
      Object.entries(paginationParams(page, 20)).map(([key, value]) => [
        key,
        String(value),
      ])
    ),
    q: search.trim(),
    meetingId,
  }
  return queryOptions({
    queryKey: ['action-items', 'assignee-candidates', params] as const,
    queryFn: ({ signal }) =>
      lookupQuery(
        '/action-items/assignee-candidates',
        params,
        z.object({
          id: z.string().uuid(),
          displayName: z.string(),
          email: z.string(),
          organizationalUnitName: z.string().nullable(),
          active: z.boolean(),
        }),
        signal
      ),
    enabled: search.trim().length >= 2,
    retry: false,
  })
}
