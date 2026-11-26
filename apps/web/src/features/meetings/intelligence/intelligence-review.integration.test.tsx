import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { RegionalPresentationProvider } from '@/context/regional-presentation'
import { preferencesQueryKey } from '@/features/settings/preferences-api'
import { DecisionsPanel } from './decisions-panel'
import { summaryQuery } from './summary-api'
import { SummaryPanel } from './summary-panel'

const meetingId = '11111111-1111-4111-8111-111111111111'
const currentId = '22222222-2222-4222-8222-222222222222'
const candidateId = '33333333-3333-4333-8333-333333333333'
const transcriptId = '44444444-4444-4444-8444-444444444444'
const segmentId = '55555555-5555-4555-8555-555555555555'

const summary = {
  id: currentId,
  meetingId,
  versionNumber: 4,
  content: 'Current reviewed summary',
  sourceType: 'HUMAN_EDIT',
  qualityStatus: 'READY',
  processingJobId: null,
  transcriptId,
  contentRevision: 4,
  isStale: false,
  createdAt: '2026-11-25T09:00:00Z',
  createdByUserId: null,
}

const proposal = {
  id: candidateId,
  meetingId,
  content: 'Reviewed proposal text',
  status: 'PROPOSED',
  sourceType: 'AI_EXTRACTED',
  evidenceSegmentIds: [segmentId],
  transcriptId,
  contentRevision: 4,
  isStale: false,
  version: 0,
  createdAt: '2026-11-25T09:00:00Z',
  createdByUserId: null,
  confirmedAt: null,
  confirmedByUserId: null,
  rejectedAt: null,
  rejectedByUserId: null,
  etag: '"reviewed-decision"',
}

