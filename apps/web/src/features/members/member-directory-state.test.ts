import { describe, expect, it } from 'vitest'
import {
  isMemberSearchCanonical,
  normalizeMemberSearch,
  resolveMemberDirectoryCriteria,
  updateMemberSearch,
} from './member-directory-state'

const unitId = '11111111-1111-4111-8111-111111111111'

describe('member directory URL state', () => {
  it('normalizes supported filters and zero-based pagination', () => {
    expect(
      normalizeMemberSearch({
        q: '  Linh  ',
        role: 'DEPARTMENT_MANAGER',
        status: 'PENDING_SETUP',
        orgUnitId: unitId,
        page: 3,
        size: 50,
      })
    ).toEqual({
      q: 'Linh',
      role: 'DEPARTMENT_MANAGER',
      status: 'PENDING_SETUP',
      orgUnitId: unitId,
      page: 3,
      size: 50,
    })
    expect(resolveMemberDirectoryCriteria({ page: 3, size: 50 })).toEqual({
      page: 3,
      size: 50,
    })
  })

  it('drops unsupported, malformed, oversized, and default criteria', () => {
    expect(
      normalizeMemberSearch({
        q: ` ${'x'.repeat(201)} `,
        role: 'OWNER',
        status: 'INVITED',
        orgUnitId: 'not-a-uuid',
        page: -1,
        size: 101,
        sort: 'email,asc',
      })
    ).toEqual({})
    expect(normalizeMemberSearch({ page: 0, size: 20, q: '  ' })).toEqual({})
    expect(
      normalizeMemberSearch({
        page: 2_147_483_648,
        size: 0,
        q: 'ok\u0000bad',
      })
    ).toEqual({})
  })

  it('resets pagination on criteria changes and supports clean history state', () => {
    const current = { q: 'Mina', page: 4, size: 50, status: 'ACTIVE' as const }
    expect(updateMemberSearch(current, { q: 'Mina Park' })).toEqual({
      q: 'Mina Park',
      size: 50,
      status: 'ACTIVE',
    })
    expect(updateMemberSearch(current, { page: 2 })).toEqual({
      q: 'Mina',
      page: 2,
      size: 50,
      status: 'ACTIVE',
    })
    expect(isMemberSearchCanonical(current)).toBe(true)
    expect(isMemberSearchCanonical({ page: 0, size: 20 })).toBe(false)
  })
})
