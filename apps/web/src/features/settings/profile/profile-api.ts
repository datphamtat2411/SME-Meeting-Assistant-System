import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { coreApi } from '@/lib/core-api'

export const myProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1),
  globalRole: z.enum(['EMPLOYEE', 'DEPARTMENT_MANAGER', 'ADMINISTRATOR']),
  accountStatus: z.enum(['PENDING_SETUP', 'ACTIVE', 'INACTIVE']),
  primaryOrgUnitId: z.string().uuid().nullable(),
})
export type MyProfile = z.infer<typeof myProfileSchema>
export const myProfileQuery = () =>
  queryOptions({
    queryKey: ['me', 'profile'],
    queryFn: async ({ signal }) =>
      myProfileSchema.parse(
        await coreApi.get<unknown>('/me/profile', { signal })
      ),
    retry: false,
  })
export const updateMyProfile = async (displayName: string) =>
  myProfileSchema.parse(
    await coreApi.patch<unknown>('/me/profile', { displayName })
  )
