import { useEffect } from 'react'
import { createFileRoute, useRouterState } from '@tanstack/react-router'
import { CalendarPage } from '@/features/calendar'
import {
  isCalendarSearchCanonical,
  normalizeCalendarSearch,
} from '@/features/calendar/calendar-state'

export const Route = createFileRoute('/_authenticated/calendar/')({
  validateSearch: normalizeCalendarSearch,
  component: CalendarRoute,
})

// eslint-disable-next-line react-refresh/only-export-components -- TanStack file routes use a module-level route component.
function CalendarRoute() {
  const rawSearch = useRouterState({
    select: (routerState) => routerState.location.search,
  })
  const navigate = Route.useNavigate()

  useEffect(() => {
    if (isCalendarSearchCanonical(rawSearch)) return
    void navigate({
      search: normalizeCalendarSearch(rawSearch),
      replace: true,
    })
  }, [navigate, rawSearch])

  return <CalendarPage />
}
