import { i18n, useUiTranslation } from '@/lib/i18n'
import { featureValidationMessage, localizedValidationMessage } from '@/lib/i18n/presentation'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
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
import { Textarea } from '@/components/ui/textarea'
import type {
  RoomCreatePayload,
  RoomCreationReconciliation,
  RoomPatchPayload,
  RoomSnapshot,
} from './room-api'
import {
  buildRoomCreatePayload,
  buildRoomPatchPayload,
  NoRoomChangesError,
  roomFormSchema,
  roomFormValuesFromRoom,
  type RoomFormValues,
} from './room-form'
import type {
  RoomConflictChoices,
  RoomEditReconciliation,
  RoomEditableField,
} from './room-reconciliation'

export type RoomEditorSession =
  | {
      operationId: number
      contextKey: string
      mode: 'create'
      status: 'ready'
    }
  | {
      operationId: number
      contextKey: string
      mode: 'edit'
      roomId: string
      status: 'loading' | 'error' | 'ready'
      snapshot?: RoomSnapshot
      initialValues?: RoomFormValues
      loadError?: string
    }

export interface RoomOperationFeedback {
  outcome: 'rejected' | 'precondition' | 'uncertain' | 'unknown'
  message: string
  fieldErrors?: FieldErrors
  creationReconciliation?: RoomCreationReconciliation
  latestSnapshot?: RoomSnapshot
  editReconciliation?: RoomEditReconciliation
  originalSnapshot?: RoomSnapshot
  submittedPatch?: RoomPatchPayload
  submittedCreationPayload?: RoomCreatePayload
  latestMatchesRequest?: boolean
  reconciliationError?: string
  reconciliationLoading?: boolean
}

export type RoomEditorSubmit =
  | {
      operationId: number
      contextKey: string
      mode: 'create'
      payload: RoomCreatePayload
    }
  | {
      operationId: number
      contextKey: string
      mode: 'edit'
      snapshot: RoomSnapshot
      payload: RoomPatchPayload
    }

const blankValues: RoomFormValues = {
  code: '',
  name: '',
  location: '',
  capacity: '',
  notes: '',
}

function roomDisplayValues(room: RoomSnapshot['room']) {
  return [
    [i18n.t('rooms:tableCode'), room.code],
    [i18n.t('rooms:name'), room.name],
    [i18n.t('rooms:location'), room.location ?? i18n.t('rooms:notSet')],
    [i18n.t('rooms:capacity'), room.capacity === null ? i18n.t('rooms:notSet') : String(room.capacity)],
    [i18n.t('rooms:notes'), room.notes ?? i18n.t('rooms:notSet')],
  ] as const
}

function displayRoomFieldValue(value: string | number | null) {
  return value === null ? i18n.t('rooms:notSet') : String(value)
}

function displayRoomFieldLabel(field: RoomEditableField) {
  return i18n.t(`rooms:${field}`)
}

