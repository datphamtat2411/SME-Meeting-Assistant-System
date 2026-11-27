import { describe, expect, it } from 'vitest'
import {
  isRoomSearchCanonical,
  normalizeRoomSearch,
  resolveRoomDirectoryCriteria,
  updateRoomSearch,
} from './room-directory-state'

describe('room directory URL state', () => {
  it('normalizes supported criteria and preserves the canonical default sort', () => {
    expect(
      normalizeRoomSearch({
        q: '  board  ',
        status: 'INACTIVE',
        sort: 'createdAt,desc',
        page: 2,
        size: 50,
      })
    ).toEqual({
      q: 'board',
      status: 'INACTIVE',
      sort: 'createdAt,desc',
      page: 2,
      size: 50,
    })
    expect(resolveRoomDirectoryCriteria({})).toEqual({
      page: 0,
      size: 20,
      sort: 'code,asc',
    })
  })

  it('drops unsupported search and sorting values and bounds pagination', () => {
    expect(
      normalizeRoomSearch({
        q: 'x'.repeat(201),
        status: 'MAINTENANCE',
        sort: 'location,sideways',
        page: -1,
        size: 101,
      })
    ).toEqual({})
    expect(
      normalizeRoomSearch({ sort: 'code,asc', page: 0, size: 20 })
    ).toEqual({})
    expect(normalizeRoomSearch({ q: 'room\u0000name' })).toEqual({})
  })

  it('resets pagination when directory criteria change', () => {
    const current = {
      q: 'Board',
      status: 'ACTIVE' as const,
      sort: 'code,asc' as const,
      page: 4,
      size: 50,
    }
    expect(updateRoomSearch(current, { sort: 'name,desc' })).toEqual({
      q: 'Board',
      status: 'ACTIVE',
      sort: 'name,desc',
      size: 50,
    })
    expect(updateRoomSearch(current, { page: 2 })).toEqual({
      ...current,
      page: 2,
    })
    expect(isRoomSearchCanonical(current)).toBe(true)
    expect(isRoomSearchCanonical({ sort: 'code,asc' })).toBe(false)
  })
})
