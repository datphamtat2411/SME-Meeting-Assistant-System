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

export function actionItemsQuery(filter: ActionFilter) {
  const params = serializeActionFilter(filter)
  return queryOptions({
    queryKey: ['action-items', 'list', params] as const,
    queryFn: async ({ signal }): Promise<ActionPage> => {
      const response = await coreApi.getWithMeta<unknown>('/action-items', {
        params,
        signal,
      })
      const items = actionSchema.array().parse(response.data)
      return {
        items,
        page: validatedPageInfo(response.meta.pagination, {
          requestedPage: Number(params.page),
          requestedSize: Number(params.size),
          itemCount: items.length,
        }),
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

function parseAction(value: unknown): ActionItem {
  return actionSchema.parse(value)
}

function parseActionResult(response: {
  data: unknown
  etag?: string
}): ActionMutationResult {
  return { item: parseAction(response.data), etag: requireEtag(response.etag) }
}

export type ActionMutationResult = { item: ActionItem; etag: string }

export async function actionDetail(id: string): Promise<ActionMutationResult> {
  const response = await coreApi.getWithMetaAndEtag<unknown>(
    '/action-items/' + encodeURIComponent(id)
  )
  return parseActionResult(response)
}

export function actionDetailQuery(id?: string) {
  return queryOptions({
    queryKey: ['action-items', 'detail', id] as const,
    queryFn: () => actionDetail(id as string),
    enabled: Boolean(id),
    staleTime: Infinity,
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
    return parseActionResult(response)
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

export async function patchAction(
  id: string,
  etag: string,
  patch: ReturnType<typeof buildActionPatch>
): Promise<ActionMutationResult> {
  if (!Object.keys(patch).length) {
    throw new Error('No Action Item changes to save.')
  }
  const response = await coreApi.patchWithMetaAndEtag<unknown>(
    '/action-items/' + encodeURIComponent(id),
    patch,
    { headers: { 'If-Match': etag } }
  )
  return parseActionResult(response)
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
  etag: string
): Promise<ActionMutationResult> {
  const response = await coreApi.postWithMetaAndEtag<unknown>(
    '/action-items/' + encodeURIComponent(id) + '/' + command,
    undefined,
    { headers: { 'If-Match': etag } }
  )
  return parseActionResult(response)
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

export function assigneeCandidatesQuery(search: string, page = 0) {
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
