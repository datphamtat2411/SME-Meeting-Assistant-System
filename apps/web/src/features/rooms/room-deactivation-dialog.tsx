import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import type { RoomSnapshot } from './room-api'
import type { RoomOperationFeedback } from './room-editor-dialog'

export interface RoomDeactivationSession {
  operationId: number
  contextKey: string
  roomId: string
  phase: 'loading' | 'error' | 'confirm'
  snapshot?: RoomSnapshot
  loadError?: string
}

export function RoomDeactivationDialog({
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
  onConfirm,
}: {
  session: RoomDeactivationSession | null
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
  onConfirm: (snapshot: RoomSnapshot, operationId: number) => void
}) {
  const [latestSnapshot, setLatestSnapshot] = useState<RoomSnapshot | null>(
    null
  )
  const [latestError, setLatestError] = useState<string | null>(null)
  const [latestLoading, setLatestLoading] = useState(false)

  async function reloadLatest(roomId: string) {
    setLatestLoading(true)
    setLatestError(null)
    try {
      const latest = await onLoadLatest(roomId)
      setLatestSnapshot(latest)
      if (session) onReviewLatest(latest, session.operationId)
    } catch (error) {
      setLatestError(
        error instanceof Error
          ? error.message
          : 'The latest room state could not be loaded.'
      )
    } finally {
      setLatestLoading(false)
    }
  }

  const open = session !== null
  const activeOperationId = session?.operationId
  const snapshot = session?.phase === 'confirm' ? session.snapshot : undefined
  const reviewRequired =
    feedback?.outcome === 'precondition' ||
    feedback?.outcome === 'uncertain' ||
    feedback?.outcome === 'unknown'
  const reviewedSnapshot = latestSnapshot ?? feedback?.latestSnapshot

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onClose()
      }}
    >
      <AlertDialogContent className='max-h-[90vh] overflow-y-auto'>
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
        {session?.phase === 'loading' ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Preparing room deactivation</AlertDialogTitle>
              <AlertDialogDescription>
                Loading the authoritative room state and concurrency token
                before asking for confirmation.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div role='status' className='py-5 text-sm text-muted-foreground'>
              Loading current room details…
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            </AlertDialogFooter>
          </>
        ) : session?.phase === 'error' ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Room details could not be loaded
              </AlertDialogTitle>
              <AlertDialogDescription>
                Deactivation is unavailable until the current room and ETag can
                be verified.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <p role='alert' className='text-sm text-destructive'>
              {session.loadError ?? 'The room detail request failed.'}
            </p>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>Close</AlertDialogCancel>
              <Button
                disabled={!authorizationVerified}
                onClick={() =>
                  onRetrySnapshot(session.roomId, session.operationId)
                }
              >
                Retry room details
              </Button>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Deactivate room?</AlertDialogTitle>
              <AlertDialogDescription>
                Deactivation prevents future room assignments and preserves
                historical meeting references. It does not cancel, reschedule,
                or change existing reservations; the Core API applies the
                authoritative reservation rules.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {snapshot && (
              <dl className='grid gap-3 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2'>
                <div>
                  <dt className='text-muted-foreground'>Room code</dt>
                  <dd className='font-mono font-medium'>
                    {snapshot.room.code}
                  </dd>
                </div>
                <div>
                  <dt className='text-muted-foreground'>Name</dt>
                  <dd className='font-medium'>{snapshot.room.name}</dd>
                </div>
                <div>
                  <dt className='text-muted-foreground'>Current lifecycle</dt>
                  <dd className='font-medium'>
                    {snapshot.room.status === 'ACTIVE' ? 'Active' : 'Inactive'}
                  </dd>
                </div>
                <div>
                  <dt className='text-muted-foreground'>Location</dt>
                  <dd className='font-medium'>
                    {snapshot.room.location ?? 'Not set'}
                  </dd>
                </div>
              </dl>
            )}
            {feedback && (
              <div
                role='alert'
                className={`space-y-3 rounded-md border p-3 text-sm ${
                  reviewRequired
                    ? 'border-amber-500/40 bg-amber-500/5'
                    : 'border-destructive/30 bg-destructive/5'
                }`}
              >
                <p>{feedback.message}</p>
                {feedback.reconciliationError && (
                  <p role='alert' className='text-destructive'>
                    {feedback.reconciliationError}
                  </p>
                )}
                {reviewedSnapshot && (
                  <div className='space-y-2 rounded-md border bg-background p-3'>
                    <p className='font-medium'>
                      Latest server state is{' '}
                      {reviewedSnapshot.room.status === 'ACTIVE'
                        ? 'active'
                        : 'inactive'}
                      .
                    </p>
                    <p>
                      <span className='font-mono'>
                        {reviewedSnapshot.room.code}
                      </span>{' '}
                      · {reviewedSnapshot.room.name}
                    </p>
                    {reviewedSnapshot.room.status === 'ACTIVE' ? (
                      <Button
                        type='button'
                        variant='secondary'
                        size='sm'
                        disabled={!authorizationVerified}
                        onClick={() =>
                          activeOperationId !== undefined &&
                          onRestartFromLatest(
                            reviewedSnapshot,
                            activeOperationId
                          )
                        }
                      >
                        Use latest state and review confirmation
                      </Button>
                    ) : (
                      <p className='text-muted-foreground'>
                        The current state is verified, but the result of the
                        original request cannot be attributed.
                      </p>
                    )}
                  </div>
                )}
                {reviewRequired && snapshot && (
                  <>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      disabled={latestLoading || !authorizationVerified}
                      onClick={() => void reloadLatest(snapshot.room.id)}
                    >
                      {latestLoading
                        ? 'Loading latest room…'
                        : 'Reload latest for review'}
                    </Button>
                    {latestError && (
                      <div className='space-y-2'>
                        <p className='text-destructive'>{latestError}</p>
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          disabled={latestLoading || !authorizationVerified}
                          onClick={() => void reloadLatest(snapshot.room.id)}
                        >
                          Retry latest room
                        </Button>
                      </div>
                    )}
                    {latestSnapshot && (
                      <div className='space-y-2 rounded-md border bg-background p-3'>
                        <p className='font-medium'>
                          Latest authoritative state:{' '}
                          {latestSnapshot.room.status === 'ACTIVE'
                            ? 'Active'
                            : 'Inactive'}
                        </p>
                        <p>
                          <span className='font-mono'>
                            {latestSnapshot.room.code}
                          </span>{' '}
                          · {latestSnapshot.room.name}
                        </p>
                        <p className='text-muted-foreground'>
                          {latestSnapshot.room.location ?? 'Location not set'}
                        </p>
                        {latestSnapshot.room.status === 'ACTIVE' ? (
                          <Button
                            type='button'
                            variant='secondary'
                            size='sm'
                            disabled={!authorizationVerified}
                            onClick={() =>
                              activeOperationId !== undefined &&
                              onRestartFromLatest(
                                latestSnapshot,
                                activeOperationId
                              )
                            }
                          >
                            Use latest state and review confirmation
                          </Button>
                        ) : (
                          <p className='text-muted-foreground'>
                            This room is already inactive; another deactivation
                            is not available.
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={
                  saving ||
                  !authorizationVerified ||
                  !snapshot ||
                  snapshot.room.status !== 'ACTIVE' ||
                  reviewRequired
                }
                onClick={(event) => {
                  event.preventDefault()
                  if (
                    snapshot &&
                    activeOperationId !== undefined &&
                    !saving &&
                    !reviewRequired
                  ) {
                    onConfirm(snapshot, activeOperationId)
                  }
                }}
              >
                {saving ? 'Deactivating…' : 'Deactivate room'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
