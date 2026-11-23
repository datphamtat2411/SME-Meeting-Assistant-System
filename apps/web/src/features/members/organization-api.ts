import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { coreApi } from '@/lib/core-api'
import { pageInfo } from '@/lib/list-pagination'

export const organizationalUnitSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  parentId: z.string().uuid().nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
})
export type OrganizationalUnit = z.infer<typeof organizationalUnitSchema>
export function organizationalUnitsQuery() {
  return queryOptions({
    queryKey: ['organization', 'units'],
    queryFn: async ({ signal }) => {
      const response = await coreApi.getWithMeta<unknown>(
        '/organizational-units',
        { params: { page: 0, size: 100 }, signal }
      )
      pageInfo(response.meta.pagination)
      return z.array(organizationalUnitSchema).parse(response.data)
    },
    retry: false,
  })
}
