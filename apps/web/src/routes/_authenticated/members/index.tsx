import { useEffect } from 'react'
import { createFileRoute, useRouterState } from '@tanstack/react-router'
import { MembersPage } from '@/features/members'
import {
  isMemberSearchCanonical,
  normalizeMemberSearch,
  updateMemberSearch,
  type MemberDirectorySearch,
} from '@/features/members/member-directory-state'

export const Route = createFileRoute('/_authenticated/members/')({
  validateSearch: normalizeMemberSearch,
  component: MembersRoute,
})

function MembersRoute() {
  const rawSearch = useRouterState({
    select: (routerState) => routerState.location.search,
  })
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  useEffect(() => {
    if (isMemberSearchCanonical(rawSearch)) return
    void navigate({
      search: normalizeMemberSearch(rawSearch),
      replace: true,
    })
  }, [navigate, rawSearch])

  return (
    <MembersPage
      search={search}
      onSearchChange={(patch, options) =>
        void navigate({
          search: (previous) =>
            updateMemberSearch(previous as MemberDirectorySearch, patch),
          replace: options?.replace,
        })
      }
    />
  )
}
