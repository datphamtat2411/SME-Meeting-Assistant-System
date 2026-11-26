import { describe, expect, it } from 'vitest'
import { CoreApiError } from '@/lib/core-api'
import { parsePersonalDashboard, personalDashboardQuery } from './dashboard-api'
import { orderedUpcoming } from './dashboard-presentation'

const id = '11111111-1111-4111-8111-111111111111'
const asOf = '2026-11-26T08:00:00Z'
const later = '2026-11-27T08:00:00Z'
const fixture = () => ({
  asOf,
  timezone: 'Asia/Ho_Chi_Minh',
  upcomingWindow: { fromInclusive: asOf, toExclusive: later, limit: 10 },
  recentWindow: {
    fromInclusive: '2026-11-01T00:00:00Z',
    toExclusive: asOf,
    limit: 10,
  },
  meetingCountsByState: { SCHEDULED: 1 },
  upcomingMeetings: [{
    id,
    title: 'Planning',
    status: 'SCHEDULED',
    scheduledStartAt: asOf,
    scheduledEndAt: '2026-11-26T09:00:00Z',
    endedAt: null,
  }],
  recentMeetings: [],
  assignedActionItems: { open: 2, inProgress: 1, done: 4, overdue: 1 },
})

describe('personal dashboard projection', () => {
  it('preserves reporting windows and featured meeting identity', () => {
    const data = parsePersonalDashboard(fixture())
    expect(data.upcomingWindow.limit).toBe(10)
    expect(orderedUpcoming(data)[0].id).toBe(id)
  })

  it('rejects invalid counts, intervals, and meeting lifecycle values', () => {
    const data = fixture()
    expect(() => parsePersonalDashboard({
      ...data, meetingCountsByState: { SCHEDULED: -1 },
    })).toThrow(CoreApiError)
    expect(() => parsePersonalDashboard({
      ...data, upcomingWindow: { ...data.upcomingWindow, toExclusive: asOf },
    })).toThrow(CoreApiError)
    expect(() => parsePersonalDashboard({
      ...data, upcomingMeetings: [{ ...data.upcomingMeetings[0], status: 'CANCELLED' }],
    })).toThrow(CoreApiError)
    expect(() => parsePersonalDashboard({
      ...data, upcomingMeetings: [{ ...data.upcomingMeetings[0], scheduledStartAt: later }],
    })).toThrow(CoreApiError)
    expect(() => parsePersonalDashboard({
      ...data, assignedActionItems: { ...data.assignedActionItems, overdue: 4 },
    })).toThrow(CoreApiError)
  })

  it('scopes personal cache keys without losing the dashboard family', () => {
    expect(personalDashboardQuery('actor-a').queryKey).toEqual(['dashboard', 'me', 'actor-a'])
    expect(personalDashboardQuery('actor-b').queryKey).not.toEqual(personalDashboardQuery('actor-a').queryKey)
  })
})
