import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'
import { invalidateMeetingArtifacts } from './query-invalidation'
import { useExportStatusObservation } from './use-export-status-observation'

vi.mock('./export-observation-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./export-observation-policy')>()),
  normalPollMs: 50,
  observationBudgetMs: 1500,
}))

const exportId = '11111111-1111-4111-8111-111111111111'
const meetingId = '22222222-2222-4222-8222-222222222222'
const pending = {
  exportId,
  meetingId,
  format: 'PDF',
  status: 'PENDING',
  attemptCount: 0,
  createdAt: '2026-11-24T10:00:00Z',
  readyAt: null,
  safeErrorCode: null,
  freshness: 'NOT_APPLICABLE',
  freshnessCheckedAt: null,
  retryEligible: false,
}

function Observer() {
  const { paused, status, refreshStatus } = useExportStatusObservation({
    exportId,
    meetingId,
    format: 'PDF',
    scope: 'test-session',
    canObserve: true,
  })
  return (
    <>
      <p>{paused ? 'Paused' : (status?.status ?? 'Waiting')}</p>
      <button onClick={refreshStatus}>Resume</button>
    </>
  )
}

function renderObserver(client = new QueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <Observer />
    </QueryClientProvider>
  )
}

afterEach(() => vi.restoreAllMocks())

it('pauses polling while hidden and resumes the same export when visible', async () => {
  const visibility = vi
    .spyOn(document, 'visibilityState', 'get')
    .mockReturnValue('visible')
  const get = vi.spyOn(coreApi, 'get').mockResolvedValue(pending)
  const screen = await renderObserver()
  await expect.element(screen.getByText('PENDING')).toBeVisible()
  visibility.mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  await new Promise((resolve) => setTimeout(resolve, 100))
  const hiddenCount = get.mock.calls.length
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(get.mock.calls).toHaveLength(hiddenCount)
  visibility.mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  await expect.poll(() => get.mock.calls.length).toBeGreaterThan(hiddenCount)
  expect(get.mock.calls.every(([url]) => url === '/exports/' + exportId)).toBe(
    true
  )
})

it('stops at the observation budget and explicitly resumes the same operation', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const get = vi.spyOn(coreApi, 'get').mockResolvedValue(pending)
  const screen = await renderObserver()
  await expect.element(screen.getByText('Paused')).toBeVisible()
  const pausedCount = get.mock.calls.length
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(get.mock.calls).toHaveLength(pausedCount)
  await userEvent.click(screen.getByRole('button', { name: 'Resume' }))
  await expect.element(screen.getByText('PENDING')).toBeVisible()
  await expect.poll(() => get.mock.calls.length).toBeGreaterThan(pausedCount)
  expect(get.mock.calls.every(([url]) => url === '/exports/' + exportId)).toBe(
    true
  )
})

it('rejects an in-flight pre-mutation status even before the first observation succeeds', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const client = new QueryClient()
  const ready = {
    ...pending,
    status: 'READY',
    attemptCount: 1,
    readyAt: '2026-11-24T10:01:00Z',
    freshness: 'STALE',
    freshnessCheckedAt: '2026-11-24T10:02:00Z',
  }
  let resolveOld!: (value: typeof ready) => void
  const old = new Promise<typeof ready>((resolve) => {
    resolveOld = resolve
  })
  const get = vi
    .spyOn(coreApi, 'get')
    .mockImplementationOnce(() => old)
    .mockResolvedValue(ready)
  const screen = await renderObserver(client)
  await expect.poll(() => get.mock.calls.length).toBe(1)
  invalidateMeetingArtifacts(client, meetingId, { intelligence: 'none' })
  await expect.element(screen.getByText('READY')).toBeVisible()
  const key = ['export', exportId, meetingId, 'PDF', 'test-session']
  expect(client.getQueryData(key)).toMatchObject({ freshness: 'STALE' })
  resolveOld({ ...ready, freshness: 'CURRENT' })
  await old
  expect(client.getQueryData(key)).toMatchObject({ freshness: 'STALE' })
  expect(get).toHaveBeenCalledTimes(2)
})
