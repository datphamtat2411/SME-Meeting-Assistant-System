import { i18n, useUiTranslation } from '@/lib/i18n'
import { localizedValidationMessage } from '@/lib/i18n/presentation'
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
import type {
  MemberLifecycleAction,
  MemberOperationFeedback,
  MemberLifecycleSession,
} from './member-administration-controller'
import type { MemberSnapshot } from './member-api'

function actionLabel(action: MemberLifecycleAction): string {
  if (action === 'deactivate') return i18n.t('members:deactivateAccount')
  if (action === 'reactivate') return i18n.t('members:reactivateAccount')
  return i18n.t('members:reissueSetup')
}

function actionTitle(action: MemberLifecycleAction): string {
  if (action === 'deactivate') return i18n.t('members:deactivateQuestion')
  if (action === 'reactivate') return i18n.t('members:reactivateQuestion')
  return i18n.t('members:reissueQuestion')
}

function actionDescription(action: MemberLifecycleAction): string {
  if (action === 'deactivate') {
    return i18n.t('members:deactivateHelp')
  }
  if (action === 'reactivate') {
    return i18n.t('members:reactivateHelp')
  }
  return i18n.t('members:reissueHelp')
}

function stateLabel(status: MemberSnapshot['member']['accountStatus']) {
  if (status === 'ACTIVE') return i18n.t('members:active')
  if (status === 'INACTIVE') return i18n.t('members:inactive')
  return i18n.t('members:pendingSetup')
}

export function MemberLifecycleDialog({
  session,
  saving,
  authorizationVerified,
  authorizationMessage,
  feedback,
  canRenewConfirmation,
  onRetryAuthorization,
  onClose,
  onRetrySnapshot,
  onRetryVerification,
  onReviewForConfirmation,
  onConfirm,
}: {
  session: MemberLifecycleSession | null
  saving: boolean
  authorizationVerified: boolean
  authorizationMessage: string
  feedback: MemberOperationFeedback | null
  canRenewConfirmation: boolean
  onRetryAuthorization: () => void
  onClose: () => void
  onRetrySnapshot: (memberId: string, operationId: number) => void
  onRetryVerification: (operationId: number) => void
  onReviewForConfirmation: (
    operationId: number,
    reviewedVersion: string
  ) => void
  onConfirm: (operationId: number) => void
}) {
  const { t } = useUiTranslation()
  const open = session !== null
  const snapshot = session?.snapshot
  const reviewRequired =
    session?.phase === 'verification-required' ||
    session?.phase === 'verifying' ||
    session?.phase === 'review' ||
    session?.phase === 'verification-failed'
  const reviewedSnapshot = feedback?.latestSnapshot

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && (!saving || reviewRequired)) onClose()
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
              {t('members:retryVerification')}
            </Button>
          </div>
        )}
        {session?.phase === 'loading' ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('members:preparingOperation')}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('members:loadingConfirmation')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div role='status' className='py-5 text-sm text-muted-foreground'>
              {t('members:loadingCurrentDetails')}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving && !reviewRequired}>
                {t('members:cancel')}
              </AlertDialogCancel>
            </AlertDialogFooter>
          </>
        ) : session?.status === 'error' ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('members:detailError')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('members:lifecycleUnavailable')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <p role='alert' className='text-sm text-destructive'>
              {session.loadError
                ? localizedValidationMessage(session.loadError, t)
                : t('members:detailFailed')}
            </p>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>
                {t('members:close')}
              </AlertDialogCancel>
              <Button
                disabled={!authorizationVerified}
                onClick={() =>
                  onRetrySnapshot(session.memberId, session.operationId)
                }
              >
                {t('members:retryDetails')}
              </Button>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {actionTitle(session?.action ?? 'deactivate')}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {actionDescription(session?.action ?? 'deactivate')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {snapshot && (
              <dl className='grid gap-3 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2'>
                <div>
                  <dt className='text-muted-foreground'>{t('members:name')}</dt>
                  <dd className='font-medium'>{snapshot.member.displayName}</dd>
                </div>
                <div>
                  <dt className='text-muted-foreground'>
                    {t('members:email')}
                  </dt>
                  <dd className='font-medium break-all'>
                    {snapshot.member.email}
                  </dd>
                </div>
                <div>
                  <dt className='text-muted-foreground'>
                    {t('members:currentLifecycle')}
                  </dt>
                  <dd className='font-medium'>
                    {stateLabel(snapshot.member.accountStatus)}
                  </dd>
                </div>
                <div>
                  <dt className='text-muted-foreground'>
                    {t('members:roleLabel')}
                  </dt>
                  <dd className='font-medium'>
                    {snapshot.member.globalRole === 'DEPARTMENT_MANAGER'
                      ? t('members:departmentManager')
                      : snapshot.member.globalRole === 'ADMINISTRATOR'
                        ? t('members:administrator')
                        : t('members:employee')}
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
                  <p className='text-destructive'>
                    {localizedValidationMessage(
                      feedback.reconciliationError,
                      t
                    )}
                  </p>
                )}
                {feedback.reconciliationLoading && (
                  <p role='status' className='text-muted-foreground'>
                    {t('members:loadingLatestState')}
                  </p>
                )}
                {reviewedSnapshot && (
                  <div className='space-y-2 rounded-md border bg-background p-3'>
                    <p className='font-medium'>
                      {t('members:latestState')}
                      {stateLabel(reviewedSnapshot.member.accountStatus)}
                    </p>
                    <p className='break-all'>
                      {reviewedSnapshot.member.displayName} ·{' '}
                      {reviewedSnapshot.member.email}
                    </p>
                    {session &&
                      canRenewConfirmation &&
                      (session.action === 'deactivate'
                        ? reviewedSnapshot.member.accountStatus === 'ACTIVE'
                        : session.action === 'reactivate'
                          ? reviewedSnapshot.member.accountStatus === 'INACTIVE'
                          : reviewedSnapshot.member.accountStatus ===
                            'PENDING_SETUP') && (
                        <Button
                          type='button'
                          variant='secondary'
                          size='sm'
                          disabled={!authorizationVerified}
                          onClick={() =>
                            onReviewForConfirmation(
                              session.operationId,
                              reviewedSnapshot.etag
                            )
                          }
                        >
                          {t('members:reviewLifecycle')}
                        </Button>
                      )}
                  </div>
                )}
                {reviewRequired && session && (
                  <>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      disabled={
                        feedback?.reconciliationLoading ||
                        !authorizationVerified
                      }
                      onClick={() => onRetryVerification(session.operationId)}
                    >
                      {feedback?.reconciliationLoading
                        ? t('members:loadingLatest')
                        : t('members:reloadLatest')}
                    </Button>
                  </>
                )}
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>
                {t('members:cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={
                  saving ||
                  !authorizationVerified ||
                  !snapshot ||
                  reviewRequired
                }
                onClick={(event) => {
                  event.preventDefault()
                  if (session && !saving && !reviewRequired) {
                    onConfirm(session.operationId)
                  }
                }}
              >
                {saving
                  ? t('members:working')
                  : actionLabel(session?.action ?? 'deactivate')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
