import { beforeEach, describe, expect, it, vi } from 'vitest'
import { coreApi } from '@/lib/core-api'
import {
  fetchAllAuthorizedOrganizationalUnits,
  resolveOrganizationUnitReference,
} from './organization-api'

const unit = (index: number) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  code: `UNIT-${index}`,
  name: `Unit ${index}`,
  parentId: null,
  status: 'ACTIVE' as const,
})

function page(pageNumber: number, totalElements: number, data: unknown[]) {
  const totalPages = Math.ceil(totalElements / 100)
  return {
    data,
    meta: {
      pagination: {
        page: pageNumber,
        size: 100,
        totalElements,
        totalPages,
        hasNext: pageNumber + 1 < totalPages,
        hasPrevious: pageNumber > 0,
      },
    },
  }
}

describe('authorized organizational-unit lookup', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('retrieves every page sequentially and passes the cancellation signal', async () => {
    const units = Array.from({ length: 101 }, (_, index) => unit(index + 1))
    const getSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValueOnce(page(0, 101, units.slice(0, 100)))
      .mockResolvedValueOnce(page(1, 101, units.slice(100)))
    const signal = new AbortController().signal

    await expect(
      fetchAllAuthorizedOrganizationalUnits(signal)
    ).resolves.toEqual(units)
    expect(getSpy).toHaveBeenNthCalledWith(1, '/organizational-units', {
      params: { page: 0, size: 100 },
      signal,
    })
    expect(getSpy).toHaveBeenNthCalledWith(2, '/organizational-units', {
      params: { page: 1, size: 100 },
      signal,
    })
  })

  it('fails safely on malformed metadata, duplicate IDs, and non-active units', async () => {
    const malformedPage = page(
      0,
      101,
      Array.from({ length: 100 }, (_, index) => unit(index + 1))
    )
    malformedPage.meta.pagination.totalPages = 3
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValueOnce(malformedPage)
    await expect(fetchAllAuthorizedOrganizationalUnits()).rejects.toThrow(
      /malformed/i
    )

    vi.restoreAllMocks()
    const duplicate = unit(1)
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValueOnce(
      page(0, 2, [duplicate, duplicate])
    )
    await expect(fetchAllAuthorizedOrganizationalUnits()).rejects.toThrow(
      /malformed/i
    )

    vi.restoreAllMocks()
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValueOnce(
      page(0, 1, [{ ...unit(1), status: 'INACTIVE' }])
    )
    await expect(fetchAllAuthorizedOrganizationalUnits()).rejects.toThrow(
      /malformed/i
    )
  })

  it('stops after cancellation instead of beginning the next page', async () => {
    const controller = new AbortController()
    const getSpy = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async () => {
        controller.abort()
        return page(
          0,
          101,
          Array.from({ length: 100 }, (_, index) => unit(index + 1))
        )
      })
    await expect(
      fetchAllAuthorizedOrganizationalUnits(controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(getSpy).toHaveBeenCalledTimes(1)
  })

  it('distinguishes unassigned, resolved, unresolved, loading, failed, and empty lookups', () => {
    const units = [unit(1)]
    expect(
      resolveOrganizationUnitReference(null, { status: 'loading' })
    ).toEqual({ state: 'unassigned' })
    expect(
      resolveOrganizationUnitReference(units[0]!.id, {
        status: 'success',
        units,
      })
    ).toMatchObject({ state: 'resolved', unit: units[0] })
    expect(
      resolveOrganizationUnitReference(unit(2).id, {
        status: 'success',
        units: [],
      })
    ).toMatchObject({
      state: 'unresolved',
      id: unit(2).id,
      collectionEmpty: true,
    })
    expect(
      resolveOrganizationUnitReference(unit(2).id, { status: 'loading' })
    ).toMatchObject({ state: 'loading', id: unit(2).id })
    expect(
      resolveOrganizationUnitReference(unit(2).id, { status: 'error' })
    ).toMatchObject({ state: 'error', id: unit(2).id })
  })
})
