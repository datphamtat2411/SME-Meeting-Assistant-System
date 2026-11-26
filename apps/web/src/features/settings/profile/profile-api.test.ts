import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coreApi } from '@/lib/core-api'
import { myProfileQuery, updateMyProfile } from './profile-api'

const profile = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'employee@example.com',
  displayName: 'Employee One',
  globalRole: 'EMPLOYEE',
  accountStatus: 'ACTIVE',
  primaryOrgUnitId: null,
}

describe('self profile contract', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps the opaque ETag with the representation', async () => {
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: profile,
      etag: '"user-version-1"',
      meta: {},
    })
    expect(await new QueryClient().fetchQuery(myProfileQuery())).toEqual({
      profile,
      etag: '"user-version-1"',
    })
  })

  it('rejects missing or weak version tokens', async () => {
    const get = vi.spyOn(coreApi, 'getWithMetaAndEtag')
    for (const etag of [undefined, 'W/"weak"', '*']) {
      get.mockResolvedValue({ data: profile, etag, meta: {} })
      await expect(
        new QueryClient().fetchQuery(myProfileQuery())
      ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    }
  })

  it('sends only displayName and the reviewed ETag', async () => {
    const patch = vi.spyOn(coreApi, 'patchWithMetaAndEtag').mockResolvedValue({
      data: { ...profile, displayName: 'New name' },
      etag: '"user-version-2"',
      meta: {},
    })
    await updateMyProfile(' New name ', {
      id: profile.id,
      etag: '"user-version-1"',
    })
    expect(patch).toHaveBeenCalledWith(
      '/me/profile',
      { displayName: 'New name' },
      { headers: { 'If-Match': '"user-version-1"' } }
    )
    await expect(
      updateMyProfile('Other', { id: profile.id, etag: '*' })
    ).rejects.toMatchObject({ status: 428 })
    expect(patch).toHaveBeenCalledTimes(1)
  })
})
