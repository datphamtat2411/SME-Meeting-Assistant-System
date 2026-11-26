import { z } from 'zod'
import { queryOptions } from '@tanstack/react-query'
import { CoreApiError, coreApi } from '@/lib/core-api'

export const myProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1),
  globalRole: z.enum(['EMPLOYEE', 'DEPARTMENT_MANAGER', 'ADMINISTRATOR']),
  accountStatus: z.enum(['PENDING_SETUP', 'ACTIVE', 'INACTIVE']),
  primaryOrgUnitId: z.string().uuid().nullable(),
})

export const displayNameSchema = z.string().trim().min(1, 'Enter your name.').max(200)
export type MyProfile = z.infer<typeof myProfileSchema>
export type ProfileSnapshot = { profile: MyProfile; etag: string }
export const profileQueryKey = ['me', 'profile'] as const

function validEtag(value: unknown): value is string {
  return typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value)
}

function parseSnapshot(
  response: { data: unknown; etag?: string },
  expectedId?: string
): ProfileSnapshot {
  const result = myProfileSchema.safeParse(response.data)
  if (
    !result.success ||
    !validEtag(response.etag) ||
    (expectedId !== undefined && result.data.id !== expectedId)
  ) {
    throw new CoreApiError({
      message: 'The server returned an invalid profile or version.',
      code: 'MALFORMED_RESPONSE',
      kind: 'malformed',
    })
  }
  return { profile: result.data, etag: response.etag }
}

export const myProfileQuery = () =>
  queryOptions({
    queryKey: profileQueryKey,
    queryFn: async ({ signal }) =>
      parseSnapshot(
        await coreApi.getWithMetaAndEtag<unknown>('/me/profile', { signal })
      ),
    retry: false,
  })

export async function updateMyProfile(
  displayName: string,
  reviewed: { id: string; etag: string }
) {
  const name = displayNameSchema.parse(displayName)
  if (!validEtag(reviewed.etag)) {
    throw new CoreApiError({
      message: 'Reload the profile before editing.',
      code: 'INVALID_PRECONDITION',
      kind: 'http',
      status: 428,
    })
  }
  return parseSnapshot(
    await coreApi.patchWithMetaAndEtag<unknown>(
      '/me/profile',
      { displayName: name },
      { headers: { 'If-Match': reviewed.etag } }
    ),
    reviewed.id
  )
}