function RoomConflictResolution({
  reconciliation,
  operationId,
  authorizationVerified,
  onResolve,
}: {
  reconciliation: RoomEditReconciliation
  operationId: number
  authorizationVerified: boolean
  onResolve: (operationId: number, choices: RoomConflictChoices) => void
}) {
  const { t } = useUiTranslation()
  const [conflictChoices, setConflictChoices] = useState<RoomConflictChoices>(
    {}
  )
  const unresolvedConflict = reconciliation.conflicts.some(
    (field) => conflictChoices[field] === undefined
  )

  return (
    <div className='space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3'>
      <div>
        <p className='font-medium'>{t('rooms:conflicts')}</p>
        <p className='text-muted-foreground'>
          {t('rooms:conflictHelp')}
        </p>
      </div>
      {reconciliation.conflicts.map((field) => {
        const comparison = reconciliation.fields[field]
        return (
          <fieldset key={field} className='space-y-2 rounded-md border p-3'>
            <legend className='px-1 font-medium'>
              {displayRoomFieldLabel(field)}
            </legend>
            <label className='flex items-start gap-2'>
              <input
                type='radio'
                name={`room-conflict-${field}`}
                checked={conflictChoices[field] === 'server'}
                onChange={() =>
                  setConflictChoices((current) => ({
                    ...current,
                    [field]: 'server',
                  }))
                }
              />
              <span>
                <span className='block text-xs text-muted-foreground'>
                  {t('rooms:serverValue')}
                </span>
                <span className='block break-words'>
                  {displayRoomFieldValue(comparison.latest)}
                </span>
              </span>
            </label>
            <label className='flex items-start gap-2'>
              <input
                type='radio'
                name={`room-conflict-${field}`}
                checked={conflictChoices[field] === 'intent'}
                onChange={() =>
                  setConflictChoices((current) => ({
                    ...current,
                    [field]: 'intent',
                  }))
                }
              />
              <span>
                <span className='block text-xs text-muted-foreground'>
                  {t('rooms:intendedValue')}
                </span>
                <span className='block break-words'>
                  {displayRoomFieldValue(comparison.intended ?? null)}
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
        disabled={!authorizationVerified || unresolvedConflict}
        onClick={() => onResolve(operationId, conflictChoices)}
      >
        {t('rooms:resolveConflicts')}
      </Button>
    </div>
  )
}

export function RoomEditorDialog({
  session,
  saving,
  authorizationVerified,
  authorizationMessage,
  onRetryAuthorization,
  feedback,
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
}: {
  session: RoomEditorSession | null
  saving: boolean
  authorizationVerified: boolean
  authorizationMessage: string
  onRetryAuthorization: () => void
  feedback: RoomOperationFeedback | null
  onClose: () => void
  onRetrySnapshot: (roomId: string, operationId: number) => void
  onLoadLatest: (roomId: string) => Promise<RoomSnapshot>
  onReviewLatest: (snapshot: RoomSnapshot, operationId: number) => void
  onRestartFromLatest: (snapshot: RoomSnapshot, operationId: number) => void
  onReviewDirectory: () => void
  onReviewCreationDraft: (operationId: number) => void
  onResolveEditReconciliation: (
    operationId: number,
    choices: RoomConflictChoices
  ) => void
  onRetryCreationVerification: (operationId: number) => void
  onSubmit: (input: RoomEditorSubmit) => void
}) {
  const { t } = useUiTranslation()
  const [recoverySnapshot, setRecoverySnapshot] = useState<RoomSnapshot | null>(
    null
  )
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [recoveryLoading, setRecoveryLoading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const initialValues =
    session?.mode === 'edit' && session.status === 'ready' && session.snapshot
      ? (session.initialValues ?? roomFormValuesFromRoom(session.snapshot.room))
      : blankValues
  const form = useForm<RoomFormValues>({
    resolver: zodResolver(roomFormSchema),
    defaultValues: initialValues,
    mode: 'onSubmit',
  })

  useEffect(() => {
    if (!feedback?.fieldErrors) return
    const supportedFields = new Set([
      'code',
      'name',
      'location',
      'capacity',
      'notes',
    ])
    for (const [field, messages] of Object.entries(feedback.fieldErrors)) {
      if (!supportedFields.has(field) || messages.length === 0) continue
      form.setError(field as keyof RoomFormValues, {
        type: 'server',
        message: messages[0],
      })
    }
  }, [feedback?.fieldErrors, form])

  async function reloadLatest(roomId: string) {
    setRecoveryLoading(true)
    setRecoveryError(null)
    try {
      const latest = await onLoadLatest(roomId)
      setRecoverySnapshot(latest)
      if (session?.mode === 'edit') {
        onReviewLatest(latest, session.operationId)
      }
    } catch (error) {
      setRecoveryError(
        error instanceof Error
          ? error.message
          : featureValidationMessage('rooms:latestLoadError')
      )
    } finally {
      setRecoveryLoading(false)
    }
  }

  async function submit(values: RoomFormValues) {
    if (!session || session.status !== 'ready') return
    setLocalError(null)
    try {
      if (session.mode === 'create') {
        onSubmit({
          operationId: session.operationId,
          contextKey: session.contextKey,
          mode: 'create',
          payload: buildRoomCreatePayload(values),
        })
        return
      }
      if (!session.snapshot) return
      onSubmit({
        operationId: session.operationId,
        contextKey: session.contextKey,
        mode: 'edit',
        snapshot: session.snapshot,
        payload: buildRoomPatchPayload(session.snapshot.room, values),
      })
    } catch (error) {
      setLocalError(
        error instanceof NoRoomChangesError
          ? featureValidationMessage('rooms:noChanges')
          : error instanceof Error
            ? error.message
            : featureValidationMessage('rooms:invalidRoom')
      )
    }
  }

  const open = session !== null
  const editing = session?.mode === 'edit'
  const sessionRoom =
    session?.mode === 'edit' ? session.snapshot?.room : undefined
  const isRecoveryRequired =
    feedback?.outcome === 'precondition' ||
    feedback?.outcome === 'uncertain' ||
    feedback?.outcome === 'unknown'
  const currentRecoverySnapshot = recoverySnapshot ?? feedback?.latestSnapshot
  const reconciliation = feedback?.editReconciliation
  const conflictFields = reconciliation?.conflicts ?? []

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onClose()
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
              {t('rooms:retryVerification')}
            </Button>
          </div>
        )}
        {session?.mode === 'edit' && session.status === 'loading' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('rooms:loadingCurrent')}</DialogTitle>
              <DialogDescription>
                {t('rooms:loadingEditor')}
              </DialogDescription>
            </DialogHeader>
            <div
              role='status'
              className='py-8 text-center text-sm text-muted-foreground'
            >
              {t('rooms:loadingDetails')}
            </div>
            <DialogFooter>
              <Button variant='outline' disabled={saving} onClick={onClose}>
                {t('rooms:cancel')}
              </Button>
            </DialogFooter>
          </>
        ) : session?.mode === 'edit' && session.status === 'error' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('rooms:detailsError')}</DialogTitle>
              <DialogDescription>
                {t('rooms:noEditSession')}
              </DialogDescription>
            </DialogHeader>
            <div
              role='alert'
              className='rounded-md border border-destructive/30 p-3 text-sm'
            >
              {session.loadError ? localizedValidationMessage(session.loadError, t) : t('rooms:detailRequestFailed')}
            </div>
            <DialogFooter>
              <Button variant='outline' onClick={onClose}>
                {t('rooms:close')}
              </Button>
              <Button
                disabled={!authorizationVerified}
                onClick={() =>
                  onRetrySnapshot(session.roomId, session.operationId)
                }
              >
                {t('rooms:retryDetails')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {editing ? t('rooms:editMetadata') : t('rooms:add')}
              </DialogTitle>
              <DialogDescription>
                {editing
                  ? t('rooms:immutable')
                  : t('rooms:createHelp')}
              </DialogDescription>
            </DialogHeader>
            {isRecoveryRequired && feedback && (
              <div
                role='alert'
                className='space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm'
              >
                <p>{localizedValidationMessage(feedback.message, t)}</p>
                {session?.mode === 'edit' && (
                  <>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      disabled={recoveryLoading || !authorizationVerified}
                      onClick={() => void reloadLatest(session.roomId)}
                    >
                      {recoveryLoading
                        ? t('rooms:loadingLatest')
                        : t('rooms:reloadLatest')}
                    </Button>
                    {(recoveryError || feedback.reconciliationError) && (
                      <div className='space-y-2'>
                        <p role='alert' className='text-destructive'>
                          {localizedValidationMessage(recoveryError ?? feedback.reconciliationError ?? '', t)}
                        </p>
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          disabled={recoveryLoading || !authorizationVerified}
                          onClick={() => void reloadLatest(session.roomId)}
                        >
                          {t('rooms:retryLatest')}
                        </Button>
                      </div>
                    )}
                    {currentRecoverySnapshot && (
                      <div className='space-y-3 rounded-md border bg-background p-3'>
                        <div>
                          <p className='font-medium'>
                            {t('rooms:latestState')}
                            {currentRecoverySnapshot.room.status === 'ACTIVE'
                              ? t('rooms:active')
                              : t('rooms:inactive')}
                          </p>
                          <p className='text-muted-foreground'>
                            {feedback.latestMatchesRequest === true
                              ? t('rooms:matchLatest')
                              : feedback.latestMatchesRequest === false
                                ? t('rooms:differentLatest')
                                : t('rooms:reviewVersion')}
                          </p>
                        </div>
                        <dl className='grid gap-2 sm:grid-cols-2'>
                          {roomDisplayValues(currentRecoverySnapshot.room).map(
                            ([label, value]) => (
                              <div key={label} className='min-w-0'>
                                <dt className='text-xs text-muted-foreground'>
                                  {label}
                                </dt>
                                <dd className='font-medium break-words'>
                                  {value}
                                </dd>
                              </div>
                            )
                          )}
                        </dl>
                        {reconciliation && conflictFields.length > 0 && (
                          <RoomConflictResolution
                            key={reconciliation.latest.etag}
                            reconciliation={reconciliation}
                            operationId={session.operationId}
                            authorizationVerified={authorizationVerified}
                            onResolve={onResolveEditReconciliation}
                          />
                        )}
                        {currentRecoverySnapshot.room.status === 'ACTIVE' ? (
                          <div className='flex flex-wrap gap-2'>
                            {reconciliation && conflictFields.length === 0 && (
                              <Button
                                type='button'
                                variant='secondary'
                                size='sm'
                                disabled={!authorizationVerified}
                                onClick={() =>
                                  onResolveEditReconciliation(
                                    session.operationId,
                                    {}
                                  )
                                }
                              >
                                {t('rooms:keepChanges')}
                              </Button>
                            )}
                            <Button
                              type='button'
                              variant='outline'
                              size='sm'
                              disabled={!authorizationVerified}
                              onClick={() =>
                                onRestartFromLatest(
                                  currentRecoverySnapshot,
                                  session.operationId
                                )
                              }
                            >
                              {t('rooms:discardEdits')}
                            </Button>
                          </div>
                        ) : (
                          <p className='text-destructive'>
                            {t('rooms:inactiveEdit')}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
                {session?.mode === 'create' && (
                  <div className='flex flex-wrap gap-2'>
                    {feedback.reconciliationError && (
                      <Button
                        type='button'
                        variant='secondary'
                        size='sm'
                        disabled={
                          !authorizationVerified ||
                          feedback.reconciliationLoading === true
                        }
                        onClick={() =>
                          onRetryCreationVerification(session.operationId)
                        }
                      >
                        {feedback.reconciliationLoading
                          ? t('rooms:verifyingRoom')
                          : t('rooms:retryVerification')}
                      </Button>
                    )}
                    {feedback.creationReconciliation?.status ===
                      'not-found' && (
                      <Button
                        type='button'
                        variant='secondary'
                        size='sm'
                        onClick={() =>
                          onReviewCreationDraft(session.operationId)
                        }
                      >
                        {t('rooms:reviewDraft')}
                      </Button>
                    )}
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      onClick={onReviewDirectory}
                    >
                      {t('rooms:reviewDirectory')}
                    </Button>
                  </div>
                )}
              </div>
            )}
            {feedback?.creationReconciliation?.status === 'found' && (
              <div
                role='status'
                className='space-y-2 rounded-md border bg-muted/40 p-3 text-sm'
              >
                <p>
                  {t('rooms:codeExists', { code: feedback.creationReconciliation.room.code })}
                  {feedback.creationReconciliation.metadataMatches
                    ? t('rooms:creationMatches')
                    : t('rooms:creationDiffers')}
                </p>
                <dl className='grid gap-2 sm:grid-cols-2'>
                  {roomDisplayValues(feedback.creationReconciliation.room).map(
                    ([label, value]) => (
                      <div key={label} className='min-w-0'>
                        <dt className='text-xs text-muted-foreground'>
                          {label}
                        </dt>
                        <dd className='font-medium break-words'>{value}</dd>
                      </div>
                    )
                  )}
                </dl>
              </div>
            )}
            {sessionRoom && (
              <div className='rounded-md border bg-muted/40 px-3 py-2 text-sm'>
                <span className='text-muted-foreground'>{t('rooms:identity')}</span>
                <span className='font-mono font-medium'>
                  {sessionRoom.code}
                </span>
                <span className='mx-2 text-muted-foreground'>·</span>
                <span className='font-medium'>{sessionRoom.name}</span>
              </div>
            )}
            <Form {...form}>
              <form
                id='room-editor-form'
                onSubmit={form.handleSubmit(submit)}
                className='space-y-4'
              >
                <FormField
                  control={form.control}
                  name='code'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('rooms:code')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          readOnly={editing}
                          maxLength={64}
                          autoComplete='off'
                          disabled={saving || isRecoveryRequired}
                        />
                      </FormControl>
                      <FormDescription>
                        {editing
                          ? t('rooms:codeImmutable')
                          : t('rooms:codeUppercase')}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name='name'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('rooms:name')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          maxLength={160}
                          autoComplete='off'
                          disabled={saving || isRecoveryRequired}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className='grid gap-4 sm:grid-cols-2'>
                  <FormField
                    control={form.control}
                    name='location'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('rooms:location')}</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            maxLength={255}
                            autoComplete='off'
                            disabled={saving || isRecoveryRequired}
                          />
                        </FormControl>
                        <FormDescription>
                          {t('rooms:optionalClear')}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name='capacity'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('rooms:capacity')}</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type='text'
                            inputMode='numeric'
                            autoComplete='off'
                            disabled={saving || isRecoveryRequired}
                          />
                        </FormControl>
                        <FormDescription>
                          {t('rooms:optionalCapacity')}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name='notes'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('rooms:notes')}</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          rows={4}
                          disabled={saving || isRecoveryRequired}
                        />
                      </FormControl>
                      <FormDescription>
                        {t('rooms:notesHelp')}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {(localError ||
                  (session?.status === 'ready' &&
                    feedback?.outcome === 'rejected')) && (
                  <p role='alert' className='text-sm text-destructive'>
                    {localizedValidationMessage(localError ?? feedback?.message ?? '', t)}
                  </p>
                )}
              </form>
            </Form>
            <DialogFooter className='flex-col-reverse gap-2 sm:flex-row'>
              <Button
                type='button'
                variant='outline'
                onClick={onClose}
                disabled={saving}
              >
                {t('rooms:cancel')}
              </Button>
              <Button
                type='submit'
                form='room-editor-form'
                disabled={
                  saving ||
                  !authorizationVerified ||
                  session?.status !== 'ready' ||
                  isRecoveryRequired
                }
              >
                {saving ? t('rooms:saving') : editing ? t('rooms:save') : t('rooms:create')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