function page(items: unknown[]) {
  return {
    data: items,
    meta: {
      pagination: {
        page: 0,
        size: 20,
        totalElements: items.length,
        totalPages: items.length ? 1 : 0,
        hasNext: false,
        hasPrevious: false,
      },
    },
  }
}

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('intelligence review integrity', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('binds activation to the current summary actually shown during review', async () => {
    const queryClient = client()
    const latest = {
      ...summary,
      versionNumber: 5,
      content: 'Newer server summary',
    }
    const get = vi.spyOn(coreApi, 'getWithMetaAndEtag').mockResolvedValue({
      data: summary,
      meta: {},
      etag: '"reviewed-summary"',
    })
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue(
      page([
        { ...summary, isCurrent: true },
        {
          ...summary,
          id: candidateId,
          versionNumber: 3,
          content: 'Historical candidate',
          isCurrent: false,
        },
      ])
    )
    const post = vi.spyOn(coreApi, 'postWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({
        message: 'Version changed',
        status: 412,
        kind: 'http',
      })
    )
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <SummaryPanel meetingId={meetingId} canEdit canRegenerate={false} />
      </QueryClientProvider>
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Review activation' })
    )
    get.mockResolvedValue({ data: latest, meta: {}, etag: '"latest-summary"' })
    queryClient.setQueryData(summaryQuery(meetingId).queryKey, {
      summary: latest,
      etag: '"latest-summary"',
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Activate reviewed version' })
    )
    await expect.poll(() => post.mock.calls.length).toBe(1)
    expect(post).toHaveBeenCalledWith(
      `/meetings/${meetingId}/summary/versions/${candidateId}/activate`,
      undefined,
      { headers: { 'If-Match': '"reviewed-summary"' } }
    )
    await expect
      .element(
        screen.getByRole('button', { name: 'Activate reviewed version' })
      )
      .toBeDisabled()
  })

  it('formats decision creation timestamps with the current regional preferences', async () => {
    const queryClient = client()
    const preferences = {
      timezone: 'Asia/Tokyo',
      locale: 'ja-JP',
      meetingEmailEnabled: true,
      actionItemEmailEnabled: true,
    }
    vi.spyOn(coreApi, 'get').mockResolvedValue(preferences)
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue(page([proposal]))
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({
        message: 'Transcript not available',
        status: 404,
        kind: 'http',
      })
    )
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <RegionalPresentationProvider>
          <DecisionsPanel meetingId={meetingId} canManageDecisions />
        </RegionalPresentationProvider>
      </QueryClientProvider>
    )
    const expected = (timezone: string, locale: string) =>
      'Created ' +
      new Intl.DateTimeFormat(locale, {
        calendar: 'gregory',
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: timezone,
      }).format(new Date(proposal.createdAt))

    await expect
      .element(
        screen.getByText(expected('Asia/Tokyo', 'ja-JP'), { exact: true })
      )
      .toBeInTheDocument()
    await act(async () => {
      queryClient.setQueryData(preferencesQueryKey, {
        ...preferences,
        timezone: 'America/New_York',
        locale: 'en-GB',
      })
    })
    await expect
      .element(
        screen.getByText(expected('America/New_York', 'en-GB'), { exact: true })
      )
      .toBeInTheDocument()
  })

  it('blocks an obsolete proposal review even when the record leaves the filtered collection', async () => {
    const queryClient = client()
    const collection = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValue(page([proposal]))
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({
        message: 'Transcript not available',
        status: 404,
        kind: 'http',
      })
    )
    const post = vi.spyOn(coreApi, 'post').mockRejectedValue(
      new CoreApiError({
        message: 'Decision changed',
        status: 412,
        kind: 'http',
      })
    )
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <DecisionsPanel meetingId={meetingId} canManageDecisions />
      </QueryClientProvider>
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Review proposal' })
    )
    collection.mockResolvedValue(page([]))
    await userEvent.click(
      screen.getByRole('button', { name: 'Reject proposal' })
    )
    await expect
      .element(
        screen.getByText(
          'This review is no longer actionable. No action was replayed.'
        )
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: 'Reject proposal' }))
      .toBeDisabled()
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(
      `/meetings/${meetingId}/decisions/${candidateId}/reject`,
      undefined,
      { headers: { 'If-Match': '"reviewed-decision"' } }
    )
  })

  it('blocks repeated manual creation after a transport failure until explicit reconciliation', async () => {
    const queryClient = client()
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue(page([]))
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({
        message: 'Transcript not available',
        status: 404,
        kind: 'http',
      })
    )
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValue(
        new CoreApiError({ message: 'Connection lost', kind: 'network' })
      )
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <DecisionsPanel meetingId={meetingId} canManageDecisions />
      </QueryClientProvider>
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Add confirmed decision' })
    )
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'New decision content' }),
      'New official decision'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create confirmed decision' })
    )
    await expect
      .element(
        screen.getByRole('button', { name: 'Create confirmed decision' })
      )
      .toBeDisabled()
    await expect
      .element(
        screen.getByRole('button', {
          name: 'I checked the records — allow a new attempt',
        })
      )
      .toBeInTheDocument()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('ignores a delayed proposal reconciliation after closing and reopening the same review', async () => {
    const queryClient = client()
    const latestCollection = deferred<ReturnType<typeof page>>()
    const collection = vi
      .spyOn(coreApi, 'getWithMeta')
      .mockResolvedValueOnce(page([proposal]))
      .mockImplementation(async () => latestCollection.promise)
    vi.spyOn(coreApi, 'getWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({
        message: 'Transcript not available',
        status: 404,
        kind: 'http',
      })
    )
    vi.spyOn(coreApi, 'post').mockRejectedValue(
      new CoreApiError({
        message: 'Decision changed',
        status: 412,
        kind: 'http',
      })
    )
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <DecisionsPanel meetingId={meetingId} canManageDecisions />
      </QueryClientProvider>
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Review proposal' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Reject proposal' })
    )
    await expect.poll(() => collection.mock.calls.length).toBeGreaterThan(1)
    await userEvent.click(screen.getByRole('button', { name: 'Close review' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Review proposal' })
    )

    latestCollection.resolve(page([proposal]))
    await expect
      .element(
        screen.getByText(
          'This review is no longer actionable. No action was replayed.'
        )
      )
      .not.toBeInTheDocument()
  })

  it('ignores a delayed Summary edit reconciliation after closing and reopening the editor', async () => {
    const queryClient = client()
    const latestSummary = deferred<{
      data: typeof summary
      meta: Record<string, never>
      etag: string
    }>()
    const get = vi
      .spyOn(coreApi, 'getWithMetaAndEtag')
      .mockResolvedValueOnce({
        data: summary,
        meta: {},
        etag: '"reviewed-summary"',
      })
      .mockImplementation(async () => latestSummary.promise)
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue(
      page([
        { ...summary, isCurrent: true },
        {
          ...summary,
          id: candidateId,
          versionNumber: 3,
          content: 'Historical candidate',
          isCurrent: false,
        },
      ])
    )
    vi.spyOn(coreApi, 'patchWithMetaAndEtag').mockRejectedValue(
      new CoreApiError({
        message: 'Version changed',
        status: 412,
        kind: 'http',
      })
    )
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <SummaryPanel meetingId={meetingId} canEdit canRegenerate={false} />
      </QueryClientProvider>
    )

    await userEvent.click(screen.getByRole('button', { name: 'Edit current' }))
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Summary content' }),
      'Changed summary content'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Save reviewed version' })
    )
    await expect
      .element(screen.getByText('This summary changed while you were editing.'))
      .toBeInTheDocument()

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(screen.getByRole('button', { name: 'Edit current' }))

    latestSummary.resolve({
      data: { ...summary, content: 'Latest server summary' },
      meta: {},
      etag: '"latest-summary"',
    })
    await expect
      .element(screen.getByText('This summary changed while you were editing.'))
      .not.toBeInTheDocument()
    expect(get).toHaveBeenCalledTimes(2)
  })
})
