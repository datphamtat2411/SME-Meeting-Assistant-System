import { StrictMode, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import type { AssistantSelection } from './assistant-selection'
import { AssistantPage } from './index'

const meetingId = '11111111-1111-4111-8111-111111111111'
const conversationId = '22222222-2222-4222-8222-222222222222'
const otherMeetingId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const otherConversationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const userMessageId = '33333333-3333-4333-8333-333333333333'
const assistantMessageId = '44444444-4444-4444-8444-444444444444'
const sourceId = '55555555-5555-4555-8555-555555555555'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({
      children,
      to,
      params,
      ...rest
    }: {
      children?: React.ReactNode
      to: string
      params?: { meetingId?: string }
    }) => (
      <a
        href={
          params?.meetingId ? to.replace('$meetingId', params.meetingId) : to
        }
        {...rest}
      >
        {children}
      </a>
    ),
  }
})

vi.mock('@/components/layout/header', () => ({
  Header: ({ children }: { children?: React.ReactNode }) => (
    <header>{children}</header>
  ),
}))
vi.mock('@/components/layout/header-actions', () => ({
  HeaderActions: () => null,
}))
vi.mock('@/components/layout/main', () => ({
  Main: ({ children, ...props }: React.ComponentProps<'main'>) => (
    <main {...props}>{children}</main>
  ),
}))

const meeting = {
  id: meetingId,
  title: 'Product planning',
  description: 'Planning notes',
  organizerUserId: '66666666-6666-4666-8666-666666666666',
  roomId: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
  status: 'ENDED' as const,
  startedAt: null,
  endedAt: null,
  cancelledAt: null,
  createdAt: '2026-11-22T09:00:00Z',
  updatedAt: '2026-11-22T09:00:00Z',
  display: {
    organizerName: 'Organizer',
    roomName: null,
    roomLocation: null,
    participantCount: 1,
    participantPreview: [],
  },
}

const meetingListMeta = {
  pagination: {
    page: 0,
    size: 20,
    totalElements: 1,
    totalPages: 1,
    hasNext: false,
    hasPrevious: false,
  },
}

const conversation = {
  id: conversationId,
  meetingId,
  title: 'Planning questions',
  status: 'ACTIVE',
  createdAt: '2026-11-22T09:05:00Z',
  updatedAt: '2026-11-22T09:05:00Z',
}
const otherMeeting = {
  ...meeting,
  id: otherMeetingId,
  title: 'Other meeting',
}
const otherConversation = {
  ...conversation,
  id: otherConversationId,
  meetingId: otherMeetingId,
  title: 'Other meeting questions',
}

const groundedAssistantMessage = {
  id: assistantMessageId,
  role: 'ASSISTANT' as const,
  content: 'The launch is planned for Friday.',
  answerStatus: 'GROUNDED' as const,
  visibility: 'VISIBLE' as const,
  claims: [
    {
      claimId: 'claim-1',
      text: 'The launch is planned for Friday.',
      support: 'SUPPORTED',
      citationIds: ['citation-1'],
    },
  ],
  citations: [
    {
      citationId: 'citation-1',
      sourceType: 'TRANSCRIPT',
      sourceId,
      meetingId,
      sourceRevision: 3,
      retrievalChunkId: 'chunk-1',
      claimIds: ['claim-1'],
    },
  ],
  createdAt: '2026-11-22T09:06:00Z',
}

const baseDetail = {
  conversation,
  messages: [
    {
      id: userMessageId,
      role: 'USER' as const,
      content: 'When is the launch?',
      answerStatus: null,
      visibility: 'VISIBLE' as const,
      claims: [],
      citations: [],
      createdAt: '2026-11-22T09:05:30Z',
    },
    groundedAssistantMessage,
  ],
  page: 0,
  size: 50,
  hasMore: false,
}

function messageDto(
  id: string,
  role: 'USER' | 'ASSISTANT',
  content: string,
  createdAt: string
) {
  return {
    id,
    role,
    content,
    answerStatus: role === 'USER' ? null : ('GROUNDED' as const),
    visibility: 'VISIBLE' as const,
    claims: [],
    citations: [],
    createdAt,
  }
}

function insufficientDetail() {
  return {
    ...baseDetail,
    messages: [
      baseDetail.messages[0],
      {
        ...groundedAssistantMessage,
        id: '77777777-7777-4777-8777-777777777777',
        content: 'There is not enough evidence to answer this question.',
        answerStatus: 'INSUFFICIENT_EVIDENCE' as const,
        claims: [],
        citations: [],
      },
    ],
  }
}

function processingDetail() {
  return {
    ...baseDetail,
    messages: [baseDetail.messages[0]],
  }
}

function createConversationDetail() {
  return {
    ...baseDetail,
    conversation: {
      ...conversation,
      title: 'New conversation',
    },
    messages: [],
  }
}

