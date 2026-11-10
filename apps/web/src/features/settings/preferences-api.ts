import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { coreApi } from '@/lib/core-api'

export const preferencesSchema = z.object({
  timezone: z.string().nullable(),
  locale: z.string().nullable(),
  meetingEmailEnabled: z.boolean(),
  actionItemEmailEnabled: z.boolean(),
})
export type Preferences = z.infer<typeof preferencesSchema>
export const preferencesQuery = () =>
  queryOptions({
    queryKey: ['me', 'preferences'],
    queryFn: async ({ signal }) =>
      preferencesSchema.parse(
        await coreApi.get<unknown>('/me/preferences', { signal })
      ),
    retry: false,
  })
export const patchPreferences = async (patch: Partial<Preferences>) =>
  preferencesSchema.parse(
    await coreApi.patch<unknown>('/me/preferences', patch)
  )
