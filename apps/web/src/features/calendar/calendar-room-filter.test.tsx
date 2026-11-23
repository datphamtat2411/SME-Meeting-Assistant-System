import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'
import type { RoomFilterOption } from '@/features/meetings/data/list-api'
import { CalendarRoomFilter } from './calendar-room-filter'

const selectedRoomId = '11111111-1111-4111-8111-111111111111'
const distantRoomId = '22222222-2222-4222-8222-222222222222'

const firstRoom: RoomFilterOption = {
  id: selectedRoomId,
  name: 'Alpha room',
  location: 'Floor 1',
}
const distantRoom: RoomFilterOption = {
  id: distantRoomId,
  name: 'Zeta room',
  location: 'Floor 9',
}

async function renderFilter({
  roomId,
  onRoomChange = vi.fn(),
}: {
  roomId?: string
  onRoomChange?: (roomId?: string) => void
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <CalendarRoomFilter roomId={roomId} onRoomChange={onRoomChange} />
    </QueryClientProvider>
  )
  return { screen, queryClient, onRoomChange }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Calendar room filter discovery', () => {
  it('searches and pages authorized results without committing until selection', async () => {
    const calls: Array<Record<string, string>> = []
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(
      async (_url, config) => {
        const params = config?.params as Record<string, string>
        calls.push(params)
        if (params.q === 'zeta') {
          return {
            data: [distantRoom],
            meta: {
              pagination: {
                page: 0,
                size: 20,
                totalElements: 1,
                totalPages: 1,
                hasNext: false,
                hasPrevious: false,
              },
            },
          }
        }
        const page = Number(params.page)
        const result = page === 0 ? [firstRoom] : [distantRoom]
        return {
          data: result,
          meta: {
            pagination: {
              page,
              size: 20,
              totalElements: 21,
              totalPages: 2,
              hasNext: page === 0,
              hasPrevious: page > 0,
            },
          },
        }
      }
    )
    const onRoomChange = vi.fn()
    const { screen } = await renderFilter({ onRoomChange })

    await userEvent.click(screen.getByRole('combobox', { name: 'Room' }))
    await expect
      .element(screen.getByRole('option', { name: /Alpha room/ }))
      .toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Next room options page' })
    )
    await expect
      .element(screen.getByRole('option', { name: /Zeta room/ }))
      .toBeInTheDocument()
    expect(onRoomChange).not.toHaveBeenCalled()
    expect(calls.map((params) => params.page)).toEqual(['0', '1'])

    await userEvent.click(screen.getByRole('option', { name: /Zeta room/ }))
    expect(onRoomChange).toHaveBeenCalledWith(distantRoomId)
  })

  it('keeps a directly selected room resolved while the search changes', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url, config) => {
      if (url === `/rooms/${selectedRoomId}`) {
        return { data: firstRoom, meta: {} }
      }
      const params = config?.params as Record<string, string>
      return {
        data: params.q === 'zeta' ? [distantRoom] : [],
        meta: {
          pagination: {
            page: 0,
            size: 20,
            totalElements: params.q === 'zeta' ? 1 : 0,
            totalPages: params.q === 'zeta' ? 1 : 0,
            hasNext: false,
            hasPrevious: false,
          },
        },
      }
    })
    const { screen, onRoomChange } = await renderFilter({
      roomId: selectedRoomId,
    })

    await expect
      .element(screen.getByRole('combobox', { name: 'Room' }))
      .toHaveTextContent('Alpha room')
    await userEvent.click(screen.getByRole('combobox', { name: 'Room' }))
    await userEvent.fill(
      screen.getByPlaceholder('Search authorized rooms...'),
      'zeta'
    )
    await expect
      .element(screen.getByRole('option', { name: /Zeta room/ }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('combobox', { name: 'Room' }))
      .toHaveTextContent('Alpha room')

    await userEvent.click(
      screen.getByRole('button', { name: 'Clear room filter' })
    )
    expect(onRoomChange).toHaveBeenCalledWith(undefined)
  })

  it('shows and retries a failed direct room lookup without clearing the filter', async () => {
    let attempts = 0
    const request = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockImplementation(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary room lookup failure')
        return { data: firstRoom, meta: {} }
      })
    const onRoomChange = vi.fn()
    const { screen } = await renderFilter({
      roomId: selectedRoomId,
      onRoomChange,
    })

    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent(/meeting results remain filtered by this room ID/i)
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry room lookup' })
    )
    await expect
      .element(screen.getByRole('combobox', { name: 'Room' }))
      .toHaveTextContent('Alpha room')
    expect(request).toHaveBeenCalledTimes(2)
    expect(onRoomChange).not.toHaveBeenCalled()
  })
})
