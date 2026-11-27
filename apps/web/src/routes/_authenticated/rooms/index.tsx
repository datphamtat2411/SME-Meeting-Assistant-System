import { useEffect } from 'react'
import { createFileRoute, useRouterState } from '@tanstack/react-router'
import { RoomsPage } from '@/features/rooms'
import {
  isRoomSearchCanonical,
  normalizeRoomSearch,
  updateRoomSearch,
  type RoomDirectorySearch,
} from '@/features/rooms/room-directory-state'

export const Route = createFileRoute('/_authenticated/rooms/')({
  validateSearch: normalizeRoomSearch,
  component: RoomsRoute,
})

function RoomsRoute() {
  const rawSearch = useRouterState({
    select: (routerState) => routerState.location.search,
  })
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  useEffect(() => {
    if (isRoomSearchCanonical(rawSearch)) return
    void navigate({
      search: normalizeRoomSearch(rawSearch),
      replace: true,
    })
  }, [navigate, rawSearch])

  return (
    <RoomsPage
      search={search}
      onSearchChange={(patch, options) =>
        void navigate({
          search: (previous) =>
            updateRoomSearch(previous as RoomDirectorySearch, patch),
          replace: options?.replace,
        })
      }
    />
  )
}
