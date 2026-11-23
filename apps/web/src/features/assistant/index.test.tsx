import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { CoreApiError, coreApi } from '@/lib/core-api'
import { AssistantPage } from './index'

const meetingId = '11111111-1111-4111-8111-111111111111'
const conversationId = '22222222-2222-4222-8222-222222222222'
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

function setupReads(
  options: {
    conversations?: unknown
    detail?: unknown
    onDetail?: (readCount: number) => unknown
  } = {}
) {
  let detailReads = 0
  const get = vi
    .spyOn(coreApi, 'getWithMeta')
    .mockImplementation(async (url) => {
      if (url === '/meetings') {
        return { data: [meeting], meta: meetingListMeta } as never
      }
      if (url === '/assistant/conversations') {
        if (
          options.conversations !== undefined &&
          !Array.isArray(options.conversations)
        ) {
          throw options.conversations
        }
        return {
          data: options.conversations ?? [conversation],
          meta: {},
        } as never
      }
      if (url === `/assistant/conversations/${conversationId}`) {
        detailReads += 1
        const value =
          options.onDetail?.(detailReads) ?? options.detail ?? baseDetail
        return { data: value, meta: {} } as never
      }
      throw new Error(`Unexpected GET ${url}`)
    })
  return { get, getDetailReads: () => detailReads }
}

async function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <AssistantPage />
    </QueryClientProvider>
  )
}

async function selectMeeting(screen: Awaited<ReturnType<typeof render>>) {
  await userEvent.click(
    screen.getByRole('button', { name: 'Use meeting for Assistant' })
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

  it('keeps a 202 turn in processing and observes completion through read-only history', async () => {
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
    const { getDetailReads } = setupReads({
      onDetail: (reads) => (reads < 3 ? processingDetail() : completedDetail),
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
      .poll(() => getDetailReads(), { timeout: 3_000 })
      .toBeGreaterThan(2)
    await expect
      .element(screen.getByText('The accepted answer is now available.'))
      .toBeVisible()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('uses an explicit history refresh to confirm a completed accepted turn', async () => {
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

    await expect.element(screen.getByText('Planning questions')).toBeVisible()
    await expect
      .element(screen.getByText('The launch is planned for Friday.').first())
      .not.toBeInTheDocument()
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

  it('reports stale-source outcomes without fabricating success', async () => {
    setupReads()
    const post = vi
      .spyOn(coreApi, 'post')
      .mockRejectedValueOnce(
        coreError(409, 'Assistant evidence is no longer current.')
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

  it('keeps an uncertain submission identity for an explicit retry', async () => {
    setupReads()
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
  })

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
