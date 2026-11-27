import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import type { MeetingListItem } from '@/features/meetings/data/list-api'
import { useCalendarMeetingData } from './calendar-controller'

const meeting = (index: number): MeetingListItem => {
  const minute = String(index % 60).padStart(2, '0')
  return {
    id: `meeting-${String(index).padStart(3, '0')}`,
    title: `Meeting ${index}`,
    description: null,
    organizerUserId: 'organizer-1',
    roomId: null,
    scheduledStartAt: `2026-11-05T10:${minute}:00.000Z`,
    scheduledEndAt: `2026-11-05T11:${minute}:00.000Z`,
    status: 'SCHEDULED',
    startedAt: null,
    endedAt: null,
    cancelledAt: null,
    createdAt: null,
    updatedAt: null,
    display: {
      organizerName: 'Organizer',
      roomName: null,
      roomLocation: null,
      participantCount: 2,
      participantPreview: [],
    },
  }
}

function apiPage(
  page: number,
  records: readonly MeetingListItem[],
  total: number
) {
  return {
    data: records,
    meta: {
      pagination: {
        page,
        size: 100,
        totalElements: total,
        totalPages: Math.ceil(total / 100),
        hasNext: (page + 1) * 100 < total,
        hasPrevious: page > 0,
      },
    },
  }
}

function CalendarDataProbe({ q }: { q?: string }) {
  const data = useCalendarMeetingData({
    month: '2026-11',
    filters: { relationship: 'all', ...(q ? { q } : {}) },
  })

  return (
    <div>
      <p>{`${data.loadedCount}/${data.totalCount ?? 'unknown'}`}</p>
      <p>{data.completeness}</p>
      {data.isInconsistent && (
        <button onClick={() => void data.retry()}>
          Reload Calendar meetings
        </button>
      )}
      {data.isInitialLoading && <p>initial loading</p>}
      {data.isRefreshing && <p>refreshing</p>}
      {data.pageError && <p>page failed</p>}
      {data.error && <p>initial failed</p>}
      {data.isUnauthorized && (
        <p>{`unauthorized ${data.authorizationStatus}`}</p>
      )}
      {data.hasMore && (
        <button onClick={() => void data.loadMore()}>Load more meetings</button>
      )}
      {(data.pageError || data.error) && (
        <button onClick={() => void data.retry()}>
          Retry calendar request
        </button>
      )}
    </div>
  )
}

function CalendarFilterSwitchProbe() {
  const [q, setQ] = useState('first-filter')
  const data = useCalendarMeetingData({
    month: '2026-11',
    filters: { relationship: 'all', q },
  })
  return (
    <div>
      {data.meetings.map((item) => (
        <p key={item.id}>{item.title}</p>
      ))}
      <button onClick={() => setQ('second-filter')}>
        Change keyword filter
      </button>
    </div>
  )
}

