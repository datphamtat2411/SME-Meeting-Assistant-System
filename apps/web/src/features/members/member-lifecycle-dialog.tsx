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
  if (action === 'deactivate') return 'Deactivate account'
  if (action === 'reactivate') return 'Reactivate account'
  return 'Reissue setup'
}

function actionTitle(action: MemberLifecycleAction): string {
  if (action === 'deactivate') return 'Deactivate member account?'
  if (action === 'reactivate') return 'Reactivate member account?'
  return 'Reissue secure setup?'
}

function actionDescription(action: MemberLifecycleAction): string {
  if (action === 'deactivate') {
    return 'Deactivation prevents the account from authenticating while preserving historical meetings and account data. It does not delete the member.'
  }
  if (action === 'reactivate') {
    return 'Reactivation is available only after the member has completed secure credential setup. The Core API remains authoritative.'
  }
  return 'A new secure account-setup process will be requested. No password is created or shown in this interface.'
}

function stateLabel(status: MemberSnapshot['member']['accountStatus']) {
  if (status === 'ACTIVE') return 'Active'
  if (status === 'INACTIVE') return 'Inactive'
  return 'Pending setup'
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
              Retry verification
            </Button>
          </div>
        )}
        {session?.phase === 'loading' ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Preparing member operation</AlertDialogTitle>
              <AlertDialogDescription>
                Loading the authoritative account state and concurrency token
                before asking for confirmation.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div role='status' className='py-5 text-sm text-muted-foreground'>
              Loading current member details…
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving && !reviewRequired}>
                Cancel
              </AlertDialogCancel>
            </AlertDialogFooter>
          </>
        ) : session?.status === 'error' ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Member details could not be loaded
              </AlertDialogTitle>
              <AlertDialogDescription>
                This lifecycle operation is unavailable until the current member
                state and ETag can be verified.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <p role='alert' className='text-sm text-destructive'>
              {session.loadError ?? 'The member detail request failed.'}
            </p>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>Close</AlertDialogCancel>
              <Button
                disabled={!authorizationVerified}
                onClick={() =>
                  onRetrySnapshot(session.memberId, session.operationId)
                }
              >
                Retry member details
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
                  <dt className='text-muted-foreground'>Name</dt>
                  <dd className='font-medium'>{snapshot.member.displayName}</dd>
                </div>
                <div>
                  <dt className='text-muted-foreground'>Email</dt>
                  <dd className='font-medium break-all'>
                    {snapshot.member.email}
                  </dd>
                </div>
                <div>
                  <dt className='text-muted-foreground'>Current lifecycle</dt>
                  <dd className='font-medium'>
                    {stateLabel(snapshot.member.accountStatus)}
                  </dd>
                </div>
                <div>
                  <dt className='text-muted-foreground'>Role</dt>
                  <dd className='font-medium'>
                    {snapshot.member.globalRole === 'DEPARTMENT_MANAGER'
                      ? 'Department manager'
                      : snapshot.member.globalRole === 'ADMINISTRATOR'
                        ? 'Administrator'
                        : 'Employee'}
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
                  <p className='text-destructive'>
                    {feedback.reconciliationError}
                  </p>
                )}
                {feedback.reconciliationLoading && (
                  <p role='status' className='text-muted-foreground'>
                    Loading latest authoritative state…
                  </p>
                )}
                {reviewedSnapshot && (
                  <div className='space-y-2 rounded-md border bg-background p-3'>
                    <p className='font-medium'>
                      Latest state:{' '}
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
                          Review and confirm lifecycle operation
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
                        ? 'Loading latest member…'
                        : 'Reload latest for review'}
                    </Button>
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
                  ? 'Working…'
                  : actionLabel(session?.action ?? 'deactivate')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
