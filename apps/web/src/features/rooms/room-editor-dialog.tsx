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

export type RoomEditorSession =
  | {
      operationId: number
      mode: 'create'
      status: 'ready'
    }
  | {
      operationId: number
      mode: 'edit'
      roomId: string
      status: 'loading' | 'error' | 'ready'
      snapshot?: RoomSnapshot
      loadError?: string
    }

export interface RoomOperationFeedback {
  outcome: 'rejected' | 'precondition' | 'uncertain' | 'unknown'
  message: string
  fieldErrors?: FieldErrors
}

export type RoomEditorSubmit =
  | {
      operationId: number
      mode: 'create'
      payload: RoomCreatePayload
    }
  | {
      operationId: number
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
    ['Code', room.code],
    ['Name', room.name],
    ['Location', room.location ?? 'Not set'],
    ['Capacity', room.capacity === null ? 'Not set' : String(room.capacity)],
    ['Notes', room.notes ?? 'Not set'],
  ] as const
}

export function RoomEditorDialog({
  session,
  saving,
  feedback,
  onClose,
  onRetrySnapshot,
  onLoadLatest,
  onRestartFromLatest,
  onReviewDirectory,
  onSubmit,
}: {
  session: RoomEditorSession | null
  saving: boolean
  feedback: RoomOperationFeedback | null
  onClose: () => void
  onRetrySnapshot: (roomId: string, operationId: number) => void
  onLoadLatest: (roomId: string) => Promise<RoomSnapshot>
  onRestartFromLatest: (snapshot: RoomSnapshot, operationId: number) => void
  onReviewDirectory: () => void
  onSubmit: (input: RoomEditorSubmit) => void
}) {
  const [recoverySnapshot, setRecoverySnapshot] = useState<RoomSnapshot | null>(
    null
  )
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [recoveryLoading, setRecoveryLoading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const initialValues =
    session?.mode === 'edit' && session.status === 'ready' && session.snapshot
      ? roomFormValuesFromRoom(session.snapshot.room)
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
      setRecoverySnapshot(await onLoadLatest(roomId))
    } catch (error) {
      setRecoveryError(
        error instanceof Error
          ? error.message
          : 'The latest room state could not be loaded.'
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
          mode: 'create',
          payload: buildRoomCreatePayload(values),
        })
        return
      }
      if (!session.snapshot) return
      onSubmit({
        operationId: session.operationId,
        mode: 'edit',
        snapshot: session.snapshot,
        payload: buildRoomPatchPayload(session.snapshot.room, values),
      })
    } catch (error) {
      setLocalError(
        error instanceof NoRoomChangesError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Room values are invalid.'
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
  const latestCanRestart = recoverySnapshot?.room.status === 'ACTIVE'

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onClose()
      }}
    >
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        {session?.mode === 'edit' && session.status === 'loading' ? (
          <>
            <DialogHeader>
              <DialogTitle>Loading current room</DialogTitle>
              <DialogDescription>
                Retrieving the authoritative room state and concurrency token
                before opening the editor.
              </DialogDescription>
            </DialogHeader>
            <div
              role='status'
              className='py-8 text-center text-sm text-muted-foreground'
            >
              Loading room details…
            </div>
            <DialogFooter>
              <Button variant='outline' onClick={onClose}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : session?.mode === 'edit' && session.status === 'error' ? (
          <>
            <DialogHeader>
              <DialogTitle>Room details could not be loaded</DialogTitle>
              <DialogDescription>
                No edit session was opened because a reviewed authoritative
                snapshot is required.
              </DialogDescription>
            </DialogHeader>
            <div
              role='alert'
              className='rounded-md border border-destructive/30 p-3 text-sm'
            >
              {session.loadError ?? 'The room detail request failed.'}
            </div>
            <DialogFooter>
              <Button variant='outline' onClick={onClose}>
                Close
              </Button>
              <Button
                onClick={() =>
                  onRetrySnapshot(session.roomId, session.operationId)
                }
              >
                Retry room details
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {editing ? 'Edit room metadata' : 'Add room'}
              </DialogTitle>
              <DialogDescription>
                {editing
                  ? 'Room code and lifecycle status are immutable in this metadata edit.'
                  : 'Create a canonical room record. Blank optional values are saved as unset.'}
              </DialogDescription>
            </DialogHeader>
            {isRecoveryRequired && feedback && (
              <div
                role='alert'
                className='space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm'
              >
                <p>{feedback.message}</p>
                {session?.mode === 'edit' && (
                  <>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      disabled={recoveryLoading}
                      onClick={() => void reloadLatest(session.roomId)}
                    >
                      {recoveryLoading
                        ? 'Loading latest room…'
                        : 'Reload latest for review'}
                    </Button>
                    {recoveryError && (
                      <div className='space-y-2'>
                        <p role='alert' className='text-destructive'>
                          {recoveryError}
                        </p>
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          disabled={recoveryLoading}
                          onClick={() => void reloadLatest(session.roomId)}
                        >
                          Retry latest room
                        </Button>
                      </div>
                    )}
                    {recoverySnapshot && (
                      <div className='space-y-3 rounded-md border bg-background p-3'>
                        <div>
                          <p className='font-medium'>
                            Latest authoritative state ·{' '}
                            {recoverySnapshot.room.status === 'ACTIVE'
                              ? 'Active'
                              : 'Inactive'}
                          </p>
                          <p className='text-muted-foreground'>
                            Review this version before starting another edit.
                          </p>
                        </div>
                        <dl className='grid gap-2 sm:grid-cols-2'>
                          {roomDisplayValues(recoverySnapshot.room).map(
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
                        {latestCanRestart ? (
                          <Button
                            type='button'
                            variant='secondary'
                            size='sm'
                            onClick={() =>
                              onRestartFromLatest(
                                recoverySnapshot,
                                session.operationId
                              )
                            }
                          >
                            Discard my edits and restart from latest
                          </Button>
                        ) : (
                          <p className='text-destructive'>
                            This room is inactive and cannot be edited.
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
                {session?.mode === 'create' && (
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={onReviewDirectory}
                  >
                    Close and review directory
                  </Button>
                )}
              </div>
            )}
            {sessionRoom && (
              <div className='rounded-md border bg-muted/40 px-3 py-2 text-sm'>
                <span className='text-muted-foreground'>Room identity: </span>
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
                      <FormLabel>Room code</FormLabel>
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
                          ? 'Room codes cannot be changed after creation.'
                          : 'Codes are normalized to uppercase by the Core API.'}
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
                      <FormLabel>Name</FormLabel>
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
                        <FormLabel>Location</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            maxLength={255}
                            autoComplete='off'
                            disabled={saving || isRecoveryRequired}
                          />
                        </FormControl>
                        <FormDescription>
                          Optional. Leave blank to clear existing metadata.
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
                        <FormLabel>Capacity</FormLabel>
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
                          Optional positive whole number.
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
                      <FormLabel>Notes</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          rows={4}
                          disabled={saving || isRecoveryRequired}
                        />
                      </FormControl>
                      <FormDescription>
                        Optional room notes. No client-side length limit is
                        imposed.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {(localError ||
                  (session?.status === 'ready' &&
                    feedback?.outcome === 'rejected')) && (
                  <p role='alert' className='text-sm text-destructive'>
                    {localError ?? feedback?.message}
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
                Cancel
              </Button>
              <Button
                type='submit'
                form='room-editor-form'
                disabled={
                  saving || session?.status !== 'ready' || isRecoveryRequired
                }
              >
                {saving ? 'Saving…' : editing ? 'Save room' : 'Create room'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
