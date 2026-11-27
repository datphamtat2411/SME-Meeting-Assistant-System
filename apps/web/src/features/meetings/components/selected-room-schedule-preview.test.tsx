import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'
import type {
  ScheduleCheckInput,
  ScheduleCheckResult,
} from '../data/meeting-creation-api'
import { SelectedRoomSchedulePreview } from './selected-room-schedule-preview'

const initialInput: ScheduleCheckInput = {
  roomId: 'room-1',
  start: '2026-11-01T09:00:00.000Z',
  end: '2026-11-01T10:00:00.000Z',
  participantUserIds: ['user-2'],
}

const availablePreview = {
  previewOnly: true,
  canSchedule: true,
  roomConflict: false,
  room: {
    roomId: 'room-1',
    active: true,
    available: true,
    capacity: 2,
    participantCount: 3,
    capacityExceeded: true,
  },
  warnings: [
    { code: 'CAPACITY_ADVISORY_EXCEEDED', userId: null },
    { code: 'PARTICIPANT_OVERLAP', userId: 'user-2' },
  ],
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function PreviewHarness() {
  const [input, setInput] = useState(initialInput)
  return (
    <>
      <button
        type='button'
        onClick={() =>
          setInput({
            ...initialInput,
            start: '2026-11-01T11:00:00.000Z',
            end: '2026-11-01T12:00:00.000Z',
          })
        }
      >
        Change proposed interval
      </button>
      <SelectedRoomSchedulePreview input={input} roomName='Boardroom' />
    </>
  )
}

describe('SelectedRoomSchedulePreview', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows successful room feedback and non-blocking advisories without committing', async () => {
    const checkSpy = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValue(availablePreview)
    const mutationSpy = vi.spyOn(coreApi, 'postWithMetaAndEtag')
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <SelectedRoomSchedulePreview
          input={initialInput}
          roomName='Boardroom'
        />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText(/Boardroom appears available/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Room capacity advisory.'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Participant schedule overlap warning.'))
      .toBeInTheDocument()
    expect(checkSpy).toHaveBeenCalledWith(
      '/meeting-schedule-checks',
      {
        roomId: 'room-1',
        start: initialInput.start,
        end: initialInput.end,
        participantUserIds: ['user-2'],
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(mutationSpy).not.toHaveBeenCalled()
  })

  it('shows an error instead of success and provides a retry path', async () => {
    const checkSpy = vi.spyOn(coreApi, 'post')
    checkSpy
      .mockRejectedValueOnce(new Error('Preview unavailable'))
      .mockResolvedValueOnce(availablePreview)
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <SelectedRoomSchedulePreview input={initialInput} />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('Room schedule could not be checked'))
      .toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry room check' })
    )
    await expect
      .element(screen.getByText(/Selected room appears available/i))
      .toBeInTheDocument()
    expect(checkSpy).toHaveBeenCalledTimes(2)
  })

  it('suppresses a prior interval result after the proposed interval changes', async () => {
    let resolveFirst: ((value: ScheduleCheckResult) => void) | undefined
    const checkSpy = vi
      .spyOn(coreApi, 'post')
      .mockImplementation((_url, body) => {
        if ((body as { start?: string }).start === initialInput.start) {
          return new Promise<ScheduleCheckResult>((resolve) => {
            resolveFirst = resolve
          })
        }
        return Promise.resolve(availablePreview)
      })
    const screen = await render(
      <QueryClientProvider client={createQueryClient()}>
        <PreviewHarness />
      </QueryClientProvider>
    )

    await expect.poll(() => checkSpy).toHaveBeenCalledTimes(1)
    await userEvent.click(
      screen.getByRole('button', { name: 'Change proposed interval' })
    )
    await expect
      .element(screen.getByText(/Boardroom appears available/i))
      .toBeInTheDocument()
    resolveFirst?.({
      ...availablePreview,
      canSchedule: false,
      roomConflict: true,
      room: null,
      warnings: [],
    })
    await expect
      .element(screen.getByText(/Boardroom appears available/i))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText(/room conflicts with another meeting/i))
      .not.toBeInTheDocument()
    expect(checkSpy).toHaveBeenCalledTimes(2)
  })
})
