import { z } from 'zod'
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { CoreApiError, coreApi, normalizeCoreApiError } from '@/lib/core-api'
import {
  isSettingsSessionCurrent,
  requireSettingsSession,
  settingsSessionGeneration,
} from './settings-session'
import { isLocaleTag, isTimezoneSelection } from './regional-preferences'

export const preferencesSchema = z.object({
  timezone: z.string().min(1).max(64).nullable(),
  locale: z.string().min(1).max(32).nullable(),
  meetingEmailEnabled: z.boolean(),
  actionItemEmailEnabled: z.boolean(),
})
export type Preferences = z.infer<typeof preferencesSchema>

export const preferencesPatchSchema = z
  .object({
    timezone: z.string().refine(isTimezoneSelection).nullable().optional(),
    locale: z.string().refine(isLocaleTag).nullable().optional(),
    meetingEmailEnabled: z.boolean().optional(),
    actionItemEmailEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'At least one changed preference is required.',
  })
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>

export const preferencesQueryKey = ['me', 'preferences'] as const

function parsePreferences(value: unknown): Preferences {
  const result = preferencesSchema.safeParse(value)
  if (!result.success) {
    throw new CoreApiError({
      message: 'The server returned invalid preferences.',
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
      cause: result.error,
    })
  }
  return result.data
}

export const preferencesQuery = () =>
  queryOptions({
    queryKey: preferencesQueryKey,
    queryFn: async ({ signal }) =>
      parsePreferences(await coreApi.get<unknown>('/me/preferences', { signal })),
    retry: false,
  })

export async function patchPreferences(patch: PreferencesPatch) {
  const parsed = preferencesPatchSchema.parse(patch)
  return parsePreferences(
    await coreApi.patch<unknown>('/me/preferences', parsed)
  )
}

export function usePreferencesMutation() {
  const qc = useQueryClient()
  return useMutation({
    scope: { id: 'user-preferences' },
    retry: false,
    mutationFn: async ({
      patch,
      generation,
    }: {
      patch: PreferencesPatch
      generation: string
    }) => {
      requireSettingsSession(generation)
      await qc.cancelQueries({ queryKey: preferencesQueryKey })
      requireSettingsSession(generation)
      return patchPreferences(patch)
    },
    onSuccess: async (data, { generation }) => {
      if (!isSettingsSessionCurrent(generation)) return
      await qc.cancelQueries({ queryKey: preferencesQueryKey })
      if (!isSettingsSessionCurrent(generation)) return
      qc.setQueryData(preferencesQueryKey, data)
      await qc.invalidateQueries({ queryKey: preferencesQueryKey })
    },
    onError: async (error, { generation }) => {
      if (!isSettingsSessionCurrent(generation)) return
      const failure = normalizeCoreApiError(error)
      if (
        failure.kind === 'network' ||
        failure.kind === 'malformed' ||
        failure.isServerError
      ) {
        await qc.invalidateQueries({ queryKey: preferencesQueryKey })
      }
    },
  })
}

export function preferencesMutationInput(patch: PreferencesPatch) {
  return { patch, generation: settingsSessionGeneration() }
}
