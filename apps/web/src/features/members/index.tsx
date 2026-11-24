import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, RefreshCw, Search, ShieldAlert, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { getDisplayNameInitials } from '@/lib/utils'
import { useDirectorySearchDraft } from '@/hooks/use-directory-search-draft'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { currentUserQueryOptions } from '@/features/auth/session/current-user'
import {
  getMemberDirectoryAccess,
  constrainMemberSearch,
} from './member-access-policy'
import { MemberAdministrationDialog } from './member-administration-dialog'
import {
  changeMemberStatus,
  memberDetail,
  membersQuery,
  type Member,
} from './member-api'
import {
  memberRoles,
  memberStatuses,
  normalizeMemberSearch,
  resolveMemberDirectoryCriteria,
  type MemberDirectorySearch,
  type MemberRole,
  type MemberStatus,
} from './member-directory-state'
import {
  organizationalUnitsQuery,
  resolveOrganizationUnitReference,
  type OrganizationalUnit,
  type OrganizationUnitLookup,
} from './organization-api'
import { OrganizationUnitSelect } from './organization-unit-select'

type SearchChange = (
  patch: Partial<MemberDirectorySearch>,
  options?: { replace?: boolean }
) => void

const pageSizeChoices = [10, 20, 50, 100]
const searchDebounceMs = 350

function normalizeSearchDraft(value: string) {
  return normalizeMemberSearch({ q: value }).q
}

class ObsoleteMemberOperationError extends Error {
  constructor() {
    super(
      'Member-management authorization changed before the operation started.'
    )
    this.name = 'ObsoleteMemberOperationError'
  }
}

const roleLabels: Record<MemberRole, string> = {
  ADMINISTRATOR: 'Administrator',
  DEPARTMENT_MANAGER: 'Department manager',
  EMPLOYEE: 'Employee',
}

const statusLabels: Record<MemberStatus, string> = {
  PENDING_SETUP: 'Pending setup',
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
}

function roleBadgeClass(role: MemberRole) {
  if (role === 'ADMINISTRATOR') {
    return 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300'
  }
  if (role === 'DEPARTMENT_MANAGER') {
    return 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300'
  }
  return 'border-border bg-muted/60 text-foreground'
}

function statusBadgeClass(status: MemberStatus) {
  if (status === 'ACTIVE') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
  }
  if (status === 'PENDING_SETUP') {
    return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300'
  }
  return 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
}

function lookupState(
  units: OrganizationUnitLookup
): OrganizationUnitLookup['status'] {
  return units.status
}

function MemberOrganizationalUnit({
  id,
  lookup,
}: {
  id: string | null
  lookup: OrganizationUnitLookup
}) {
  const reference = resolveOrganizationUnitReference(id, lookup)
  if (reference.state === 'unassigned') {
    return <span className='text-muted-foreground'>Unassigned</span>
  }
  if (reference.state === 'resolved') {
    return (
      <div className='min-w-36'>
        <div className='font-medium'>{reference.unit.name}</div>
        <div className='text-xs text-muted-foreground'>
          {reference.unit.code}
        </div>
      </div>
    )
  }
  const message =
    reference.state === 'loading'
      ? 'Loading organizational unit'
      : reference.state === 'error'
        ? 'Organizational unit lookup failed'
        : reference.collectionEmpty
          ? 'No authorized active unit'
          : 'Unresolved unit reference'
  return (
    <div className='min-w-40 space-y-1'>
      <div className='text-sm text-muted-foreground'>{message}</div>
      <code className='block text-xs break-all text-muted-foreground'>
        {reference.id}
      </code>
    </div>
  )
}

function sameSearch(
  first: MemberDirectorySearch,
  second: MemberDirectorySearch
): boolean {
  const a = normalizeMemberSearch(first)
  const b = normalizeMemberSearch(second)
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) =>
        a[key as keyof MemberDirectorySearch] ===
        b[key as keyof MemberDirectorySearch]
    )
  )
}

