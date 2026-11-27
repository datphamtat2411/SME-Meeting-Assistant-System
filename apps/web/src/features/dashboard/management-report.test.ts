import { describe, expect, it } from 'vitest'
import { CoreApiError } from '@/lib/core-api'
import {
  managementDashboardQuery,
  parseManagementDashboard,
} from './dashboard-api'
import { customPeriod, rollingPeriod } from './management-period'

const unit = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const selection = rollingPeriod(30, Date.parse('2026-11-26T00:00:00Z'))
const fixture = () => ({
  asOf: selection.to,
  timezone: 'Asia/Ho_Chi_Minh',
  period: {
    fromInclusive: selection.from,
    toExclusive: selection.to,
    cohortTimeField: 'ACTION_ITEM_CREATED_AT',
    statusTimeSemantics: 'CURRENT_STATE',
  },
  scope: {
    type: 'MANAGED_OFFICIAL_ACTION_ITEMS',
    organizationalUnitIds: [unit],
  },
  actionItems: {
    open: 2,
    inProgress: 3,
    done: 4,
    cancelled: 1,
    overdue: 2,
    totalOfficial: 10,
  },
  unavailableMetrics: [],
})

describe('management reporting', () => {
  it('validates canonical cohort, scope and accounting', () => {
    expect(parseManagementDashboard(fixture(), selection, [unit])).toEqual(
      fixture()
    )
    expect(() =>
      parseManagementDashboard(fixture(), selection, [other])
    ).toThrow(CoreApiError)
    expect(() =>
      parseManagementDashboard(fixture(), selection, [unit, other])
    ).toThrow(CoreApiError)
    expect(() =>
      parseManagementDashboard(
        {
          ...fixture(),
          actionItems: { ...fixture().actionItems, overdue: 6 },
        },
        selection,
        [unit]
      )
    ).toThrow(CoreApiError)
    expect(() =>
      parseManagementDashboard(
        {
          ...fixture(),
          actionItems: { ...fixture().actionItems, totalOfficial: 9 },
        },
        selection,
        [unit]
      )
    ).toThrow(CoreApiError)
  })

  it('keeps reports isolated by session, period and selected unit', () => {
    const key = managementDashboardQuery('actor-a', [unit], selection).queryKey
    expect(key.slice(0, 2)).toEqual(['dashboard', 'management'])
    expect(
      managementDashboardQuery('actor-b', [unit], selection).queryKey
    ).not.toEqual(key)
    expect(
      managementDashboardQuery('actor-a', [unit], {
        ...selection,
        orgUnitId: unit,
      }).queryKey
    ).not.toEqual(key)
  })

  it('uses business calendar boundaries across DST changes', () => {
    expect(
      customPeriod('2026-03-08', '2026-03-08', 'America/New_York')
    ).toEqual({
      from: '2026-03-08T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
    })
    expect(
      customPeriod('2026-11-01', '2026-11-01', 'America/New_York')
    ).toEqual({
      from: '2026-11-01T04:00:00.000Z',
      to: '2026-11-02T05:00:00.000Z',
    })
    expect(
      customPeriod('2026-11-26', '2026-11-26', 'Asia/Ho_Chi_Minh')
    ).toEqual({
      from: '2026-11-25T17:00:00.000Z',
      to: '2026-11-26T17:00:00.000Z',
    })
  })

  it('rejects invalid, reversed and oversized periods', () => {
    expect(() => customPeriod('2026-02-30', '2026-03-01', 'UTC')).toThrow()
    expect(() => customPeriod('2026-03-02', '2026-03-01', 'UTC')).toThrow()
    expect(() => customPeriod('2025-01-01', '2026-01-03', 'UTC')).toThrow()
  })
})
