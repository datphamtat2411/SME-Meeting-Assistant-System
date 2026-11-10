import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { coreApi } from '@/lib/core-api'
import { pageInfo, paginationParams } from '@/lib/list-pagination'

export const actionSchema = z.object({
  id: z.string().uuid(), meetingId: z.string().uuid(), title: z.string(),
  details: z.string().nullable(), status: z.enum(['PROPOSED', 'OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']),
  assigneeUserId: z.string().uuid().nullable(), dueDate: z.string().nullable(), overdue: z.boolean(),
  sourceType: z.string(), processingJobId: z.string().uuid().nullable(),
  createdByUserId: z.string().uuid().nullable(), confirmedByUserId: z.string().uuid().nullable(),
  confirmedAt: z.string().nullable(), version: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
})
export type ActionItem = z.infer<typeof actionSchema>
export type ActionFilter = { page: number; q: string; status: string; assignee: 'me' | 'all'; overdue: boolean }
export function actionItemsQuery(filter: ActionFilter) {
  return queryOptions({
    queryKey: ['action-items', 'list', filter],
    queryFn: async ({ signal }) => {
      const response = await coreApi.getWithMeta<unknown>('/action-items', {
        params: { ...paginationParams(filter.page), q: filter.q || undefined,
          status: filter.status === 'all' ? undefined : filter.status,
          assignee: filter.assignee === 'me' ? 'me' : undefined,
          overdue: filter.overdue ? true : undefined, sort: 'createdAt,desc' }, signal,
      })
      return { items: z.array(actionSchema).parse(response.data), page: pageInfo(response.meta.pagination) }
    }, retry: false,
  })
}
export async function actionDetail(id: string) {
  const response = await coreApi.getWithMetaAndEtag<unknown>('/action-items/' + encodeURIComponent(id))
  return { item: actionSchema.parse(response.data), etag: response.etag }
}
export interface ActionDraft { meetingId: string; title: string; details: string | null; assigneeUserId: string; dueDate: string | null }
export function createAction(data: ActionDraft) {
  return coreApi.post<ActionItem>('/action-items', data, { headers: { 'Idempotency-Key': crypto.randomUUID() } })
}
export async function patchAction(id: string, patch: { title?: string; details?: string | null; assigneeUserId?: string; dueDate?: string | null }) {
  const { etag } = await actionDetail(id)
  return coreApi.patch<ActionItem>('/action-items/' + encodeURIComponent(id), patch, { headers: { 'If-Match': etag } })
}
export async function actionCommand(id: string, command: 'confirm' | 'reject' | 'start' | 'complete' | 'cancel' | 'reopen') {
  const { etag } = await actionDetail(id)
  return coreApi.post<ActionItem>('/action-items/' + encodeURIComponent(id) + '/' + command, undefined, { headers: { 'If-Match': etag } })
}
