import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'

const routerMock = vi.hoisted(() => ({
  search: {
    page: 2,
    pageSize: 10,
    q: 'roadmap',
    sort: 'createdAt,desc',
  },
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    getRouteApi: () => ({
      useSearch: () => routerMock.search,
      useNavigate: () => routerMock.navigate,
    }),
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
          params?.meetingId
            ? to.replace('$meetingId', params.meetingId)
            : to
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

import { MeetingsPage } from './index'

describe('MeetingsPage', () => {
  it('renders API projection fields, unscheduled drafts, canonical status, and links', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockImplementation(async (url) => {
      if (url === '/rooms') {
        return {
          data: [],
          meta: {
            pagination: {
              page: 0,
              size: 100,
              totalElements: 0,
              totalPages: 0,
              hasNext: false,
              hasPrevious: false,
            },
          },
        }
      }

      return {
        data: [
          {
            id: 'meeting-1',
            title: 'Roadmap',
            description: null,
            organizerUserId: 'organizer-1',
            roomId: 'room-1',
            scheduledStartAt: '2026-09-01T09:00:00+07:00',
            scheduledEndAt: '2026-09-01T10:00:00+07:00',
            status: 'IN_PROGRESS',
            createdAt: '2026-09-01T00:00:00Z',
            display: {
              organizerName: 'Lan Nguyen',
              roomName: 'Hoa Sen',
              roomLocation: 'Building A',
              participantCount: 3,
              participantPreview: [
                { userId: 'user-1', displayName: 'Lan Nguyen' },
                { userId: 'user-2', displayName: 'Minh Tran' },
              ],
            },
          },
          {
            id: 'meeting-2',
            title: 'Unscheduled draft',
            description: null,
            organizerUserId: 'organizer-2',
            roomId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            status: 'DRAFT',
            createdAt: '2026-09-01T00:00:00Z',
            display: {
              organizerName: null,
              roomName: null,
              roomLocation: null,
              participantCount: 0,
              participantPreview: [],
            },
          },
          {
            id: 'meeting-3',
            title: 'Unavailable room',
            description: null,
            organizerUserId: 'organizer-3',
            roomId: 'room-missing',
            scheduledStartAt: null,
            scheduledEndAt: null,
            status: 'DRAFT',
            createdAt: '2026-09-01T00:00:00Z',
            display: {
              organizerName: 'Organizer 2',
              roomName: null,
              roomLocation: null,
              participantCount: 0,
              participantPreview: [],
            },
          },
        ],
        meta: {
          pagination: {
            page: 1,
            size: 10,
            totalElements: 3,
            totalPages: 1,
            hasNext: false,
            hasPrevious: true,
          },
        },
      }
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingsPage />
      </QueryClientProvider>
    )

    await expect
      .element(screen.getByText('Organized by Lan Nguyen'))
      .toBeInTheDocument()
    await expect.element(screen.getByText('Hoa Sen')).toBeInTheDocument()
    await expect.element(screen.getByText('Building A')).toBeInTheDocument()
    await expect.element(screen.getByText('3 participants')).toBeInTheDocument()
    await expect
      .element(screen.getByText('Lan Nguyen, Minh Tran +1 more'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('cell', { name: 'Live', exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Unscheduled', { exact: true }).first())
      .toBeInTheDocument()
    await expect.element(screen.getByText('Unknown organizer')).toBeInTheDocument()
    await expect
      .element(screen.getByText('Room unassigned', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('No room location', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Room unavailable', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('Location unavailable', { exact: true }))
      .toBeInTheDocument()
    await expect.element(screen.getByRole('link', { name: 'Live' })).toHaveAttribute(
      'href',
      '/meetings/meeting-1/live'
    )
    await expect.element(screen.getByRole('link', { name: 'View Roadmap' })).toHaveAttribute(
      'href',
      '/meetings/meeting-1'
    )
    await expect
      .element(screen.getByRole('link', { name: 'View Unscheduled draft' }))
      .toHaveAttribute('href', '/meetings/meeting-2')
  })

  it('resets URL-driven discovery state without creating a local meeting', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
      data: [],
      meta: {
        pagination: {
          page: 0,
          size: 10,
          totalElements: 0,
          totalPages: 0,
          hasNext: false,
          hasPrevious: false,
        },
      },
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MeetingsPage />
      </QueryClientProvider>
    )

    await userEvent.click(screen.getByRole('button', { name: 'Reset filters' }))

    expect(routerMock.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: {} })
    )
  })
})
