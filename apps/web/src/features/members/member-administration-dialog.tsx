import { useEffect, useState } from 'react'
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
import type { Member, MemberSnapshot } from './member-api'
import {
  buildMemberCreatePayload,
  buildMemberPatchPayload,
  memberFormSchema,
  memberFormValuesFromMember,
  NoMemberChangesError,
  type MemberFormValues,
} from './member-form'
import type {
  MemberConflictChoices,
  MemberEditReconciliation,
  MemberEditableField,
} from './member-reconciliation'
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

function fieldLabel(field: MemberEditableField): string {
  if (field === 'displayName') return 'Display name'
  if (field === 'primaryOrgUnitId') return 'Primary organizational unit'
  if (field === 'globalRole') return 'Global role'
  return 'Manager scope'
}

function displayEditableValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(', ') : 'None'
  }
  return value === null || value === '' || value === undefined
    ? 'Not assigned'
    : String(value)
}

function MemberConflictResolution({
  reconciliation,
  operationId,
  authorizationVerified,
  onResolve,
}: {
  reconciliation: MemberEditReconciliation
  operationId: number
  authorizationVerified: boolean
  onResolve: (operationId: number, choices: MemberConflictChoices) => void
}) {
  const [choices, setChoices] = useState<MemberConflictChoices>({})
  const unresolved = reconciliation.conflicts.some(
    (field) => choices[field] === undefined
  )

  return (
    <div className='space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3'>
      <div>
        <p className='font-medium'>Review conflicting fields</p>
        <p className='text-sm text-muted-foreground'>
          Choose the current server value or retain your intended value for each
          conflict. No second update is sent until you continue from the
          reviewed state.
        </p>
      </div>
      {reconciliation.conflicts.map((field) => {
        const comparison = reconciliation.fields[field]
        return (
          <fieldset key={field} className='space-y-2 rounded-md border p-3'>
            <legend className='px-1 text-sm font-medium'>
              {fieldLabel(field)}
            </legend>
            <label className='flex items-start gap-2 text-sm'>
              <input
                type='radio'
                name={`member-conflict-${field}`}
                checked={choices[field] === 'server'}
                onChange={() =>
                  setChoices((current) => ({ ...current, [field]: 'server' }))
                }
              />
              <span>
                <span className='block text-xs text-muted-foreground'>
                  Server value
                </span>
                <span className='block break-words'>
                  {displayEditableValue(comparison.latest)}
                </span>
              </span>
            </label>
            <label className='flex items-start gap-2 text-sm'>
              <input
                type='radio'
                name={`member-conflict-${field}`}
                checked={choices[field] === 'intent'}
                onChange={() =>
                  setChoices((current) => ({ ...current, [field]: 'intent' }))
                }
              />
              <span>
                <span className='block text-xs text-muted-foreground'>
                  Your intended value
                </span>
                <span className='block break-words'>
                  {displayEditableValue(comparison.intended)}
                </span>
              </span>
            </label>
          </fieldset>
        )
      })}
      <Button
        type='button'
        variant='secondary'
        size='sm'
        disabled={!authorizationVerified || unresolved}
        onClick={() => onResolve(operationId, choices)}
      >
        Resolve conflicts and continue
      </Button>
    </div>
  )
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
  onLoadLatest: (memberId: string) => Promise<MemberSnapshot>
  onReviewLatest: (snapshot: MemberSnapshot, operationId: number) => void
  onRestartFromLatest: (snapshot: MemberSnapshot, operationId: number) => void
  onReviewDirectory: () => void
  onReviewCreationDraft: (operationId: number) => void
  onResolveEditReconciliation: (
    operationId: number,
    choices: MemberConflictChoices
  ) => void
  onRetryCreationVerification: (operationId: number) => void
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
  onLoadLatest,
  onReviewLatest,
  onRestartFromLatest,
  onReviewDirectory,
  onReviewCreationDraft,
  onResolveEditReconciliation,
  onRetryCreationVerification,
  onSubmit,
}: MemberAdministrationDialogProps) {
  const [recoverySnapshot, setRecoverySnapshot] =
    useState<MemberSnapshot | null>(null)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [recoveryLoading, setRecoveryLoading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const editing = session?.mode === 'edit'
  const readySnapshot =
    session?.mode === 'edit' && session.status === 'ready'
      ? session.snapshot
      : undefined
  const form = useForm<MemberFormValues>({
    resolver: zodResolver(memberFormSchema),
    defaultValues: blankValues,
    mode: 'onSubmit',
  })

  useEffect(() => {
    const initialValues =
      session?.mode === 'edit' && session.status === 'ready' && session.snapshot
        ? (session.initialValues ??
          memberFormValuesFromMember(session.snapshot.member))
        : blankValues
    form.reset(initialValues)
  }, [form, session])

  useEffect(() => {
    applyServerFieldErrors(form, feedback?.fieldErrors)
  }, [feedback?.fieldErrors, form])

  const reviewRequired =
    feedback?.outcome === 'precondition' ||
    feedback?.outcome === 'uncertain' ||
    feedback?.outcome === 'unknown'
  const reviewedSnapshot = recoverySnapshot ?? feedback?.latestSnapshot
  const canEditValues = Boolean(
    session && session.status === 'ready' && !reviewRequired
  )

  async function reloadLatest(memberId: string) {
    setRecoveryLoading(true)
    setRecoveryError(null)
    try {
      const latest = await onLoadLatest(memberId)
      setRecoverySnapshot(latest)
      if (session?.mode === 'edit') {
        onReviewLatest(latest, session.operationId)
      }
    } catch (error) {
      setRecoveryError(
        error instanceof Error
          ? error.message
          : 'The latest member state could not be loaded.'
      )
    } finally {
      setRecoveryLoading(false)
    }
  }

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
  const reconciliation = feedback?.editReconciliation

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
            {feedback && (
              <div
                role='alert'
                className={`space-y-2 rounded-md border p-3 text-sm ${
                  reviewRequired
                    ? 'border-amber-500/40 bg-amber-500/5'
                    : 'border-destructive/30 bg-destructive/5'
                }`}
              >
                <p>{feedback.message}</p>
                {feedback.reconciliationError && (
                  <p className='text-destructive'>
                    {feedback.reconciliationError}
                  </p>
                )}
                {feedback.reconciliationLoading && (
                  <p role='status' className='text-muted-foreground'>
                    Loading authoritative state for review…
                  </p>
                )}
                {feedback.creationReconciliation?.status === 'found' && (
                  <div className='rounded-md border bg-background p-3'>
                    <p className='font-medium'>
                      Matching authorized account:{' '}
                      {feedback.creationReconciliation.member.displayName}
                    </p>
                    <p className='break-all text-muted-foreground'>
                      {feedback.creationReconciliation.member.email}
                    </p>
                  </div>
                )}
                {feedback.creationReconciliation?.status === 'not-found' && (
                  <p className='text-muted-foreground'>
                    No matching account was visible in the authorized directory.
                  </p>
                )}
              </div>
            )}
            {reviewedSnapshot && editing && (
              <div className='space-y-2 rounded-md border bg-muted/30 p-3 text-sm'>
                <p className='font-medium'>Latest authoritative member state</p>
                {memberSummary(reviewedSnapshot.member)}
                <div className='flex flex-wrap gap-2'>
                  <Button
                    type='button'
                    size='sm'
                    variant='secondary'
                    disabled={!authorizationVerified || !reviewedSnapshot}
                    onClick={() =>
                      session &&
                      onRestartFromLatest(reviewedSnapshot, session.operationId)
                    }
                  >
                    Use latest state and review changes
                  </Button>
                </div>
              </div>
            )}
            {reconciliation && reconciliation.conflicts.length > 0 && (
              <MemberConflictResolution
                reconciliation={reconciliation}
                operationId={session?.operationId ?? 0}
                authorizationVerified={authorizationVerified}
                onResolve={onResolveEditReconciliation}
              />
            )}
            {reviewRequired && session?.mode === 'create' && (
              <div className='flex flex-wrap gap-2'>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  disabled={feedback?.reconciliationLoading}
                  onClick={() =>
                    onRetryCreationVerification(session.operationId)
                  }
                >
                  Recheck authorized directory
                </Button>
                <Button
                  type='button'
                  variant='secondary'
                  size='sm'
                  onClick={() => onReviewCreationDraft(session.operationId)}
                >
                  Review preserved draft
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={onReviewDirectory}
                >
                  Review members
                </Button>
              </div>
            )}
            {reviewRequired && editing && readySnapshot && (
              <div className='flex flex-wrap gap-2'>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  disabled={recoveryLoading || !authorizationVerified}
                  onClick={() => void reloadLatest(readySnapshot.member.id)}
                >
                  {recoveryLoading
                    ? 'Loading latest member…'
                    : 'Reload latest for review'}
                </Button>
                {recoveryError && (
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={recoveryLoading || !authorizationVerified}
                    onClick={() => void reloadLatest(readySnapshot.member.id)}
                  >
                    Retry latest member
                  </Button>
                )}
              </div>
            )}
            {recoveryError && (
              <p role='alert' className='text-sm text-destructive'>
                {recoveryError}
              </p>
            )}
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
                          onValueChange={field.onChange}
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
                {isAdministrator && selectedRole === 'DEPARTMENT_MANAGER' && (
                  <FormField
                    control={form.control}
                    name='managerScopeUnitIds'
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <ManagerScopePicker
                            units={units}
                            selected={field.value}
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
                disabled={saving}
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
