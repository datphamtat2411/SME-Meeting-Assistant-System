import { useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import type { FieldErrors } from '@/lib/core-api'
import { i18n, useUiTranslation } from '@/lib/i18n'
import {
  featureValidationMessage,
  localizedValidationMessage,
} from '@/lib/i18n/presentation'
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
import { MemberPolicyError } from './member-administration-policy'
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
        <dt className='text-muted-foreground'>{i18n.t('members:name')}</dt>
        <dd className='font-medium'>{member.displayName}</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>{i18n.t('members:email')}</dt>
        <dd className='font-medium break-all'>{member.email}</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>{i18n.t('members:roleLabel')}</dt>
        <dd className='font-medium'>
          {member.globalRole === 'DEPARTMENT_MANAGER'
            ? i18n.t('members:departmentManager')
            : member.globalRole === 'ADMINISTRATOR'
              ? i18n.t('members:administrator')
              : i18n.t('members:employee')}
        </dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>
          {i18n.t('members:accountStatusLabel')}
        </dt>
        <dd className='font-medium'>
          {member.accountStatus === 'PENDING_SETUP'
            ? i18n.t('members:pendingSecureSetup')
            : member.accountStatus === 'ACTIVE'
              ? i18n.t('members:active')
              : i18n.t('members:inactive')}
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
  const { t } = useUiTranslation()
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
          ? featureValidationMessage('members:noChanges')
          : error instanceof MemberPolicyError && error.messageKey
            ? featureValidationMessage(error.messageKey)
            : error instanceof Error
              ? error.message
              : featureValidationMessage('members:invalidValues')
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
              {t('members:retryVerification')}
            </Button>
          </div>
        )}
        {session?.mode === 'edit' && session.status === 'loading' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('members:loadingCurrent')}</DialogTitle>
              <DialogDescription>
                {t('members:loadingEditor')}
              </DialogDescription>
            </DialogHeader>
            <div
              role='status'
              className='py-8 text-center text-sm text-muted-foreground'
            >
              {t('members:loadingDetails')}
            </div>
            <DialogFooter>
              <Button variant='outline' disabled={saving} onClick={onClose}>
                {t('members:cancel')}
              </Button>
            </DialogFooter>
          </>
        ) : session?.mode === 'edit' && session.status === 'error' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('members:detailError')}</DialogTitle>
              <DialogDescription>
                {t('members:noEditSession')}
              </DialogDescription>
            </DialogHeader>
            <p role='alert' className='text-sm text-destructive'>
              {session.loadError
                ? localizedValidationMessage(session.loadError, t)
                : t('members:detailFailed')}
            </p>
            <DialogFooter>
              <Button variant='outline' disabled={saving} onClick={onClose}>
                {t('members:close')}
              </Button>
              <Button
                disabled={!authorizationVerified}
                onClick={() =>
                  onRetrySnapshot(session.memberId, session.operationId)
                }
              >
                {t('members:retryDetails')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {editing
                  ? t('members:editMemberTitle')
                  : t('members:createAccount')}
              </DialogTitle>
              <DialogDescription>
                {t('members:secureSetupHelp')}
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
                      <FormLabel>{t('members:name')}</FormLabel>
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
                      <FormLabel>{t('members:email')}</FormLabel>
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
                        {t('members:emailImmutable')}
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
                      <FormLabel>{t('members:primaryUnit')}</FormLabel>
                      <FormControl>
                        <OrganizationUnitSelect
                          value={field.value || null}
                          units={units}
                          lookupStatus={lookupStatus}
                          label={t('members:primaryUnit')}
                          emptyLabel={
                            identity.globalRole === 'DEPARTMENT_MANAGER'
                              ? t('members:selectUnit')
                              : t('members:unassigned')
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
                          ? t('members:unitScopeHelp')
                          : editing
                            ? t('members:unitMoveHelp')
                            : t('members:unitOptional')}
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
                        <FormLabel>{t('members:globalRole')}</FormLabel>
                        <Select
                          value={field.value}
                          onValueChange={(value) => {
                            if (!value) return
                            field.onChange(value)
                          }}
                          disabled={saving || !canEditValues}
                        >
                          <FormControl>
                            <SelectTrigger aria-label={t('members:globalRole')}>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value='EMPLOYEE'>
                              {t('members:employee')}
                            </SelectItem>
                            <SelectItem value='DEPARTMENT_MANAGER'>
                              {t('members:departmentManager')}
                            </SelectItem>
                            <SelectItem value='ADMINISTRATOR'>
                              {t('members:administrator')}
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
                    {localizedValidationMessage(
                      localError ?? feedback?.message ?? '',
                      t
                    )}
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
                {t('members:cancel')}
              </Button>
              <Button
                type='submit'
                form='member-editor-form'
                disabled={saving || !authorizationVerified || !canEditValues}
              >
                {saving
                  ? t('members:saving')
                  : editing
                    ? t('members:saveMember')
                    : t('members:saveMember')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