function coreError(
  status: number,
  message: string,
  options: Partial<ConstructorParameters<typeof CoreApiError>[0]> = {}
) {
  return new CoreApiError({
    status,
    message,
    kind: status >= 500 ? 'server' : 'http',
    ...options,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function acceptedTurn(
  state: 'PROCESSING' | 'COMPLETED' = 'COMPLETED',
  acceptedAssistantMessageId: string | null = assistantMessageId
) {
  return {
    turnId: '99999999-9999-4999-8999-999999999999',
    state,
    userMessageId,
    assistantMessageId: acceptedAssistantMessageId,
    answerStatus: state === 'COMPLETED' ? 'GROUNDED' : null,
    answer: state === 'COMPLETED' ? 'Accepted answer' : null,
    claims: state === 'COMPLETED' ? groundedAssistantMessage.claims : [],
    citations: state === 'COMPLETED' ? groundedAssistantMessage.citations : [],
  }
}

function setupReads(
  options: {
    conversations?: unknown
    conversationPages?: Record<number, unknown>
    onConversations?: (readCount: number, page: number) => unknown
    detail?: unknown
    onStatus?: (
      reads: number,
      conversationId: string,
      turnId: string
    ) => unknown
    lookup?: unknown
    onLookup?: (reads: number) => unknown
    detailPages?: Record<string, Record<number, unknown>>
    detailsById?: Record<string, unknown>
    onDetail?: (
      readCount: number,
      page: number,
      currentConversationId: string
    ) => unknown
  } = {}
) {
  let detailReads = 0
  let statusReads = 0
  let lookupReads = 0
  let conversationReads = 0
  const get = vi
    .spyOn(coreApi, 'getWithMeta')
    .mockImplementation(async (url, config) => {
      if (url === '/meetings') {
        return {
          data: options.detailsById ? [meeting, otherMeeting] : [meeting],
          meta: {
            pagination: {
              ...meetingListMeta.pagination,
              totalElements: options.detailsById ? 2 : 1,
            },
          },
        } as never
      }
      if (url === '/assistant/conversations') {
        conversationReads += 1
        const currentPage = Number(config?.params?.page ?? 0)
        const value =
          options.onConversations?.(conversationReads, currentPage) ??
          options.conversationPages?.[currentPage] ??
          options.conversations ??
          (options.detailsById
            ? [conversation, otherConversation]
            : [conversation])
        if (!Array.isArray(value)) {
          throw value
        }
        return {
          data: value,
          meta: {},
        } as never
      }
      const statusPath =
        /^\/assistant\/conversations\/([^/]+)\/turns\/([^/]+)$/.exec(url)
      if (statusPath) {
        statusReads += 1
        const [, currentConversationId, turnId] = statusPath
        const value = await options.onStatus?.(
          statusReads,
          currentConversationId,
          turnId
        )
        if (value instanceof Error) throw value
        return {
          data: value ?? turnStatus(currentConversationId, turnId),
          meta: {},
        } as never
      }
      if (url.endsWith('/turns')) {
        lookupReads += 1
        const value = await options.onLookup?.(lookupReads)
        if (value instanceof Error) throw value
        if (value !== undefined || options.lookup !== undefined)
          return { data: value ?? options.lookup, meta: {} } as never
        throw coreError(404, 'Turn not found', {
          code: 'ASSISTANT_TURN_NOT_FOUND',
        })
      }
      if (url.startsWith('/assistant/conversations/')) {
        detailReads += 1
        const currentConversationId = decodeURIComponent(
          url.slice('/assistant/conversations/'.length)
        )
        const currentPage = config?.params?.beforeMessageId
          ? 1
          : Number(config?.params?.page ?? 0)
        const value =
          (await options.onDetail?.(
            detailReads,
            currentPage,
            currentConversationId
          )) ??
          options.detailPages?.[currentConversationId]?.[currentPage] ??
          options.detailsById?.[currentConversationId] ??
          options.detail ??
          (currentConversationId === otherConversationId
            ? {
                ...baseDetail,
                conversation: otherConversation,
                messages: [],
              }
            : baseDetail)
        if (value instanceof Error) throw value
        const page = value as typeof baseDetail
        return {
          data: {
            ...page,
            page: 0,
            nextBeforeMessageId: page.hasMore ? page.messages[0]?.id : null,
          },
          meta: {},
        } as never
      }
      throw new Error(`Unexpected GET ${url}`)
    })
  return {
    get,
    getDetailReads: () => detailReads,
    getStatusReads: () => statusReads,
    getConversationReads: () => conversationReads,
  }
}

function turnStatus(
  conversationId: string,
  turnId: string,
  state: 'PROCESSING' | 'COMPLETED' = 'PROCESSING',
  messageId = assistantMessageId,
  leaseStatus: 'ACTIVE' | 'EXPIRED' = 'ACTIVE'
) {
  return {
    conversationId,
    turnId,
    state,
    leaseStatus: state === 'PROCESSING' ? leaseStatus : null,
    userMessageId,
    assistantMessageId: state === 'COMPLETED' ? messageId : null,
    answerStatus: state === 'COMPLETED' ? 'GROUNDED' : null,
  }
}

function TestAssistant({ initial = {} }: { initial?: AssistantSelection }) {
  const [selection, setSelection] = useState(initial)
  return (
    <AssistantPage selection={selection} onSelectionChange={setSelection} />
  )
}

async function renderPage(
  options: {
    strict?: boolean
    initial?: AssistantSelection
    client?: QueryClient
    onMeetingDetail?: (meetingId: string) => void
  } = {}
) {
  vi.spyOn(coreApi, 'getWithMetaAndEtag').mockImplementation(async (url) => {
    const source = url.endsWith(otherMeetingId) ? otherMeeting : meeting
    options.onMeetingDetail?.(source.id)
    if (url !== `/meetings/${source.id}`)
      throw new Error(`Unexpected GET ${url}`)
    return {
      data: {
        ...source,
        cancellationReason: null,
        createdByUserId: source.organizerUserId,
      },
      etag: '"meeting-0"',
      meta: {},
    } as never
  })
  return render(
    <QueryClientProvider
      client={
        options.client ??
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      {options.strict ? (
        <StrictMode>
          <TestAssistant initial={options.initial} />
        </StrictMode>
      ) : (
        <TestAssistant initial={options.initial} />
      )}
    </QueryClientProvider>
  )
}

async function selectMeeting(screen: Awaited<ReturnType<typeof render>>) {
  await userEvent.click(
    screen.getByRole('button', { name: 'Use meeting for Assistant' }).first()
  )
}

async function openConversation(screen: Awaited<ReturnType<typeof render>>) {
  await selectMeeting(screen)
  await userEvent.click(
    screen.getByRole('button', { name: 'Open conversation' })
  )
}

describe('AssistantPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps structured discovery independent of the selected conversation', async () => {
    const { get } = setupReads()
    const screen = await renderPage()
    await openConversation(screen)
    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .toBeVisible()
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Search meeting titles' }),
      'another meeting'
    )
    await expect
      .poll(() =>
        get.mock.calls.some(
          ([url, options]) =>
            url === '/meetings' && options?.params?.q === 'another meeting'
        )
      )
      .toBe(true)
    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .toBeVisible()
    await expect
      .element(screen.getByRole('combobox', { name: 'Assistant meeting' }))
      .toHaveValue(meetingId)
  })

  it('keeps page mount read-only and explicitly opens an authorized conversation', async () => {
    setupReads()
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue(conversation)
    const screen = await renderPage()

    await expect
      .element(screen.getByText('Product planning').last())
      .toBeVisible()
    expect(post).not.toHaveBeenCalled()

    await openConversation(screen)

    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .toBeVisible()
    expect(post).not.toHaveBeenCalled()
    await expect.element(screen.getByText('Revision 3').first()).toBeVisible()
  })

  it('creates a meeting-scoped conversation only after an explicit action', async () => {
    setupReads({ detail: createConversationDetail() })
    const post = vi.spyOn(coreApi, 'post').mockResolvedValueOnce(conversation)
    const screen = await renderPage()

    await selectMeeting(screen)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Conversation title' }),
      '  New conversation  '
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create conversation' })
    )

    await expect.poll(() => post.mock.calls.length).toBe(1)
    expect(post).toHaveBeenCalledWith('/assistant/conversations', {
      meetingId,
      title: 'New conversation',
    })
    await expect
      .element(screen.getByText('Conversation is ready for questions.'))
      .toBeVisible()
  })

  it('does not open a conversation created for a meeting after selection changes', async () => {
    const createdConversation = {
      ...conversation,
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'Created for Product planning',
    }
    const creation = deferred<typeof createdConversation>()
    const { getConversationReads } = setupReads({
      detailsById: {
        [conversationId]: baseDetail,
        [otherConversationId]: {
          ...baseDetail,
          conversation: otherConversation,
          messages: [],
        },
      },
      onConversations: (readCount) =>
        readCount > 1
          ? [conversation, otherConversation, createdConversation]
          : undefined,
    })
    const post = vi.spyOn(coreApi, 'post').mockImplementation(async (url) => {
      if (url === '/assistant/conversations') return creation.promise as never
      throw new Error(`Unexpected POST ${url}`)
    })
    const screen = await renderPage()

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assistant meeting' }),
      meetingId
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create conversation' })
    )
    await expect.poll(() => post.mock.calls.length).toBe(1)

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assistant meeting' }),
      otherMeetingId
    )
    creation.resolve(createdConversation)

    await expect.poll(() => getConversationReads()).toBeGreaterThan(1)
    await expect
      .element(screen.getByText('Other meeting questions'))
      .toBeVisible()
    await expect
      .element(screen.getByText('Created for Product planning'))
      .not.toBeInTheDocument()

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assistant meeting' }),
      meetingId
    )
    await expect
      .element(screen.getByText('Created for Product planning'))
      .toBeVisible()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('keeps a newer conversation draft when an older submission resolves', async () => {
    const submission = deferred<ReturnType<typeof acceptedTurn>>()
    const acceptedAssistantMessageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const acceptedDetail = {
      ...baseDetail,
      messages: [
        baseDetail.messages[0],
        {
          ...groundedAssistantMessage,
          id: acceptedAssistantMessageId,
          content: 'Question A authoritative answer',
        },
      ],
    }
    let questionAAccepted = false
    setupReads({
      detailsById: {
        [conversationId]: baseDetail,
        [otherConversationId]: {
          ...baseDetail,
          conversation: otherConversation,
          messages: [],
        },
      },
      onDetail: (_readCount, _page, currentConversationId) =>
        currentConversationId === conversationId && questionAAccepted
          ? acceptedDetail
          : undefined,
    })
    const post = vi.spyOn(coreApi, 'post').mockImplementation(async (url) => {
      if (url.endsWith('/messages')) return submission.promise as never
      throw new Error(`Unexpected POST ${url}`)
    })
    const screen = await renderPage()
    await openConversation(screen)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Assistant question' }),
      'Question A'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask Assistant' }))
    await expect.poll(() => post.mock.calls.length).toBe(1)

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assistant meeting' }),
      otherMeetingId
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Open conversation' })
    )
    const currentQuestion = screen.getByRole('textbox', {
      name: 'Assistant question',
    })
    await userEvent.fill(currentQuestion, 'Question B draft')

    questionAAccepted = true
    submission.resolve(acceptedTurn('COMPLETED', acceptedAssistantMessageId))
    await expect
      .poll(() => (currentQuestion.element() as HTMLTextAreaElement).value)
      .toBe('Question B draft')
    await expect
      .element(screen.getByText('The launch date is Friday.'))
      .not.toBeInTheDocument()
    expect(post).toHaveBeenCalledTimes(1)

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assistant meeting' }),
      meetingId
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Open conversation' })
    )
    await expect
      .element(screen.getByText('Question A authoritative answer'))
      .toBeVisible()
  })

  it('does not show an old submission error in a newer conversation and keeps it usable', async () => {
    const submission = deferred<ReturnType<typeof acceptedTurn>>()
    setupReads({
      detailsById: {
        [conversationId]: baseDetail,
        [otherConversationId]: {
          ...baseDetail,
          conversation: otherConversation,
          messages: [],
        },
      },
    })
    const post = vi.spyOn(coreApi, 'post').mockImplementation(async (url) => {
      if (url.endsWith('/messages')) {
        if (post.mock.calls.length === 1) return submission.promise as never
        return acceptedTurn('PROCESSING', null) as never
      }
      throw new Error(`Unexpected POST ${url}`)
    })
    const screen = await renderPage()
    await openConversation(screen)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Assistant question' }),
      'Question A'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask Assistant' }))
    await expect.poll(() => post.mock.calls.length).toBe(1)

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assistant meeting' }),
      otherMeetingId
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Open conversation' })
    )
    submission.reject(coreError(503, 'Question A failed'))

    await expect
      .element(screen.getByText('Assistant is currently unavailable.'))
      .not.toBeInTheDocument()
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Assistant question' }),
      'Question B'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask Assistant' }))
    await expect.poll(() => post.mock.calls.length).toBe(2)
    expect(post.mock.calls[1]?.[0]).toBe(
      `/assistant/conversations/${otherConversationId}/messages`
    )
  })

  it('ignores a delayed stale polling result after navigating away', async () => {
    const pendingRead = deferred<unknown>()
    const { getStatusReads } = setupReads({
      detailsById: {
        [conversationId]: baseDetail,
        [otherConversationId]: {
          ...baseDetail,
          conversation: otherConversation,
          messages: [],
        },
      },
      onStatus: (readCount) =>
        readCount === 1 ? pendingRead.promise : undefined,
    })
    const post = vi.spyOn(coreApi, 'post').mockImplementation(async (url) => {
      if (url.endsWith('/messages')) {
        return acceptedTurn('PROCESSING', null) as never
      }
      throw new Error(`Unexpected POST ${url}`)
    })
    const screen = await renderPage()
    await openConversation(screen)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Assistant question' }),
      'Question A'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask Assistant' }))
    await expect
      .element(screen.getByText('Core is processing this question.'))
      .toBeVisible()
    await expect
      .poll(() => getStatusReads(), { timeout: 6_000 })
      .toBeGreaterThan(0)

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assistant meeting' }),
      otherMeetingId
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Open conversation' })
    )
    const currentQuestion = screen.getByRole('textbox', {
      name: 'Assistant question',
    })
    await userEvent.fill(currentQuestion, 'Question B draft')
    pendingRead.resolve(
      turnStatus(
        conversationId,
        acceptedTurn('PROCESSING', null).turnId,
        'COMPLETED'
      )
    )

    await expect
      .poll(() => (currentQuestion.element() as HTMLTextAreaElement).value)
      .toBe('Question B draft')
    expect(post).toHaveBeenCalledTimes(1)

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assistant meeting' }),
      meetingId
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Open conversation' })
    )
    await expect
      .element(screen.getByText('Core is processing this question.'))
      .toBeVisible()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('loads older conversation pages and opens an older authorized conversation', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      ...conversation,
      id: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      title: `Conversation on first page ${index + 1}`,
    }))
    const olderConversation = {
      ...conversation,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Older authorized conversation',
    }
    const olderDetail = {
      ...baseDetail,
      conversation: olderConversation,
      messages: [],
    }
    const { get } = setupReads({
      conversationPages: { 0: firstPage, 1: [olderConversation] },
      detailPages: { [olderConversation.id]: { 0: olderDetail } },
    })
    const screen = await renderPage()
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assistant meeting' }),
      meetingId
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Load older conversations' })
    )
    await expect
      .element(screen.getByText('Older authorized conversation'))
      .toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Open conversation' }).last()
    )

    await expect
      .element(screen.getByText('Older authorized conversation').last())
      .toBeVisible()
    expect(
      get.mock.calls.some(
        ([url, config]) =>
          url === `/assistant/conversations/${olderConversation.id}` &&
          config?.params?.page === 0
      )
    ).toBe(true)
    expect(
      screen.getByRole('button', { name: 'Load older conversations' })
    ).not.toBeInTheDocument()
  })

  it('keeps conversation cards after an older list-page failure and retries explicitly', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      ...conversation,
      id: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      title: `Conversation on first page ${index + 1}`,
    }))
    const olderConversation = {
      ...conversation,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Conversation after retry',
    }
    let olderAttempts = 0
    setupReads({
      onConversations: (_readCount, pageNumber) => {
        if (pageNumber === 0) return firstPage
        olderAttempts += 1
        if (olderAttempts === 1) {
          throw coreError(422, 'Older conversations unavailable')
        }
        return [firstPage[0]!, olderConversation]
      },
    })
    const screen = await renderPage()
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assistant meeting' }),
      meetingId
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Load older conversations' })
    )

    await expect
      .element(
        screen.getByText('Conversation on first page 1', { exact: true })
      )
      .toBeVisible()
    await expect
      .element(screen.getByText('Older conversations unavailable'))
      .toBeVisible()
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Retry loading older conversations',
      })
    )
    await expect
      .element(screen.getByText('Conversation after retry'))
      .toBeVisible()
    await expect
      .element(
        screen.getByText('Conversation on first page 1', { exact: true })
      )
      .toBeVisible()
  })

  it('prepends older history chronologically and stops when Core has no more pages', async () => {
    const olderUser = messageDto(
      '77777777-7777-4777-8777-777777777777',
      'USER',
      'Older question',
      '2026-11-22T09:00:00Z'
    )
    const olderAssistant = messageDto(
      '88888888-8888-4888-8888-888888888888',
      'ASSISTANT',
      'Older answer',
      '2026-11-22T09:01:00Z'
    )
    const newestUser = messageDto(
      '99999999-9999-4999-8999-999999999999',
      'USER',
      'Newest question',
      '2026-11-22T10:00:00Z'
    )
    const newestAssistant = {
      ...messageDto(
        assistantMessageId,
        'ASSISTANT',
        'Newest answer',
        '2026-11-22T10:01:00Z'
      ),
      claims: groundedAssistantMessage.claims,
      citations: groundedAssistantMessage.citations,
    }
    const pageZero = {
      ...baseDetail,
      messages: [newestUser, newestAssistant],
      page: 0,
      hasMore: true,
    }
    const olderPage = {
      ...baseDetail,
      messages: [olderUser, olderAssistant],
      page: 1,
      hasMore: false,
    }
    setupReads({
      detailPages: { [conversationId]: { 0: pageZero, 1: olderPage } },
    })
    const screen = await renderPage()
    await openConversation(screen)
    await userEvent.click(
      screen.getByRole('button', { name: 'Load older messages' })
    )

    await expect.element(screen.getByText('Older question')).toBeVisible()
    await expect.element(screen.getByText('Newest answer')).toBeVisible()
    const articles = Array.from(
      screen
        .getByLabelText('Conversation history')
        .element()
        .querySelectorAll('article')
    )
    expect(articles.map((article) => article.textContent)).toEqual([
      expect.stringContaining('Older question'),
      expect.stringContaining('Older answer'),
      expect.stringContaining('Newest question'),
      expect.stringContaining('Newest answer'),
    ])
    expect(
      screen.getByRole('button', { name: 'Load older messages' })
    ).not.toBeInTheDocument()
  })

  it('preserves loaded history after an older-page failure and retries without duplicate IDs', async () => {
    const olderUser = messageDto(
      '77777777-7777-4777-8777-777777777777',
      'USER',
      'Older question survives',
      '2026-11-22T09:00:00Z'
    )
    const newestAssistant = {
      ...groundedAssistantMessage,
      content: 'Newest answer remains',
    }
    const pageZero = {
      ...baseDetail,
      messages: [newestAssistant],
      page: 0,
      hasMore: true,
    }
    const olderPage = {
      ...baseDetail,
      messages: [
        olderUser,
        { ...newestAssistant, content: 'Stale duplicate should be dropped' },
      ],
      page: 1,
      hasMore: false,
    }
    let olderAttempts = 0
    setupReads({
      onDetail: (_readCount, page) => {
        if (page === 1) {
          olderAttempts += 1
          if (olderAttempts === 1)
            throw coreError(422, 'Older page unavailable')
          return olderPage
        }
        return pageZero
      },
    })
    const screen = await renderPage()
    await openConversation(screen)
    await userEvent.click(
      screen.getByRole('button', { name: 'Load older messages' })
    )

    await expect
      .element(screen.getByText('Newest answer remains'))
      .toBeVisible()
    await expect
      .element(screen.getByText('Older page unavailable'))
      .toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry loading older messages' })
    )
    await expect
      .element(screen.getByText('Older question survives'))
      .toBeVisible()

    const history = screen.getByLabelText('Conversation history').element()
    expect(history.querySelectorAll('article')).toHaveLength(2)
    expect(
      screen.getByText('Stale duplicate should be dropped')
    ).not.toBeInTheDocument()
  })

  it('does not complete a processing turn from an unrelated later user and assistant pair', async () => {
    const unrelatedUser = messageDto(
      '77777777-7777-4777-8777-777777777777',
      'USER',
      'A later user turn',
      '2026-11-22T10:02:00Z'
    )
    const unrelatedAssistant = messageDto(
      '88888888-8888-4888-8888-888888888888',
      'ASSISTANT',
      'An unrelated later answer',
      '2026-11-22T10:03:00Z'
    )
    const laterTurnDetail = {
      ...baseDetail,
      messages: [baseDetail.messages[0], unrelatedUser, unrelatedAssistant],
    }
    const { getStatusReads } = setupReads({
      onDetail: (readCount) =>
        readCount > 1 ? laterTurnDetail : processingDetail(),
    })
    const post = vi.spyOn(coreApi, 'post').mockImplementation(async (url) => {
      if (url.endsWith('/messages')) {
        return acceptedTurn('PROCESSING', null) as never
      }
      throw new Error(`Unexpected POST ${url}`)
    })
    const screen = await renderPage()
    await openConversation(screen)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Assistant question' }),
      'Accepted question'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask Assistant' }))

    await expect
      .poll(() => getStatusReads(), { timeout: 6_000 })
      .toBeGreaterThan(0)
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh history' })
    )
    await expect
      .element(screen.getByText('An unrelated later answer'))
      .toBeVisible()
    await expect
      .element(screen.getByText('Core is processing this question.'))
      .toBeVisible()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('refreshes canonical history after authoritative terminal status', async () => {
    const exactMessageId = '77777777-7777-4777-8777-777777777777'
    const exactAnswer = {
      ...groundedAssistantMessage,
      id: exactMessageId,
      content: 'Exact accepted answer',
    }
    const completedDetail = {
      ...baseDetail,
      messages: [baseDetail.messages[0], exactAnswer],
    }
    const { getDetailReads } = setupReads({
      onStatus: (_reads, id, turnId) =>
        turnStatus(id, turnId, 'COMPLETED', exactMessageId),
      onDetail: (readCount) =>
        readCount > 1 ? completedDetail : processingDetail(),
    })
    const post = vi.spyOn(coreApi, 'post').mockImplementation(async (url) => {
      if (url.endsWith('/messages')) {
        return acceptedTurn('PROCESSING', null) as never
      }
      throw new Error(`Unexpected POST ${url}`)
    })
    const screen = await renderPage()
    await openConversation(screen)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Assistant question' }),
      'Accepted question'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask Assistant' }))

    await expect
      .poll(() => getDetailReads(), { timeout: 6_000 })
      .toBeGreaterThan(1)
    await expect
      .element(screen.getByText('Exact accepted answer'))
      .toBeVisible()
    await expect
      .element(screen.getByText('Core is processing this question.'))
      .not.toBeInTheDocument()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('keeps StrictMode mount and navigation read-only', async () => {
    setupReads()
    const post = vi.spyOn(coreApi, 'post').mockResolvedValue(conversation)
    const screen = await renderPage({ strict: true })
    await expect
      .element(screen.getByText('Product planning').last())
      .toBeVisible()
    await selectMeeting(screen)
    expect(post).not.toHaveBeenCalled()
  })

  it('submits a question through Core and displays authoritative grounded claims and citations', async () => {
    const submittedDetail = {
      ...baseDetail,
      messages: [
        ...baseDetail.messages,
        {
          ...groundedAssistantMessage,
          id: '88888888-8888-4888-8888-888888888888',
          content: 'The launch date is Friday.',
        },
      ],
    }
    setupReads({
      onDetail: (reads) => (reads < 2 ? baseDetail : submittedDetail),
    })
    const post = vi.spyOn(coreApi, 'post').mockImplementation(async (url) => {
      if (url.endsWith('/messages')) {
        return {
          turnId: '99999999-9999-4999-8999-999999999999',
          state: 'COMPLETED',
          userMessageId,
          assistantMessageId,
          answerStatus: 'GROUNDED',
          answer: 'The launch date is Friday.',
          claims: groundedAssistantMessage.claims,
          citations: groundedAssistantMessage.citations,
        } as never
      }
      return conversation
    })
    const screen = await renderPage()
    await openConversation(screen)
    const question = screen.getByRole('textbox', { name: 'Assistant question' })
    await userEvent.fill(question, 'When is the launch?')
    await userEvent.click(screen.getByRole('button', { name: 'Ask Assistant' }))

    await expect.poll(() => post.mock.calls.length).toBe(1)
    expect(post.mock.calls[0]?.[0]).toBe(
      `/assistant/conversations/${conversationId}/messages`
    )
    expect(post.mock.calls[0]?.[2]).toEqual({
      headers: { 'Idempotency-Key': expect.any(String) },
    })
    await expect
      .element(screen.getByText('The launch date is Friday.'))
      .toBeVisible()
    await expect.element(screen.getByText('Revision 3').first()).toBeVisible()
    await expect.element(screen.getByText('SUPPORTED').first()).toBeVisible()
  })

  it('does not invent citations for insufficient evidence', async () => {
    setupReads({ detail: insufficientDetail() })
    const screen = await renderPage()
    await openConversation(screen)

    await expect
      .element(
        screen.getByText(
          'There is not enough evidence to answer this question.'
        )
      )
      .toBeVisible()
    expect(screen.getByText('INSUFFICIENT_EVIDENCE')).toBeVisible()
    expect(
      screen.getByText('No verified citations were returned.')
    ).toBeVisible()
  })

  it('preserves PARTIAL status and its returned citations', async () => {
    setupReads({
      detail: {
        ...baseDetail,
        messages: [
          baseDetail.messages[0],
          {
            ...groundedAssistantMessage,
            answerStatus: 'PARTIAL',
            content:
              'Some evidence supports this, but the record is incomplete.',
          },
        ],
      },
    })
    const screen = await renderPage()
    await openConversation(screen)

    await expect
      .element(
        screen.getByText(
          'Some evidence supports this, but the record is incomplete.'
        )
      )
      .toBeVisible()
    await expect.element(screen.getByText('PARTIAL')).toBeVisible()
    await expect.element(screen.getByText('Revision 3').first()).toBeVisible()
  })

  it('keeps a 202 turn in processing and observes completion through read-only turn status', async () => {
    const completedDetail = {
      ...baseDetail,
      messages: [
        ...baseDetail.messages,
        {
          ...groundedAssistantMessage,
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          content: 'The accepted answer is now available.',
        },
      ],
    }
    const { getStatusReads } = setupReads({
      onStatus: (reads, id, turnId) =>
        reads === 1
          ? turnStatus(id, turnId)
          : turnStatus(
              id,
              turnId,
              'COMPLETED',
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            ),
      onDetail: (reads) => (reads < 2 ? processingDetail() : completedDetail),
    })
    const post = vi.spyOn(coreApi, 'post').mockImplementation(async (url) => {
      if (url.endsWith('/messages')) {
        return {
          turnId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          state: 'PROCESSING',
          userMessageId,
          assistantMessageId: null,
          answerStatus: null,
          answer: null,
          claims: [],
          citations: [],
        } as never
      }
      return conversation
    })
    const screen = await renderPage()
    await openConversation(screen)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Assistant question' }),
      'What is still processing?'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask Assistant' }))

    await expect
      .element(screen.getByText('Core is processing this question.'))
      .toBeVisible()
    await expect
      .poll(() => getStatusReads(), { timeout: 6_000 })
      .toBeGreaterThan(1)
    await expect
      .element(screen.getByText('The accepted answer is now available.'))
      .toBeVisible()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('keeps processing independent of an explicit history refresh', async () => {
    const completedDetail = {
      ...baseDetail,
      messages: [
        ...baseDetail.messages,
        {
          ...groundedAssistantMessage,
          id: 'abababab-abab-4bab-8bab-abababababab',
          content: 'The refreshed answer is now available.',
        },
      ],
    }
    setupReads({
      onDetail: (reads) => (reads < 2 ? processingDetail() : completedDetail),
    })
    const post = vi.spyOn(coreApi, 'post').mockImplementation(async (url) => {
      if (url.endsWith('/messages')) {
        return {
          turnId: 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',
          state: 'PROCESSING',
          userMessageId,
          assistantMessageId: null,
          answerStatus: null,
          answer: null,
          claims: [],
          citations: [],
        } as never
      }
      return conversation
    })
    const screen = await renderPage()
    await openConversation(screen)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Assistant question' }),
      'Refresh this accepted turn'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask Assistant' }))
    await expect
      .element(screen.getByText('Core is processing this question.'))
      .toBeVisible()

    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh history' })
    )
    await expect
      .element(screen.getByText('The refreshed answer is now available.'))
      .toBeVisible()
    await expect
      .element(screen.getByText('Core is processing this question.'))
      .toBeVisible()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('preserves meeting identity when changing selection', async () => {
    const otherMeeting = {
      ...meeting,
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: 'Other meeting',
    }
    const otherConversation = {
      ...conversation,
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      meetingId: otherMeeting.id,
    }
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/meetings') {
        return {
          data: [meeting, otherMeeting],
          meta: {
            pagination: { ...meetingListMeta.pagination, totalElements: 2 },
          },
        } as never
      }
      if (url === '/assistant/conversations') {
        return { data: [conversation, otherConversation], meta: {} } as never
      }
      if (url.endsWith(conversationId)) {
        return { data: baseDetail, meta: {} } as never
      }
      if (url.endsWith(otherConversation.id)) {
        return {
          data: { ...baseDetail, conversation: otherConversation },
          meta: {},
        } as never
      }
      throw new Error(`Unexpected GET ${url}`)
    })
    const screen = await renderPage()
    await userEvent.click(
      screen.getByRole('button', { name: 'Use meeting for Assistant' }).first()
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Open conversation' })
    )
    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .toBeVisible()

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assistant meeting' }),
      otherMeeting.id
    )

    await expect
      .element(
        screen.getByRole('heading', { name: 'Planning questions', exact: true })
      )
      .toBeVisible()
    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .toBeVisible()
  })

  it.each([
    [401, 'Sign in again to use the Assistant.'],
    [403, 'You are not authorized to use this Assistant conversation.'],
    [
      404,
      'This conversation or meeting is no longer available to your account.',
    ],
    [
      429,
      'Core is limiting concurrent Assistant work. Try again explicitly later.',
    ],
    [503, 'Assistant is currently unavailable.'],
  ])(
    'keeps meeting search available for Assistant status %s',
    async (status, message) => {
      setupReads({
        conversations: coreError(status, 'assistant unavailable'),
      })
      const screen = await renderPage()

      await expect
        .element(screen.getByText('Product planning').last())
        .toBeVisible()
      await expect.element(screen.getByText(message)).toBeVisible()
    }
  )

  it('contains previously loaded history when a refresh denies access', async () => {
    let revoked = false
    setupReads({
      onDetail: () =>
        revoked
          ? coreError(404, 'Conversation no longer available')
          : undefined,
    })
    const screen = await renderPage()
    await openConversation(screen)
    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .toBeVisible()
    revoked = true
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh history' })
    )
    await expect
      .element(screen.getByText('Conversation unavailable'))
      .toBeVisible()
    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('textbox', { name: 'Assistant question' }))
      .not.toBeInTheDocument()
  })

  it('withholds cached history when current access cannot be revalidated', async () => {
    let unavailable = false
    setupReads({
      onDetail: () =>
        unavailable
          ? coreError(503, 'Assistant temporarily unavailable')
          : undefined,
    })
    const screen = await renderPage()
    await openConversation(screen)
    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .toBeVisible()
    unavailable = true
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh history' })
    )
    await expect
      .element(screen.getByText('Assistant is currently unavailable.'))
      .toBeVisible()
    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('textbox', { name: 'Assistant question' }))
      .not.toBeInTheDocument()
  })

  it('revalidates an already-open conversation instead of restoring cached history', async () => {
    let revoked = false
    const blocked = deferred<unknown>()
    setupReads({
      onDetail: () => (revoked ? blocked.promise : undefined),
    })
    const screen = await renderPage()
    await openConversation(screen)
    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .toBeVisible()
    revoked = true
    await userEvent.click(screen.getByRole('button', { name: 'Opened' }))
    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .not.toBeInTheDocument()
    blocked.resolve(coreError(404, 'Conversation no longer available'))
    await expect
      .element(screen.getByText('Conversation unavailable'))
      .toBeVisible()
    await expect
      .element(screen.getByRole('textbox', { name: 'Assistant question' }))
      .not.toBeInTheDocument()
  })

  it('reports stale-source outcomes without fabricating success', async () => {
    setupReads()
    const post = vi.spyOn(coreApi, 'post').mockRejectedValueOnce(
      coreError(409, 'Assistant evidence is no longer current.', {
        code: 'ASSISTANT_SOURCE_STALE',
      })
    )
    const screen = await renderPage()
    await openConversation(screen)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Assistant question' }),
      'Ask about stale evidence'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask Assistant' }))
    await expect
      .element(screen.getByText('Assistant evidence is stale or unavailable.'))
      .toBeVisible()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('discovers an expired pending turn on a direct URL and recovers only on explicit action', async () => {
    const turnId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    setupReads({
      detail: {
        ...baseDetail,
        pendingTurn: turnStatus(
          conversationId,
          turnId,
          'PROCESSING',
          assistantMessageId,
          'EXPIRED'
        ),
      },
    })
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValue({ ...acceptedTurn('COMPLETED'), turnId })
    const screen = await renderPage({ initial: { conversationId, meetingId } })
    await expect
      .element(screen.getByText('Execution lease expired'))
      .toBeVisible()
    expect(post).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Recover turn' }))
    await expect.poll(() => post.mock.calls.length).toBe(1)
    expect(post.mock.calls[0]?.[0]).toBe(
      `/assistant/conversations/${conversationId}/turns/${turnId}/recover`
    )
  })

  it('keeps an uncertain submission identity for an explicit retry', async () => {
    const { get } = setupReads()
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValueOnce(
        new CoreApiError({
          message: 'The network outcome is uncertain.',
          code: 'NETWORK_ERROR',
          kind: 'network',
          recoveryOutcome: 'uncertain',
        })
      )
      .mockResolvedValueOnce({
        turnId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        state: 'COMPLETED',
        userMessageId,
        assistantMessageId,
        answerStatus: 'GROUNDED',
        answer: 'The answer is available.',
        claims: groundedAssistantMessage.claims,
        citations: groundedAssistantMessage.citations,
      })
    const screen = await renderPage()
    await openConversation(screen)
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Assistant question' }),
      'Retry this question safely'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask Assistant' }))
    await expect
      .element(
        screen.getByText(
          'Core may have accepted the request, but its outcome is not known. Refresh history or retry the same question explicitly; it will not be duplicated automatically.'
        )
      )
      .toBeVisible()

    await userEvent.click(
      screen.getByRole('button', { name: 'Retry or refresh' })
    )
    await expect.poll(() => post.mock.calls.length).toBe(2)
    expect(post.mock.calls[0]?.[2]).toEqual(post.mock.calls[1]?.[2])
    expect(get).toHaveBeenCalledWith(
      `/assistant/conversations/${conversationId}/turns`,
      { headers: post.mock.calls[0]?.[2]?.headers }
    )
  })

  it('preserves a rejected conflict through failed lookup and terminal observation', async () => {
    const turnId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    setupReads({
      onLookup: (reads) =>
        reads === 1
          ? coreError(503, 'Lookup unavailable')
          : turnStatus(conversationId, turnId),
      onStatus: () => turnStatus(conversationId, turnId, 'COMPLETED'),
    })
    const post = vi.spyOn(coreApi, 'post').mockRejectedValue(
      coreError(409, 'Conflict', {
        code: 'ASSISTANT_IDEMPOTENCY_CONFLICT',
      })
    )
    const screen = await renderPage({ initial: { conversationId, meetingId } })
    await userEvent.fill(
      screen.getByRole('textbox', { name: 'Assistant question' }),
      'Rejected intent'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask Assistant' }))
    await expect
      .element(screen.getByText('Assistant is currently unavailable.'))
      .toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: 'Retry or refresh' }))
      .not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Resume status checks' })
    )
    await expect
      .element(screen.getByRole('button', { name: 'Ask Assistant' }))
      .toBeVisible()
    await expect
      .element(
        screen.getByText(
          'This request identity belongs to a different question.'
        )
      )
      .toBeVisible()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('contains active history when the canonical meeting detail denies access', async () => {
    let revoked = false
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    setupReads()
    const screen = await renderPage({
      initial: { conversationId, meetingId },
      client,
      onMeetingDetail: () => {
        if (revoked) throw coreError(403, 'Meeting denied')
      },
    })
    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .toBeVisible()
    revoked = true
    await client.refetchQueries({ queryKey: ['meetings', 'detail', meetingId] })
    await expect
      .element(screen.getByRole('textbox', { name: 'Assistant question' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .not.toBeInTheDocument()
    expect(
      client.getQueryData([
        'assistant',
        'conversation',
        conversationId,
        'history',
        50,
      ])
    ).toBeUndefined()
    client.clear()
  })

  it('observes a displaced pending turn before recovering its replacement', async () => {
    const oldTurnId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const newTurnId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    let replaced = false
    const { get } = setupReads({
      onDetail: () => ({
        ...baseDetail,
        pendingTurn: turnStatus(
          conversationId,
          replaced ? newTurnId : oldTurnId,
          'PROCESSING',
          assistantMessageId,
          'EXPIRED'
        ),
      }),
      onStatus: (_reads, id, turnId) =>
        turnId === oldTurnId
          ? turnStatus(id, turnId, 'COMPLETED')
          : turnStatus(id, turnId, 'PROCESSING', assistantMessageId, 'EXPIRED'),
    })
    const post = vi
      .spyOn(coreApi, 'post')
      .mockResolvedValue({ ...acceptedTurn('COMPLETED'), turnId: newTurnId })
    const screen = await renderPage({ initial: { conversationId, meetingId } })
    await expect
      .element(screen.getByRole('button', { name: 'Recover turn' }))
      .toBeVisible()
    replaced = true
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh history' })
    )
    await expect
      .poll(
        () =>
          get.mock.calls.some(([url]) => url.endsWith('/turns/' + newTurnId)),
        { timeout: 6000 }
      )
      .toBe(true)
    expect(
      get.mock.calls.some(([url]) => url.endsWith('/turns/' + oldTurnId))
    ).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Recover turn' }))
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]?.[0]).toBe(
      `/assistant/conversations/${conversationId}/turns/${newTurnId}/recover`
    )
  })

  it('honors a status Retry-After when switching conversations and returning', async () => {
    const turnId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    let rateLimitedAt = 0
    const { getStatusReads } = setupReads({
      detailsById: {
        [conversationId]: {
          ...baseDetail,
          pendingTurn: turnStatus(conversationId, turnId),
        },
        [otherConversationId]: {
          ...baseDetail,
          conversation: otherConversation,
          messages: [],
        },
      },
      onStatus: (reads, id, currentTurnId) => {
        if (reads === 1) {
          rateLimitedAt = Date.now()
          return coreError(429, 'Rate limited', { retryAfter: '30' })
        }
        return turnStatus(id, currentTurnId)
      },
    })
    const screen = await renderPage({ initial: { conversationId, meetingId } })
    await expect.poll(() => getStatusReads()).toBe(1)
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assistant meeting' }),
      otherMeetingId
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Open conversation' })
    )
    await expect
      .element(screen.getByRole('heading', { name: otherConversation.title }))
      .toBeVisible()
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assistant meeting' }),
      meetingId
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Open conversation' })
    )
    await expect
      .element(screen.getByText('Core is processing this question.'))
      .toBeVisible()
    // A new observation cycle must not schedule its usual one-second read
    // while the server's original deadline is still in force.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(Date.now()).toBeLessThan(rateLimitedAt + 30_000)
    expect(getStatusReads()).toBe(1)
  }, 10_000)

  it('reports malformed Assistant responses without fabricating success', async () => {
    setupReads({
      conversations: new CoreApiError({
        message: 'Core API returned a malformed Assistant response.',
        code: 'MALFORMED_RESPONSE',
        kind: 'malformed',
      }),
    })
    const malformedScreen = await renderPage()
    await expect
      .element(malformedScreen.getByText('Assistant response was invalid.'))
      .toBeVisible()
  })
})
