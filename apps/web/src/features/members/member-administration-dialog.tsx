import { useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import type { FieldErrors } from '@/lib/core-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AuthContext } from '@/features/auth/session/current-user'
import { ManagerScopePicker } from './manager-scope-picker'
import type {
  MemberEditorSession,
  MemberEditorSubmit,
  MemberOperationFeedback,
} from './member-administration-controller'
import type { Member } from './member-api'
import { MemberEditorRecoveryPanel } from './member-editor-recovery-panel'
import {
  buildMemberCreatePayload,
  buildMemberPatchPayload,
  memberFormSchema,
  memberFormValuesFromMember,
  NoMemberChangesError,
  type MemberFormValues,
} from './member-form'
import { type MemberConflictChoices } from './member-reconciliation'
import type {
  OrganizationalUnit,
  OrganizationUnitLookup,
} from './organization-api'
import { OrganizationUnitSelect } from './organization-unit-select'

const blankValues: MemberFormValues = {
  email: '',
  displayName: '',
  primaryOrgUnitId: '',
  globalRole: 'EMPLOYEE',
  managerScopeUnitIds: [],
}

function applyServerFieldErrors(
  form: ReturnType<typeof useForm<MemberFormValues>>,
  fieldErrors: FieldErrors | undefined
) {
  if (!fieldErrors) return
  const supported = new Set([
    'email',
    'displayName',
    'primaryOrgUnitId',
    'globalRole',
    'managerScopeUnitIds',
  ])
  for (const [field, messages] of Object.entries(fieldErrors)) {
    if (!supported.has(field) || messages.length === 0) continue
    form.setError(field as keyof MemberFormValues, {
      type: 'server',
      message: messages[0],
    })
  }
}

function memberSummary(member: Member) {
  return (
    <dl className='grid gap-3 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2'>
      <div>
        <dt className='text-muted-foreground'>Name</dt>
        <dd className='font-medium'>{member.displayName}</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>Email</dt>
        <dd className='font-medium break-all'>{member.email}</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>Role</dt>
        <dd className='font-medium'>
          {member.globalRole === 'DEPARTMENT_MANAGER'
            ? 'Department manager'
            : member.globalRole === 'ADMINISTRATOR'
              ? 'Administrator'
              : 'Employee'}
        </dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>Account status</dt>
        <dd className='font-medium'>
          {member.accountStatus === 'PENDING_SETUP'
            ? 'Pending secure setup'
            : member.accountStatus === 'ACTIVE'
              ? 'Active'
              : 'Inactive'}
        </dd>
      </div>
    </dl>
  )
}

interface MemberAdministrationDialogProps {
  session: MemberEditorSession | null
  saving: boolean
  identity: AuthContext
  units: OrganizationalUnit[]
  lookupStatus: OrganizationUnitLookup['status']
  authorizationVerified: boolean
  authorizationMessage: string
  feedback: MemberOperationFeedback | null
  onRetryAuthorization: () => void
  onClose: () => void
  onRetrySnapshot: (memberId: string, operationId: number) => void
  onRetryVerification: (operationId: number) => void
  onDiscardEdit: (operationId: number, reviewedVersion: string) => void
  onReviewDirectory: () => void
  onReviewCreationDraft: (operationId: number) => void
  onReviewExistingAccount: (email: string) => void
  onResolveEditReconciliation: (
    operationId: number,
    reviewedVersion: string,
    choices: MemberConflictChoices
  ) => void
  onSubmit: (input: MemberEditorSubmit) => void
}

export function MemberAdministrationDialog({
  session,
  saving,
  identity,
  units,
  lookupStatus,
  authorizationVerified,
  authorizationMessage,
  feedback,
  onRetryAuthorization,
  onClose,
  onRetrySnapshot,
  onRetryVerification,
  onDiscardEdit,
  onReviewDirectory,
  onReviewCreationDraft,
  onReviewExistingAccount,
  onResolveEditReconciliation,
  onSubmit,
}: MemberAdministrationDialogProps) {
  const [localError, setLocalError] = useState<string | null>(null)
  const editing = session?.mode === 'edit'
  const readySnapshot =
    session?.mode === 'edit' && session.status === 'ready'
      ? session.snapshot
      : undefined
  const editSessionSnapshot =
    session?.mode === 'edit' ? session.snapshot : undefined
  const editInitialValues =
    session?.mode === 'edit' ? session.initialValues : undefined
  const createDraft = session?.mode === 'create' ? session.draft : undefined
  const form = useForm<MemberFormValues>({
    resolver: zodResolver(memberFormSchema),
    defaultValues: blankValues,
    mode: 'onSubmit',
  })

  const initializedSession = useRef<MemberEditorSession | null | undefined>(
    undefined
  )
  useEffect(() => {
    if (session && session.phase !== 'ready') {
      initializedSession.current = undefined
      return
    }
    // React Activity reconnects effects after temporary session verification.
    // Reinitialize only for a new editor session, not an effect reconnect.
    if (initializedSession.current === session) return
    initializedSession.current = session
    const initialValues =
      session?.mode === 'edit' &&
      session.status === 'ready' &&
      editSessionSnapshot
        ? (editInitialValues ??
          memberFormValuesFromMember(editSessionSnapshot.member))
        : session?.mode === 'create' && createDraft
          ? {
              ...blankValues,
              email: createDraft.email,
              displayName: createDraft.displayName,
              primaryOrgUnitId: createDraft.primaryOrgUnitId ?? '',
              globalRole: createDraft.globalRole ?? 'EMPLOYEE',
              managerScopeUnitIds: createDraft.managerScopeUnitIds ?? [],
            }
          : blankValues
    form.reset(initialValues)
  }, [form, session, editSessionSnapshot, editInitialValues, createDraft])

  useEffect(() => {
    const snapshotRole =
      session?.mode === 'edit' && session.status === 'ready'
        ? session.snapshot?.member.globalRole
        : undefined
    if (snapshotRole && !form.getValues('globalRole')) {
      form.setValue('globalRole', snapshotRole)
    }
  }, [form, session])

  useEffect(() => {
    applyServerFieldErrors(form, feedback?.fieldErrors)
  }, [feedback?.fieldErrors, form])

  const reviewRequired =
    session?.phase === 'verification-required' ||
    session?.phase === 'verifying' ||
    session?.phase === 'review' ||
    session?.phase === 'verification-failed' ||
    session?.phase === 'review-found' ||
    session?.phase === 'review-not-found'
  const canEditValues = Boolean(
    session && session.status === 'ready' && !reviewRequired
  )

  async function submit(values: MemberFormValues) {
    if (!session || session.status !== 'ready') return
    setLocalError(null)
    try {
      if (session.mode === 'create') {
        const payload = buildMemberCreatePayload(values, identity)
        onSubmit({
          operationId: session.operationId,
          contextKey: session.contextKey,
          mode: 'create',
          payload,
        })
        return
      }
      if (!session.snapshot) return
      const payload = buildMemberPatchPayload(
        session.snapshot.member,
        values,
        identity
      )
      onSubmit({
        operationId: session.operationId,
        contextKey: session.contextKey,
        mode: 'edit',
        snapshot: session.snapshot,
        payload,
      })
    } catch (error) {
      setLocalError(
        error instanceof NoMemberChangesError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Member values are invalid.'
      )
    }
  }

  const isAdministrator = identity.globalRole === 'ADMINISTRATOR'
  const selectedRole = useWatch({
    control: form.control,
    name: 'globalRole',
  })
  const hasUnitLookup = lookupStatus === 'success'
  const targetMember = readySnapshot?.member
  const effectiveRole =
    selectedRole || targetMember?.globalRole || blankValues.globalRole

  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        {!authorizationVerified && session && (
          <div
            role='alert'
            className='flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm'
          >
            <span>{authorizationMessage}</span>
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={onRetryAuthorization}
            >
              Retry verification
            </Button>
          </div>
        )}
        {session?.mode === 'edit' && session.status === 'loading' ? (
          <>
            <DialogHeader>
              <DialogTitle>Loading current member</DialogTitle>
              <DialogDescription>
                Retrieving the authoritative account state and concurrency token
                before opening the editor.
              </DialogDescription>
            </DialogHeader>
            <div
              role='status'
              className='py-8 text-center text-sm text-muted-foreground'
            >
              Loading member details…
            </div>
            <DialogFooter>
              <Button variant='outline' disabled={saving} onClick={onClose}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : session?.mode === 'edit' && session.status === 'error' ? (
          <>
            <DialogHeader>
              <DialogTitle>Member details could not be loaded</DialogTitle>
              <DialogDescription>
                No edit session was opened because a reviewed authoritative
                snapshot is required.
              </DialogDescription>
            </DialogHeader>
            <p role='alert' className='text-sm text-destructive'>
              {session.loadError ?? 'The member detail request failed.'}
            </p>
            <DialogFooter>
              <Button variant='outline' disabled={saving} onClick={onClose}>
                Close
              </Button>
              <Button
                disabled={!authorizationVerified}
                onClick={() =>
                  onRetrySnapshot(session.memberId, session.operationId)
                }
              >
                Retry member details
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {editing ? 'Edit member' : 'Create account'}
              </DialogTitle>
              <DialogDescription>
                New accounts remain pending secure setup. Administrators never
                set or receive a member password.
              </DialogDescription>
            </DialogHeader>
            {targetMember && memberSummary(targetMember)}
            <MemberEditorRecoveryPanel
              session={session}
              feedback={feedback}
              authorizationVerified={authorizationVerified}
              units={units}
              onRetryVerification={onRetryVerification}
              onDiscardEdit={onDiscardEdit}
              onReviewDirectory={onReviewDirectory}
              onReviewCreationDraft={onReviewCreationDraft}
              onReviewExistingAccount={onReviewExistingAccount}
              onResolveEditReconciliation={onResolveEditReconciliation}
            />
            <Form {...form}>
              <form
                id='member-editor-form'
                onSubmit={form.handleSubmit(submit)}
                className='space-y-4'
              >
                <FormField
                  control={form.control}
                  name='displayName'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          maxLength={200}
                          autoComplete='name'
                          disabled={saving || !canEditValues}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name='email'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type='email'
                          autoComplete='email'
                          readOnly={editing}
                          disabled={saving || !canEditValues}
                        />
                      </FormControl>
                      <FormDescription>
                        Email identity cannot be changed after provisioning.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name='primaryOrgUnitId'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Primary organizational unit</FormLabel>
                      <FormControl>
                        <OrganizationUnitSelect
                          value={field.value || null}
                          units={units}
                          lookupStatus={lookupStatus}
                          label='Primary organizational unit'
                          emptyLabel={
                            identity.globalRole === 'DEPARTMENT_MANAGER'
                              ? 'Select a unit'
                              : 'Unassigned'
                          }
                          allowClear={
                            !editing && identity.globalRole === 'ADMINISTRATOR'
                          }
                          disabled={saving || !canEditValues || !hasUnitLookup}
                          onValueChange={(value) => field.onChange(value ?? '')}
                        />
                      </FormControl>
                      <FormDescription>
                        {identity.globalRole === 'DEPARTMENT_MANAGER'
                          ? 'Select an active unit within your explicit management scope.'
                          : editing
                            ? 'Assignments can move to another active unit; they cannot be cleared here.'
                            : 'Optional for administrator-provisioned accounts.'}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {isAdministrator && (
                  <FormField
                    control={form.control}
                    name='globalRole'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Global role</FormLabel>
                        <Select
                          value={field.value}
                          onValueChange={(value) => {
                            if (!value) return
                            field.onChange(value)
                          }}
                          disabled={saving || !canEditValues}
                        >
                          <FormControl>
                            <SelectTrigger aria-label='Global role'>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value='EMPLOYEE'>Employee</SelectItem>
                            <SelectItem value='DEPARTMENT_MANAGER'>
                              Department manager
                            </SelectItem>
                            <SelectItem value='ADMINISTRATOR'>
                              Administrator
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                {isAdministrator && effectiveRole === 'DEPARTMENT_MANAGER' && (
                  <FormField
                    control={form.control}
                    name='managerScopeUnitIds'
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <ManagerScopePicker
                            units={units}
                            selected={field.value ?? []}
                            lookupStatus={lookupStatus}
                            disabled={
                              saving || !canEditValues || !hasUnitLookup
                            }
                            onChange={field.onChange}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                {(localError ||
                  (feedback?.outcome === 'rejected' && !reviewRequired)) && (
                  <p role='alert' className='text-sm text-destructive'>
                    {localError ?? feedback?.message}
                  </p>
                )}
              </form>
            </Form>
            <DialogFooter className='flex-col-reverse gap-2 sm:flex-row'>
              <Button
                variant='outline'
                type='button'
                onClick={onClose}
                disabled={saving && !reviewRequired}
              >
                Cancel
              </Button>
              <Button
                type='submit'
                form='member-editor-form'
                disabled={saving || !authorizationVerified || !canEditValues}
              >
                {saving ? 'Saving…' : editing ? 'Save member' : 'Save member'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
