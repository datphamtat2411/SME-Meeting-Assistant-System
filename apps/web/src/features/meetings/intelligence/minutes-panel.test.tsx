import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { RegionalPresentationProvider } from '@/context/regional-presentation'
import { preferencesQueryKey } from '@/features/settings/preferences-api'
import { MinutesPanel } from './minutes-panel'

const minutesData = vi.hoisted(() => ({
  value: {
    schemaVersion: 1,
    assembledAt: '2026-11-23T00:00:00Z',
    sourceFingerprint: 'a'.repeat(64),
    completeness: 'COMPLETE',
    proposalsIncluded: true,
    warnings: [],
    meeting: {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Meeting with proposal leakage',
      description: null,
      organizerUserId: '22222222-2222-4222-8222-222222222222',
      status: 'ENDED',
      scheduledStartAt: null,
      scheduledEndAt: null,
      startedAt: null,
      endedAt: '2026-11-23T00:00:00Z',
    },
    summary: {
      availability: 'AVAILABLE',
      id: '33333333-3333-4333-8333-333333333333',
      versionNumber: 1,
      content: 'AI-derived summary',
      sourceType: 'AI_GENERATED',
      qualityStatus: 'READY',
      transcriptId: '44444444-4444-4444-8444-444444444444',
      contentRevision: 1,
      selectionEpoch: 1,
      isStale: false,
      aiWarnings: [],
    },
    confirmedDecisions: [],
    officialActionItems: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        title: 'Dated action',
        status: 'OPEN',
        sourceType: 'MANUAL',
        assigneeUserId: null,
        dueDate: '2026-11-23',
        version: 1,
      },
      {
        id: '66666666-6666-4666-8666-666666666666',
        title: 'Undated action',
        status: 'OPEN',
        sourceType: 'MANUAL',
        assigneeUserId: null,
        dueDate: null,
        version: 1,
      },
    ],
    transcript: {
      availability: 'AVAILABLE',
      id: '44444444-4444-4444-8444-444444444444',
      versionNumber: 1,
      status: 'READY',
      unresolvedSegments: 0,
      unresolvedCoverageRegions: 0,
    },
  },
}))

vi.mock('./minutes-api', () => ({
  minutesQuery: () => ({
    queryKey: ['minutes', 'proposal-leakage'],
    queryFn: async () => minutesData.value,
    retry: false,
  }),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}))

describe('MinutesPanel proposal boundary', () => {
  it('does not present a snapshot containing proposals as official minutes', async () => {
    const screen = await render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <MinutesPanel meetingId='11111111-1111-4111-8111-111111111111' />
      </QueryClientProvider>
    )

    await expect
      .element(
        screen.getByText(
          'This snapshot contains unconfirmed AI proposals and is not official minutes.'
        )
      )
      .toBeInTheDocument()
  })
})

describe('MinutesPanel regional due dates', () => {
  it('formats civil deadlines by locale without shifting the day by timezone', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const preferences = {
      timezone: 'Pacific/Honolulu',
      locale: 'en-GB',
      meetingEmailEnabled: true,
      actionItemEmailEnabled: true,
    }
    queryClient.setQueryDefaults(preferencesQueryKey, { staleTime: Infinity })
    queryClient.setQueryData(preferencesQueryKey, preferences)

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <RegionalPresentationProvider>
          <MinutesPanel meetingId='11111111-1111-4111-8111-111111111111' />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText(/due 23 Nov 2026 · version 1/))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText(/due none · version 1/))
      .toBeInTheDocument()

    await act(async () => {
      queryClient.setQueryData(preferencesQueryKey, {
        ...preferences,
        timezone: 'Asia/Tokyo',
      })
    })
    await expect
      .element(screen.getByText(/due 23 Nov 2026 · version 1/))
      .toBeInTheDocument()

    await act(async () => {
      queryClient.setQueryData(preferencesQueryKey, {
        ...preferences,
        timezone: 'Asia/Tokyo',
        locale: 'en-US',
      })
    })
    await expect
      .element(screen.getByText(/due Nov 23, 2026 · version 1/))
      .toBeInTheDocument()
    expect(minutesData.value.officialActionItems[0].dueDate).toBe('2026-11-23')
  })
})