async function renderProbe(q?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <CalendarDataProbe q={q} />
    </QueryClientProvider>
  )
  return { ...view, queryClient }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Calendar data controller', () => {
  it.each([
    { count: 100, expectedPages: 1 },
    { count: 101, expectedPages: 2 },
  ])(
    'completes an exact $count-meeting result with the expected pages',
    async ({ count, expectedPages }) => {
      const records = Array.from({ length: count }, (_, index) =>
        meeting(index)
      )
      const request = vi
        .spyOn(coreApi, 'getWithMeta')
        .mockImplementation(async (_url, config) => {
          const page = Number((config?.params as Record<string, string>).page)
          return apiPage(
            page,
            records.slice(page * 100, (page + 1) * 100),
            records.length
          )
        })
      const screen = await renderProbe()

      await expect
        .element(screen.getByText(`${count}/${count}`))
        .toBeInTheDocument()
      await expect.element(screen.getByText('complete')).toBeInTheDocument()
      expect(request).toHaveBeenCalledTimes(expectedPages)
      expect(
        request.mock.calls.map(([, config]) => {
          const params = config?.params as Record<string, string>
          return params.page
        })
      ).toEqual(
        Array.from({ length: expectedPages }, (_, index) => String(index))
      )
    }
  )

  it('automatically accumulates all pages for a 201-meeting month', async () => {
    const records = Array.from({ length: 201 }, (_, index) => meeting(index))
    const request = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (_url, config) => {
        const page = Number((config?.params as Record<string, string>).page)
        return apiPage(
          page,
          records.slice(page * 100, (page + 1) * 100),
          records.length
        )
      })
    const screen = await renderProbe()

    await expect.element(screen.getByText('201/201')).toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('stops automatic accumulation after five pages and offers explicit continuation', async () => {
    const records = Array.from({ length: 501 }, (_, index) => meeting(index))
    const request = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (_url, config) => {
        const page = Number((config?.params as Record<string, string>).page)
        return apiPage(
          page,
          records.slice(page * 100, (page + 1) * 100),
          records.length
        )
      })
    const screen = await renderProbe()

    await expect.element(screen.getByText('500/501')).toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(5)
    await userEvent.click(
      screen.getByRole('button', { name: 'Load more meetings' })
    )
    await expect.element(screen.getByText('501/501')).toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(6)
  })

  it('retains loaded meetings after a continuation failure and retries that page', async () => {
    const records = Array.from({ length: 150 }, (_, index) => meeting(index))
    let secondPageAttempts = 0
    const request = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (_url, config) => {
        const page = Number((config?.params as Record<string, string>).page)
        if (page === 1 && secondPageAttempts++ === 0) {
          throw new Error('temporary page failure')
        }
        return apiPage(
          page,
          records.slice(page * 100, (page + 1) * 100),
          records.length
        )
      })
    const screen = await renderProbe()

    await expect.element(screen.getByText('100/150')).toBeInTheDocument()
    await expect.element(screen.getByText('page failed')).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry calendar request' })
    )
    await expect.element(screen.getByText('150/150')).toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('reports exhausted pagination count mismatches and retries with a fresh query', async () => {
    let attempts = 0
    const request = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async () => {
        attempts += 1
        return attempts === 1
          ? apiPage(0, [meeting(0)], 2)
          : apiPage(0, [meeting(0)], 1)
      })
    const screen = await renderProbe()

    await expect.element(screen.getByText('1/2')).toBeInTheDocument()
    await expect.element(screen.getByText('inconsistent')).toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(1)
    await userEvent.click(
      screen.getByRole('button', { name: 'Reload Calendar meetings' })
    )
    await expect.element(screen.getByText('1/1')).toBeInTheDocument()
    await expect.element(screen.getByText('complete')).toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('distinguishes forbidden access from an empty authorized result', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockRejectedValue(
      new CoreApiError({
        message: 'Forbidden',
        status: 403,
        kind: 'http',
      })
    )
    const screen = await renderProbe()

    await expect
      .element(screen.getByText('unauthorized 403'))
      .toBeInTheDocument()
    await expect.element(screen.getByText('initial failed')).toBeInTheDocument()
    await expect.element(screen.getByText('0/unknown')).toBeInTheDocument()
  })

  it('reports an expired session as unauthorized for Calendar data', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockRejectedValue(
      new CoreApiError({
        message: 'Authentication required',
        status: 401,
        code: 'AUTH_REQUIRED',
        kind: 'http',
      })
    )
    const screen = await renderProbe()

    await expect
      .element(screen.getByText('unauthorized 401'))
      .toBeInTheDocument()
    await expect.element(screen.getByText('initial failed')).toBeInTheDocument()
    await expect.element(screen.getByText('0/unknown')).toBeInTheDocument()
  })

  it('starts a clean result set when a server filter changes', async () => {
    const request = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async (_url, config) => {
        const q = (config?.params as Record<string, string>).q
        return apiPage(
          0,
          [meeting(0)].map((item) => ({
            ...item,
            id: q,
            title: `${q} result`,
          })),
          1
        )
      })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <CalendarFilterSwitchProbe />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('first-filter result'))
      .toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Change keyword filter' })
    )
    await expect
      .element(screen.getByText('second-filter result'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('first-filter result'))
      .not.toBeInTheDocument()
    expect(
      request.mock.calls.map(
        ([, config]) => (config?.params as Record<string, string>).q
      )
    ).toEqual(['first-filter', 'second-filter'])
  })
})
