import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { coreApi } from '@/lib/core-api'
import { pageInfo, paginationParams } from '@/lib/list-pagination'

export const memberSchema = z.object({
  id: z.string().uuid(), email: z.string(), displayName: z.string(),
  globalRole: z.enum(['EMPLOYEE', 'DEPARTMENT_MANAGER', 'ADMINISTRATOR']),
  accountStatus: z.enum(['PENDING_SETUP', 'ACTIVE', 'INACTIVE']),
  primaryOrgUnitId: z.string().uuid().nullable(), managerScopeUnitIds: z.array(z.string().uuid()).or(z.set(z.string().uuid())).optional(),
  createdAt: z.string(), updatedAt: z.string(),
})
export type Member = z.infer<typeof memberSchema>
export interface MemberCreate {
  email: string; displayName: string; globalRole: Member['globalRole'];
  primaryOrgUnitId: string | null; managerScopeUnitIds?: string[]
}
export interface MemberUpdate {
  displayName?: string; globalRole?: Member['globalRole'];
  primaryOrgUnitId?: string | null; managerScopeUnitIds?: string[]
}
export function membersQuery(page: number, q: string) {
  return queryOptions({
    queryKey: ['users', 'directory', page, q],
    queryFn: async ({ signal }) => {
      const result = await coreApi.getWithMeta<unknown>('/users', { params: { ...paginationParams(page), q }, signal })
      return { items: z.array(memberSchema).parse(result.data), page: pageInfo(result.meta.pagination) }
    }, retry: false,
  })
}
export async function memberDetail(id: string) {
  const result = await coreApi.getWithMetaAndEtag<unknown>('/users/' + encodeURIComponent(id))
  return { member: memberSchema.parse(result.data), etag: result.etag }
}
export const createMember = (data: MemberCreate) => coreApi.post<Member>('/users', data)
export const updateMember = (id: string, data: MemberUpdate, etag?: string) =>
  coreApi.patch<Member>('/users/' + encodeURIComponent(id), data, { headers: etag ? { 'If-Match': etag } : {} })
export const changeMemberStatus = (id: string, action: 'deactivate' | 'reactivate' | 'account-setup/reissue', etag?: string) =>
  coreApi.post<Member>('/users/' + encodeURIComponent(id) + '/' + action, undefined, { headers: etag ? { 'If-Match': etag } : {} })
