import { Pencil, RefreshCw, Search } from 'lucide-react'
import { getDisplayNameInitials } from '@/lib/utils'
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
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import type {
  MemberAdministrationController,
  MemberLifecycleAction,
} from './member-administration-controller'
import type { Member } from './member-api'
import type { MemberDirectoryController } from './member-directory-controller'
import {
  memberRoles,
  memberStatuses,
  type MemberRole,
  type MemberDirectorySearch,
  type MemberStatus,
} from './member-directory-state'
import {
  resolveOrganizationUnitReference,
  type OrganizationUnitLookup,
} from './organization-api'
import { OrganizationUnitSelect } from './organization-unit-select'

const pageSizeChoices = [10, 20, 50, 100]

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

interface MemberDirectoryPresentationProps {
  controller: MemberDirectoryController
  administration: MemberAdministrationController
  onSearchChange: (
    patch: Partial<MemberDirectorySearch>,
    options?: { replace?: boolean }
  ) => void
  onEdit: (member: Member) => void
  onLifecycle: (member: Member, action: MemberLifecycleAction) => void
}

export function MemberDirectoryPresentation({
  controller,
  administration,
  onSearchChange,
  onEdit,
  onLifecycle,
}: MemberDirectoryPresentationProps) {
  if (controller.access.type !== 'authorized') return null
  const {
    access,
    criteria,
    searchDraft,
    updateSearchDraft,
    units,
    organizationLookup,
    organizationUnits,
    memberDirectory,
    identityVerified,
  } = controller

  return (
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
                    role: value === 'all' ? undefined : (value as MemberRole),
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
                  status: value === 'all' ? undefined : (value as MemberStatus),
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
              onValueChange={(value) => onSearchChange({ size: Number(value) })}
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
              Organizational unit names could not be loaded. Member data remains
              available; unresolved references are shown by ID.
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
            No authorized active organizational units are available. Existing
            member references remain visible by ID.
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
                      <span className='whitespace-nowrap'>{member.email}</span>
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
                          onClick={() => onEdit(member)}
                        >
                          <Pencil className='size-4' />
                          Edit
                        </Button>
                        {member.accountStatus === 'ACTIVE' &&
                          member.id !== controller.identity?.userId && (
                            <Button
                              variant='ghost'
                              size='sm'
                              disabled={
                                administration.statusMutationPending ||
                                !identityVerified
                              }
                              onClick={() => onLifecycle(member, 'deactivate')}
                            >
                              Deactivate
                            </Button>
                          )}
                        {member.accountStatus === 'INACTIVE' && (
                          <Button
                            variant='ghost'
                            size='sm'
                            disabled={
                              administration.statusMutationPending ||
                              !identityVerified
                            }
                            onClick={() => onLifecycle(member, 'reactivate')}
                          >
                            Reactivate
                          </Button>
                        )}
                        {member.accountStatus === 'PENDING_SETUP' &&
                          controller.identity?.globalRole ===
                            'ADMINISTRATOR' && (
                            <Button
                              variant='ghost'
                              size='sm'
                              disabled={
                                administration.statusMutationPending ||
                                !identityVerified
                              }
                              onClick={() =>
                                onLifecycle(member, 'account-setup/reissue')
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
  )
}
