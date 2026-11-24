import { useState, type FormEvent } from 'react'
import {
  useMutation,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AuthContext } from '@/features/auth/session/current-user'
import { ManagerScopePicker } from './manager-scope-picker'
import {
  memberDetail,
  createMember,
  updateMember,
  type Member,
} from './member-api'
import {
  type OrganizationalUnit,
  type OrganizationUnitLookup,
} from './organization-api'
import { OrganizationUnitSelect } from './organization-unit-select'

type Draft = {
  email: string
  displayName: string
  globalRole: Member['globalRole']
  primaryOrgUnitId: string
  managerScopeUnitIds: string[]
}

const blank: Draft = {
  email: '',
  displayName: '',
  globalRole: 'EMPLOYEE',
  primaryOrgUnitId: '',
  managerScopeUnitIds: [],
}

interface MemberAdministrationDialogProps {
  open: boolean
  member: Member | null
  identity: AuthContext
  units: UseQueryResult<OrganizationalUnit[], Error>
  onOpenChange: (open: boolean) => void
}

function lookupState(
  units: UseQueryResult<OrganizationalUnit[], Error>
): OrganizationUnitLookup['status'] {
  if (units.isPending) return 'loading'
  if (units.isError) return 'error'
  return 'success'
}

export function MemberAdministrationDialog({
  open,
  member,
  identity,
  units,
  onOpenChange,
}: MemberAdministrationDialogProps) {
  const queryClient = useQueryClient()
  const isAdmin = identity.globalRole === 'ADMINISTRATOR'
  const [draft, setDraft] = useState<Draft>(() =>
    member
      ? {
          email: member.email,
          displayName: member.displayName,
          globalRole: member.globalRole,
          primaryOrgUnitId: member.primaryOrgUnitId ?? '',
          managerScopeUnitIds: Array.from(member.managerScopeUnitIds),
        }
      : { ...blank }
  )
  const mutation = useMutation({
    mutationFn: async (data: Draft) => {
      const input = {
        displayName: data.displayName.trim(),
        primaryOrgUnitId: data.primaryOrgUnitId || null,
      }
      const managerScopeUnitIds =
        data.globalRole === 'DEPARTMENT_MANAGER' ? data.managerScopeUnitIds : []
      if (!member) {
        return createMember({
          ...input,
          email: data.email.trim(),
          globalRole: isAdmin ? data.globalRole : 'EMPLOYEE',
          managerScopeUnitIds: isAdmin ? managerScopeUnitIds : [],
        })
      }
      const fresh = await memberDetail(member.id)
      return updateMember(
        member.id,
        {
          ...input,
          ...(isAdmin
            ? { globalRole: data.globalRole, managerScopeUnitIds }
            : {}),
        },
        fresh.etag
      )
    },
    onSuccess: () => {
      toast.success(
        member ? 'Member updated' : 'Account created: setup invitation pending'
      )
      onOpenChange(false)
      void queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (error) => {
      const normalized = normalizeCoreApiError(error)
      toast.error('Unable to save member', {
        description: normalized.message,
      })
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!draft.displayName.trim() || (!member && !draft.email.trim())) return
    mutation.mutate(draft)
  }

  const status = lookupState(units)
  const unitCollection = units.data ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle>{member ? 'Edit member' : 'Create account'}</DialogTitle>
          <DialogDescription>
            New accounts are created pending secure setup. Passwords are never
            set by an administrator.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className='space-y-4'>
          <div className='space-y-1.5'>
            <Label htmlFor='member-name'>Name</Label>
            <Input
              id='member-name'
              maxLength={200}
              required
              value={draft.displayName}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  displayName: event.target.value,
                }))
              }
              disabled={mutation.isPending}
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='member-email'>Email</Label>
            <Input
              id='member-email'
              type='email'
              required
              disabled={Boolean(member) || mutation.isPending}
              value={draft.email}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  email: event.target.value,
                }))
              }
            />
          </div>
          <div className='space-y-1.5'>
            <Label>Primary organizational unit</Label>
            <OrganizationUnitSelect
              value={draft.primaryOrgUnitId || null}
              units={unitCollection}
              lookupStatus={status}
              label='Primary organizational unit'
              emptyLabel='Unassigned'
              disabled={status !== 'success' || mutation.isPending}
              onValueChange={(primaryOrgUnitId) =>
                setDraft((current) => ({
                  ...current,
                  primaryOrgUnitId: primaryOrgUnitId ?? '',
                }))
              }
            />
          </div>
          {units.isError && (
            <div
              role='alert'
              className='flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm'
            >
              <span>
                Organizational-unit lookup failed. Existing resource IDs are
                preserved; names cannot be verified.
              </span>
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={() => void units.refetch()}
              >
                Retry unit lookup
              </Button>
            </div>
          )}
          {isAdmin && (
            <div className='space-y-1.5'>
              <Label>Global role</Label>
              <Select
                value={draft.globalRole}
                disabled={mutation.isPending}
                onValueChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    globalRole: value as Member['globalRole'],
                  }))
                }
              >
                <SelectTrigger aria-label='Global role'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='EMPLOYEE'>Employee</SelectItem>
                  <SelectItem value='DEPARTMENT_MANAGER'>
                    Department manager
                  </SelectItem>
                  <SelectItem value='ADMINISTRATOR'>Administrator</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {isAdmin && draft.globalRole === 'DEPARTMENT_MANAGER' && (
            <ManagerScopePicker
              units={unitCollection}
              selected={draft.managerScopeUnitIds}
              lookupStatus={status}
              onChange={(managerScopeUnitIds) =>
                setDraft((current) => ({ ...current, managerScopeUnitIds }))
              }
            />
          )}
          <DialogFooter className='flex-col-reverse gap-2 sm:flex-row'>
            <Button
              variant='outline'
              type='button'
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button disabled={mutation.isPending} type='submit'>
              {mutation.isPending ? 'Saving…' : 'Save member'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
