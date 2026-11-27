import { useUiTranslation } from '@/lib/i18n'
import { featureValidationMessage, localizedValidationMessage } from '@/lib/i18n/presentation'
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
  const { t } = useUiTranslation()
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
          : featureValidationMessage('rooms:latestLoadError')
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
              {t('rooms:retryVerification')}
            </Button>
          </div>
        )}
        {session?.phase === 'loading' ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('rooms:preparingDeactivate')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('rooms:loadingConfirmation')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div role='status' className='py-5 text-sm text-muted-foreground'>
              {t('rooms:loadingCurrentDetails')}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>{t('rooms:cancel')}</AlertDialogCancel>
            </AlertDialogFooter>
          </>
        ) : session?.phase === 'error' ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('rooms:detailsError')}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('rooms:deactivateUnavailable')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <p role='alert' className='text-sm text-destructive'>
              {session.loadError ? localizedValidationMessage(session.loadError, t) : t('rooms:detailRequestFailed')}
            </p>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>{t('rooms:close')}</AlertDialogCancel>
              <Button
                disabled={!authorizationVerified}
                onClick={() =>
                  onRetrySnapshot(session.roomId, session.operationId)
                }
              >
                {t('rooms:retryDetails')}
              </Button>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('rooms:deactivateQuestion')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('rooms:deactivateHelp')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {snapshot && (
              <dl className='grid gap-3 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2'>
                <div>
                  <dt className='text-muted-foreground'>{t('rooms:code')}</dt>
                  <dd className='font-mono font-medium'>
                    {snapshot.room.code}
                  </dd>
                </div>
                <div>
                  <dt className='text-muted-foreground'>{t('rooms:name')}</dt>
                  <dd className='font-medium'>{snapshot.room.name}</dd>
                </div>
                <div>
                  <dt className='text-muted-foreground'>{t('rooms:currentLifecycle')}</dt>
                  <dd className='font-medium'>
                    {snapshot.room.status === 'ACTIVE' ? t('rooms:active') : t('rooms:inactive')}
                  </dd>
                </div>
                <div>
                  <dt className='text-muted-foreground'>{t('rooms:location')}</dt>
                  <dd className='font-medium'>
                    {snapshot.room.location ?? t('rooms:notSet')}
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
                <p>{localizedValidationMessage(feedback.message, t)}</p>
                {feedback.reconciliationError && (
                  <p role='alert' className='text-destructive'>
                    {localizedValidationMessage(feedback.reconciliationError, t)}
                  </p>
                )}
                {reviewedSnapshot && (
                  <div className='space-y-2 rounded-md border bg-background p-3'>
                    <p className='font-medium'>
                      {t(reviewedSnapshot.room.status === 'ACTIVE' ? 'rooms:latestActive' : 'rooms:latestInactive')}
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
                        {t('rooms:reviewConfirmation')}
                      </Button>
                    ) : (
                      <p className='text-muted-foreground'>
                        {t('rooms:outcomeUnattributed')}
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
                        ? t('rooms:loadingLatest')
                        : t('rooms:reloadLatest')}
                    </Button>
                    {latestError && (
                      <div className='space-y-2'>
                        <p className='text-destructive'>{localizedValidationMessage(latestError, t)}</p>
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          disabled={latestLoading || !authorizationVerified}
                          onClick={() => void reloadLatest(snapshot.room.id)}
                        >
                          {t('rooms:retryLatest')}
                        </Button>
                      </div>
                    )}
                    {latestSnapshot && (
                      <div className='space-y-2 rounded-md border bg-background p-3'>
                        <p className='font-medium'>
                          {t('rooms:latestStateColon')}
                          {latestSnapshot.room.status === 'ACTIVE'
                            ? t('rooms:active')
                            : t('rooms:inactive')}
                        </p>
                        <p>
                          <span className='font-mono'>
                            {latestSnapshot.room.code}
                          </span>{' '}
                          · {latestSnapshot.room.name}
                        </p>
                        <p className='text-muted-foreground'>
                          {latestSnapshot.room.location ?? t('rooms:locationNotSet')}
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
                            {t('rooms:reviewConfirmation')}
                          </Button>
                        ) : (
                          <p className='text-muted-foreground'>
                            {t('rooms:alreadyInactive')}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>{t('rooms:cancel')}</AlertDialogCancel>
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
                {saving ? t('rooms:deactivating') : t('rooms:deactivateRoomButton')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