export function MembersPage({
  search,
  onSearchChange,
}: {
  search: MemberDirectorySearch
  onSearchChange: SearchChange
}) {
  const queryClient = useQueryClient()
  const identity = useQuery(currentUserQueryOptions())
  const identityErrorStatus = identity.isRefetchError
    ? normalizeCoreApiError(identity.error).status
    : undefined
  const identityDenied =
    identityErrorStatus === 401 || identityErrorStatus === 403
  const identityResolved = identity.isSuccess && !identityDenied
  const identityVerified =
    identityResolved && !identity.isFetching && !identity.isRefetchError
  const access = getMemberDirectoryAccess(
    identityResolved ? identity.data : undefined
  )
  const accessKey =
    access.type === 'authorized'
      ? access.queryScopeKey
      : `${access.type}:${'actorId' in access ? access.actorId : ''}`
  const currentAuthorization = useRef({ accessKey, identityVerified })
  useLayoutEffect(() => {
    currentAuthorization.current = { accessKey, identityVerified }
  }, [accessKey, identityVerified])
  const statusOperationInFlight = useRef(false)
  const constrainedSearch =
    access.type === 'authorized'
      ? constrainMemberSearch(search, access)
      : normalizeMemberSearch(search)
  const criteria = resolveMemberDirectoryCriteria(constrainedSearch)
  const { draft: searchDraft, updateDraft: updateSearchDraft } =
    useDirectorySearchDraft({
      criteriaKey: JSON.stringify([accessKey, normalizeMemberSearch(search)]),
      committedQuery: criteria.q,
      normalize: normalizeSearchDraft,
      onCommit: (q) => onSearchChange({ q }, { replace: true }),
      delayMs: searchDebounceMs,
    })
  const unitsOptions = organizationalUnitsQuery(access)
  const units = useQuery({
    ...unitsOptions,
    enabled: identityResolved && access.type === 'authorized',
  })
  const memberDirectory = useQuery(membersQuery(criteria, access))
  const statusMutation = useMutation({
    mutationFn: async ({
      member,
      action,
      contextKey,
    }: {
      member: Member
      action: 'deactivate' | 'reactivate' | 'account-setup/reissue'
      contextKey: string
    }) => {
      if (
        currentAuthorization.current.accessKey !== contextKey ||
        !currentAuthorization.current.identityVerified
      ) {
        throw new ObsoleteMemberOperationError()
      }
      const fresh = await memberDetail(member.id)
      if (
        currentAuthorization.current.accessKey !== contextKey ||
        !currentAuthorization.current.identityVerified
      ) {
        throw new ObsoleteMemberOperationError()
      }
      return changeMemberStatus(member.id, action, fresh.etag)
    },
    onSuccess: async (_result, input) => {
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      if (currentAuthorization.current.accessKey === input.contextKey) {
        toast.success('Account updated')
      }
    },
    onError: (error, input) => {
      if (
        error instanceof ObsoleteMemberOperationError ||
        currentAuthorization.current.accessKey !== input.contextKey
      ) {
        return
      }
      toast.error('Account update failed', {
        description:
          error instanceof Error
            ? error.message
            : 'The account was not updated.',
      })
    },
    onSettled: () => {
      statusOperationInFlight.current = false
    },
  })
  const [administrationDialog, setAdministrationDialog] = useState<{
    contextKey: string
    member: Member | null
  } | null>(null)
  const [administrationDialogScope, setAdministrationDialogScope] =
    useState(accessKey)
  if (administrationDialogScope !== accessKey) {
    setAdministrationDialogScope(accessKey)
    setAdministrationDialog(null)
  }
  const organizationLookup: OrganizationUnitLookup = units.isPending
    ? { status: 'loading' }
    : units.isError
      ? { status: 'error' }
      : { status: 'success', units: units.data ?? [] }
  const organizationUnits: OrganizationalUnit[] = units.data ?? []
  const priorAccessKey = useRef(accessKey)

  useEffect(() => {
    if (priorAccessKey.current === accessKey) return
    const previousKey = priorAccessKey.current
    priorAccessKey.current = accessKey
    void queryClient.cancelQueries({
      queryKey: ['users', 'directory', previousKey],
    })
    void queryClient.cancelQueries({
      queryKey: ['organization', 'units', previousKey],
    })
    queryClient.removeQueries({
      queryKey: ['users', 'directory', previousKey],
    })
    queryClient.removeQueries({
      queryKey: ['organization', 'units', previousKey],
    })
  }, [accessKey, queryClient])

  useEffect(() => {
    if (!identityResolved || access.type !== 'authorized') return
    if (!sameSearch(search, constrainedSearch)) {
      onSearchChange(
        {
          q: constrainedSearch.q,
          role: constrainedSearch.role,
          status: constrainedSearch.status,
          orgUnitId: constrainedSearch.orgUnitId,
          page: constrainedSearch.page,
          size: constrainedSearch.size,
        },
        { replace: true }
      )
    }
  }, [access, constrainedSearch, identityResolved, onSearchChange, search])

  useEffect(() => {
    if (
      !memberDirectory.data ||
      memberDirectory.isPlaceholderData ||
      !memberDirectory.data.outOfRange
    ) {
      return
    }
    const page = Math.max(memberDirectory.data.pagination.totalPages - 1, 0)
    onSearchChange({ page }, { replace: true })
  }, [memberDirectory.data, memberDirectory.isPlaceholderData, onSearchChange])

  function editMember(member: Member | null) {
    if (
      !identityVerified ||
      access.type !== 'authorized' ||
      statusOperationInFlight.current ||
      statusMutation.isPending ||
      currentAuthorization.current.accessKey !== accessKey
    ) {
      return
    }
    setAdministrationDialog({ contextKey: accessKey, member })
  }

  function runLifecycle(
    member: Member,
    action: 'deactivate' | 'reactivate' | 'account-setup/reissue'
  ) {
    if (
      !identityVerified ||
      access.type !== 'authorized' ||
      currentAuthorization.current.accessKey !== accessKey
    ) {
      return
    }
    const actionLabel = action.replace(/\//g, ' ')
    if (!window.confirm(`Apply ${actionLabel} to ${member.displayName}?`)) {
      return
    }
    if (
      !identityVerified ||
      currentAuthorization.current.accessKey !== accessKey ||
      statusOperationInFlight.current
    ) {
      return
    }
    statusOperationInFlight.current = true
    statusMutation.mutate({ member, action, contextKey: accessKey })
  }

  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'>
          <div>
            <p className='text-sm font-medium text-primary'>Administration</p>
            <h1 className='mt-1 text-2xl font-bold tracking-tight sm:text-3xl'>
              Members
            </h1>
            <p className='mt-2 max-w-2xl text-muted-foreground'>
              Search organizational accounts and the management scope available
              to your role.
            </p>
          </div>
          {identityResolved && access.type === 'authorized' && (
            <Button
              disabled={!identityVerified}
              onClick={() => editMember(null)}
            >
              <UserRound className='size-4' />
              Add member
            </Button>
          )}
        </div>

        {identity.data && !identityVerified && !identityDenied && (
          <div
            role='status'
            className='flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm'
          >
            <span>
              {identity.isFetching
                ? 'Verifying current administration access. Existing directory and form state are preserved; submissions are paused.'
                : 'Current administration access could not be verified. Existing form state is preserved; verify access before submitting.'}
            </span>
            {!identity.isFetching && (
              <Button
                size='sm'
                variant='outline'
                onClick={() => void identity.refetch()}
              >
                Retry verification
              </Button>
            )}
          </div>
        )}

        {!identityResolved ? (
          identity.isError ? (
            <RequestError
              error={identity.error}
              retry={() => void identity.refetch()}
            />
          ) : (
            <RequestLoading label='Verifying member-directory access…' />
          )
        ) : access.type === 'unresolved' ? (
          <RequestLoading label='Verifying member-directory scope…' />
        ) : access.type === 'denied' ? (
          <div
            role='alert'
            className='flex items-start gap-3 rounded-lg border p-5 text-muted-foreground'
          >
            <ShieldAlert className='mt-0.5 size-5 shrink-0' />
            <p>
              Member directory access requires an authorized management scope.
            </p>
          </div>
        ) : access.type === 'empty-scope' ? (
          <Card className='overflow-hidden'>
            <CardHeader className='border-b'>
              <CardTitle>Member directory</CardTitle>
              <CardDescription>
                The directory is limited to organizational units explicitly
                granted to your account.
              </CardDescription>
            </CardHeader>
            <CardContent className='p-0'>
              <RequestEmpty
                title='No members in scope'
                description='No organizational units are granted for member management.'
              />
            </CardContent>
          </Card>
        ) : (
          <Card className='overflow-hidden'>
            <CardHeader className='gap-4 border-b'>
              <div>
                <CardTitle>Member directory</CardTitle>
                <CardDescription className='mt-1'>
                  {access.role === 'ADMINISTRATOR'
                    ? 'Organization-wide account discovery.'
                    : 'Employees in your explicitly granted organizational units.'}
                </CardDescription>
              </div>
              <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-5'>
                <div className='relative sm:col-span-2 xl:col-span-2'>
                  <Search className='pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                  <Input
                    value={searchDraft}
                    onChange={(event) => updateSearchDraft(event.target.value)}
                    maxLength={200}
                    placeholder='Search name or email'
                    aria-label='Search members'
                    className='pl-9'
                  />
                </div>
                {access.canFilterRoles && (
                  <div className='space-y-1.5'>
                    <span className='text-xs font-medium text-muted-foreground'>
                      Global role
                    </span>
                    <Select
                      value={criteria.role ?? 'all'}
                      onValueChange={(value) =>
                        onSearchChange({
                          role:
                            value === 'all' ? undefined : (value as MemberRole),
                        })
                      }
                    >
                      <SelectTrigger aria-label='Filter by global role'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='all'>All roles</SelectItem>
                        {memberRoles.map((role) => (
                          <SelectItem key={role} value={role}>
                            {roleLabels[role]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className='space-y-1.5'>
                  <span className='text-xs font-medium text-muted-foreground'>
                    Account status
                  </span>
                  <Select
                    value={criteria.status ?? 'all'}
                    onValueChange={(value) =>
                      onSearchChange({
                        status:
                          value === 'all' ? undefined : (value as MemberStatus),
                      })
                    }
                  >
                    <SelectTrigger aria-label='Filter by account status'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='all'>All statuses</SelectItem>
                      {memberStatuses.map((status) => (
                        <SelectItem key={status} value={status}>
                          {statusLabels[status]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className='space-y-1.5'>
                  <span className='text-xs font-medium text-muted-foreground'>
                    Organizational unit
                  </span>
                  <OrganizationUnitSelect
                    value={criteria.orgUnitId ?? null}
                    units={organizationUnits}
                    lookupStatus={lookupState(organizationLookup)}
                    label='Filter by organizational unit'
                    emptyLabel='All units'
                    disabled={
                      units.isPending ||
                      units.isError ||
                      organizationUnits.length === 0
                    }
                    onValueChange={(orgUnitId) =>
                      onSearchChange({ orgUnitId: orgUnitId ?? undefined })
                    }
                  />
                </div>
              </div>
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <label className='flex items-center gap-2 text-sm text-muted-foreground'>
                  Rows per page
                  <Select
                    value={String(criteria.size)}
                    onValueChange={(value) =>
                      onSearchChange({ size: Number(value) })
                    }
                  >
                    <SelectTrigger aria-label='Rows per page' className='w-24'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {!pageSizeChoices.includes(criteria.size) && (
                        <SelectItem value={String(criteria.size)}>
                          {criteria.size}
                        </SelectItem>
                      )}
                      {pageSizeChoices.map((size) => (
                        <SelectItem key={size} value={String(size)}>
                          {size}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                {units.isFetching && !units.isPending && (
                  <span role='status' className='text-xs text-muted-foreground'>
                    Refreshing authorized unit names…
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className='space-y-4 p-0'>
              {units.isError && (
                <div
                  role='alert'
                  className='m-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm'
                >
                  <span>
                    Organizational unit names could not be loaded. Member data
                    remains available; unresolved references are shown by ID.
                  </span>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => void units.refetch()}
                  >
                    <RefreshCw className='size-4' />
                    Retry unit lookup
                  </Button>
                </div>
              )}
              {units.data?.length === 0 && !units.isFetching && (
                <p className='px-4 pt-4 text-sm text-muted-foreground'>
                  No authorized active organizational units are available.
                  Existing member references remain visible by ID.
                </p>
              )}
              {memberDirectory.isPending ? (
                <RequestLoading label='Loading authorized members…' />
              ) : memberDirectory.isError ? (
                <div className='p-4'>
                  <RequestError
                    error={memberDirectory.error}
                    retry={() => void memberDirectory.refetch()}
                  />
                </div>
              ) : memberDirectory.data.items.length === 0 ? (
                <div className='p-4'>
                  <RequestEmpty
                    title={
                      criteria.q ||
                      criteria.role ||
                      criteria.status ||
                      criteria.orgUnitId
                        ? 'No members match these filters'
                        : 'No members are available in this directory'
                    }
                    description='Try another search or adjust the authorized filters.'
                  />
                </div>
              ) : (
                <div className='overflow-x-auto'>
                  <Table className='min-w-[920px]'>
                    <TableHeader>
                      <TableRow>
                        <TableHead className='w-[25%]'>Member</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Organizational unit</TableHead>
                        <TableHead>Global role</TableHead>
                        <TableHead>Account status</TableHead>
                        <TableHead className='text-end'>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {memberDirectory.data.items.map((member) => (
                        <TableRow key={member.id}>
                          <TableCell className='whitespace-normal'>
                            <div className='flex min-w-44 items-center gap-3'>
                              <Avatar className='size-9 shrink-0'>
                                <AvatarFallback className='bg-primary/10 text-xs font-medium text-primary'>
                                  {getDisplayNameInitials(member.displayName)}
                                </AvatarFallback>
                              </Avatar>
                              <span className='font-medium'>
                                {member.displayName}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className='whitespace-nowrap'>
                              {member.email}
                            </span>
                          </TableCell>
                          <TableCell>
                            <MemberOrganizationalUnit
                              id={member.primaryOrgUnitId}
                              lookup={organizationLookup}
                            />
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant='outline'
                              className={roleBadgeClass(member.globalRole)}
                            >
                              {roleLabels[member.globalRole]}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant='outline'
                              className={statusBadgeClass(member.accountStatus)}
                            >
                              {statusLabels[member.accountStatus]}
                            </Badge>
                          </TableCell>
                          <TableCell className='text-end'>
                            <div className='flex flex-wrap justify-end gap-1'>
                              <Button
                                variant='ghost'
                                size='sm'
                                aria-label={`Edit ${member.displayName}`}
                                disabled={!identityVerified}
                                onClick={() => editMember(member)}
                              >
                                <Pencil className='size-4' />
                                Edit
                              </Button>
                              {member.accountStatus === 'ACTIVE' &&
                                member.id !== identity.data?.userId && (
                                  <Button
                                    variant='ghost'
                                    size='sm'
                                    disabled={
                                      statusMutation.isPending ||
                                      !identityVerified
                                    }
                                    onClick={() =>
                                      runLifecycle(member, 'deactivate')
                                    }
                                  >
                                    Deactivate
                                  </Button>
                                )}
                              {member.accountStatus === 'INACTIVE' && (
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  disabled={
                                    statusMutation.isPending ||
                                    !identityVerified
                                  }
                                  onClick={() =>
                                    runLifecycle(member, 'reactivate')
                                  }
                                >
                                  Reactivate
                                </Button>
                              )}
                              {member.accountStatus === 'PENDING_SETUP' && (
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  disabled={
                                    statusMutation.isPending ||
                                    !identityVerified
                                  }
                                  onClick={() =>
                                    runLifecycle(
                                      member,
                                      'account-setup/reissue'
                                    )
                                  }
                                >
                                  Resend setup
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {memberDirectory.data && (
                <div className='flex flex-col gap-3 border-t px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between'>
                  <span>
                    {memberDirectory.data.pagination.totalElements}{' '}
                    {memberDirectory.data.pagination.totalElements === 1
                      ? 'member'
                      : 'members'}
                    {memberDirectory.isPlaceholderData && (
                      <span role='status'> · Updating results…</span>
                    )}
                  </span>
                  <div className='flex items-center justify-between gap-3 sm:justify-end'>
                    <span>
                      Page {memberDirectory.data.pagination.page + 1} of{' '}
                      {Math.max(memberDirectory.data.pagination.totalPages, 1)}
                    </span>
                    <div className='flex gap-2'>
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={
                          memberDirectory.isPlaceholderData ||
                          !memberDirectory.data.pagination.hasPrevious
                        }
                        onClick={() =>
                          onSearchChange({
                            page: memberDirectory.data.pagination.page - 1,
                          })
                        }
                      >
                        Previous
                      </Button>
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={
                          memberDirectory.isPlaceholderData ||
                          !memberDirectory.data.pagination.hasNext
                        }
                        onClick={() =>
                          onSearchChange({
                            page: memberDirectory.data.pagination.page + 1,
                          })
                        }
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {identityResolved &&
          access.type === 'authorized' &&
          identity.data &&
          administrationDialog?.contextKey === accessKey && (
            <MemberAdministrationDialog
              key={`${administrationDialog.contextKey}:${administrationDialog.member?.id ?? 'new'}`}
              open
              member={administrationDialog.member}
              identity={identity.data}
              authorizationKey={accessKey}
              authorizationVerified={identityVerified}
              isAuthorizationContextCurrent={(key) =>
                currentAuthorization.current.accessKey === key
              }
              units={units}
              onOpenChange={(open) => {
                if (!open) setAdministrationDialog(null)
              }}
            />
          )}
      </Main>
    </>
  )
}
