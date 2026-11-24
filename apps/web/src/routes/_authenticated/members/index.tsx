import { useEffect } from 'react'
import { createFileRoute, useRouterState } from '@tanstack/react-router'
import { RequestError, RequestLoading } from '@/components/request-state'
import { useCurrentUserVerification } from '@/features/auth/session/current-user-verification'
import { ForbiddenError } from '@/features/errors/forbidden'
import { MembersPage } from '@/features/members'
import { getMemberDirectoryAccess } from '@/features/members/member-access-policy'
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
  const verification = useCurrentUserVerification()
  const access = getMemberDirectoryAccess(verification.identity)

  if (
    verification.status === 'confirmed-authorization-denial' ||
    verification.status === 'confirmed-authentication-loss' ||
    access.type === 'denied'
  ) {
    return <ForbiddenError />
  }

  if (!verification.identity) {
    return verification.query.error ? (
      <RequestError
        error={verification.query.error}
        retry={() => void verification.query.refetch()}
      />
    ) : (
      <RequestLoading label='Verifying member-directory access…' />
    )
  }

  return <MemberDirectoryRouteContent />
}

function MemberDirectoryRouteContent() {
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
