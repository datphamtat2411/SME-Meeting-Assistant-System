import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { coreApi } from '@/lib/core-api'
import {
  currentCalendarMonth,
  isCalendarSearchCanonical,
  normalizeCalendarSearch,
  resolveCalendarState,
  shiftCalendarMonth,
  updateCalendarSearch,
  type CalendarSearch,
} from './calendar-state'
import { CalendarToolbar } from './calendar-toolbar'

function CalendarRouterHarness() {
  const search = calendarRoute.useSearch() as CalendarSearch
  const navigate = calendarRoute.useNavigate() as unknown as (options: {
    search: CalendarSearch | ((previous: CalendarSearch) => CalendarSearch)
    replace?: boolean
  }) => Promise<void>
  const rawSearch = useRouterState({
    select: (routerState) => routerState.location.search,
  })
  const state = resolveCalendarState(search)
  const serializedFilters = [
    state.filters.relationship,
    state.filters.status ?? '',
    state.filters.roomId ?? '',
    state.filters.q ?? '',
  ].join('|')

  function update(
    patch: Parameters<typeof updateCalendarSearch>[1],
    replace = false
  ) {
    void navigate({
      search: (previous) => updateCalendarSearch(previous, patch),
      replace,
    })
  }

  useEffect(() => {
    if (isCalendarSearchCanonical(rawSearch)) return
    void navigate({
      search: normalizeCalendarSearch(rawSearch),
      replace: true,
    })
  }, [navigate, rawSearch])

  return (
    <div>
      <output data-testid='calendar-router-state'>
        {`${state.monthKey}|${state.view}|${serializedFilters}`}
      </output>
      <CalendarToolbar
        month={state.monthKey}
        view={state.view}
        filters={state.filters}
        onNavigateMonth={(offset) =>
          update({
            month: shiftCalendarMonth(state.monthKey, offset),
          })
        }
        onToday={() => update({ month: undefined })}
        onViewChange={(view) => update({ view })}
        onFiltersChange={(filters, options) =>
          update(filters, options?.replace)
        }
      />
    </div>
  )
}

const rootRoute = createRootRoute({
  component: () => <Outlet />,
})
const calendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/calendar',
  validateSearch: normalizeCalendarSearch,
  component: CalendarRouterHarness,
})

function createCalendarRouter(initialEntry: string) {
  const history = createMemoryHistory({ initialEntries: [initialEntry] })
  const router = createRouter({
    routeTree: rootRoute.addChildren([calendarRoute]),
    history,
  })
  return { router, history }
}

async function renderCalendarRouter(
  router: ReturnType<typeof createCalendarRouter>['router']
) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Calendar router state', () => {
  it('restores a direct link and validated state after back navigation', async () => {
    vi.spyOn(coreApi, 'getWithMeta').mockResolvedValue({
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Room A',
        location: null,
      },
      meta: {},
    })
    const { router, history } = createCalendarRouter(
      '/calendar?month=2026-12&view=agenda&relationship=participant&status=CANCELLED&roomId=11111111-1111-4111-8111-111111111111&q=%20roadmap%20'
    )
    const screen = await renderCalendarRouter(router)

    await expect
      .element(screen.getByTestId('calendar-router-state'))
      .toHaveTextContent(
        '2026-12|agenda|participant|CANCELLED|11111111-1111-4111-8111-111111111111|roadmap'
      )

    await userEvent.click(
      screen.getByRole('button', { name: 'Previous month' })
    )
    await expect
      .element(screen.getByTestId('calendar-router-state'))
      .toHaveTextContent(
        '2026-11|agenda|participant|CANCELLED|11111111-1111-4111-8111-111111111111|roadmap'
      )

    history.back()
    await expect
      .element(screen.getByTestId('calendar-router-state'))
      .toHaveTextContent(
        '2026-12|agenda|participant|CANCELLED|11111111-1111-4111-8111-111111111111|roadmap'
      )
  })

  it('uses safe defaults for invalid direct-link search values', async () => {
    const { router } = createCalendarRouter(
      '/calendar?month=2026-13&view=week&relationship=organization&status=PROCESSING&roomId=%20%20&q=%20%20'
    )
    const screen = await renderCalendarRouter(router)
    const expectedMonth = currentCalendarMonth()

    await expect
      .element(screen.getByTestId('calendar-router-state'))
      .toHaveTextContent(`${expectedMonth}|month|all|||`)
    expect(router.state.location.search).toEqual({})
  })
})
