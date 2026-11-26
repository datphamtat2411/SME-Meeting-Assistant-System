import { describe, expect, it } from 'vitest'
import { CoreApiError } from '@/lib/core-api'
import { canRetryObservation, observationRetryDelay } from './export-observation-policy'

describe('export observation policy', () => {
  const network = new CoreApiError({ message: 'Network unavailable', kind: 'network' })
  it('bounds retries and respects the remaining observation budget', () => {
    expect(canRetryObservation(0, network, 600_000)).toBe(true)
    expect(canRetryObservation(1, network, 600_000)).toBe(true)
    expect(canRetryObservation(2, network, 600_000)).toBe(false)
    expect(canRetryObservation(0, network, 2000)).toBe(false)
    expect(observationRetryDelay(0, network)).toBe(4000)
    expect(observationRetryDelay(1, network)).toBe(8000)
  })
  it('does not retry authorization, missing resource, or malformed responses', () => {
    for (const status of [401, 403, 404]) {
      expect(canRetryObservation(0, new CoreApiError({ message: 'Denied', kind: 'http', status }), 600_000)).toBe(false)
    }
    expect(canRetryObservation(0, new CoreApiError({ message: 'Malformed', kind: 'malformed' }), 600_000)).toBe(false)
  })
  it('honors rate-limit retry-after without exceeding the observation budget', () => {
    const limited = new CoreApiError({ message: 'Rate limited', kind: 'http', status: 429, retryAfter: '30' })
    expect(observationRetryDelay(0, limited)).toBe(30_000)
    expect(canRetryObservation(0, limited, 20_000)).toBe(false)
  })
})
