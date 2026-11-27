import { ShieldAlert, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import { RequestError, RequestLoading } from '@/components/request-state'
import { RoomDeactivationDialog } from './room-deactivation-dialog'
import { useRoomDirectoryController } from './room-directory-controller'
import { RoomDirectoryPresentation } from './room-directory-presentation'
import type { RoomDirectorySearch } from './room-directory-state'
import { RoomEditorDialog } from './room-editor-dialog'
import { useRoomOperationController } from './room-operation-controller'

type SearchChange = (
  patch: Partial<RoomDirectorySearch>,
  options?: { replace?: boolean }
) => void

export function RoomsPage({
  search,
  onSearchChange,
}: {
  search: RoomDirectorySearch
  onSearchChange: SearchChange
}) {
  const directory = useRoomDirectoryController({ search, onSearchChange })
  const operation = useRoomOperationController({
    accessKey: directory.accessKey,
    canManage: directory.canManage,
    identityVerified: directory.identityVerified,
  })
  const { verification } = directory
  const authorizationMessage =
    verification.status === 'background-verification'
      ? 'Verifying current room-management access. Room changes are paused until verification completes.'
      : 'Current room-management access could not be verified. Your draft is preserved; verify access before submitting.'

  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'>
          <div>
            <p className='text-sm font-medium text-primary'>
              Meeting operations
            </p>
            <h1 className='mt-1 text-2xl font-bold tracking-tight sm:text-3xl'>
              Meeting Rooms
            </h1>
            <p className='mt-2 max-w-2xl text-muted-foreground'>
              Browse meeting rooms and manage room details.
            </p>
          </div>
          {directory.canManage && (
            <Button
              disabled={!directory.identityVerified || operation.saving}
              onClick={operation.startCreate}
            >
              <Plus aria-hidden='true' className='size-4' />
              Add room
            </Button>
          )}
        </div>

        {directory.identity && !directory.identityVerified && (
          <div
            role='status'
            className='flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm'
          >
            <span>
              {verification.status === 'background-verification'
                ? 'Verifying current room-management access. Existing form state is preserved; submissions are paused.'
                : 'Current room-management access could not be verified. Existing form state is preserved; verify access before submitting.'}
            </span>
            {!directory.identityVerified && !directory.identityError && (
              <Button
                size='sm'
                variant='outline'
                onClick={() => void verification.query.refetch()}
              >
                Retry verification
              </Button>
            )}
            {verification.query.isError && (
              <Button
                size='sm'
                variant='outline'
                onClick={() => void verification.query.refetch()}
              >
                Retry verification
              </Button>
            )}
          </div>
        )}

        {!directory.identityResolved ? (
          directory.identityError ? (
            <RequestError
              error={directory.identityError}
              retry={() => void verification.query.refetch()}
            />
          ) : (
            <RequestLoading label='Verifying room-directory access…' />
          )
        ) : !directory.canReadDirectory ? (
          <div
            role='alert'
            className='rounded-lg border border-amber-500/40 bg-amber-500/5 p-5 text-sm text-muted-foreground'
          >
            Room records are hidden until the current authorization can be
            verified. Retry verification to continue.
          </div>
        ) : (
          <>
            {!directory.canManage && (
              <p className='flex items-center gap-2 text-sm text-muted-foreground'>
                <ShieldAlert aria-hidden='true' className='size-4 shrink-0' />
                Room changes require administrator permission. Only active rooms
                are included in this catalog for assignment eligibility.
              </p>
            )}
            <RoomDirectoryPresentation
              controller={directory}
              operationsBusy={operation.saving}
              onSearchChange={onSearchChange}
              onEdit={(room) => operation.startEdit(room.id)}
              onDeactivate={(room) => operation.startDeactivation(room.id)}
            />
          </>
        )}

        {directory.identityResolved && directory.canManage && (
          <>
            <RoomEditorDialog
              key={
                operation.editorSession?.contextKey === directory.accessKey
                  ? [
                      operation.editorSession.operationId,
                      operation.editorSession.mode,
                      operation.editorSession.status,
                    ].join(':')
                  : 'editor-closed'
              }
              session={
                operation.editorSession?.contextKey === directory.accessKey
                  ? operation.editorSession
                  : null
              }
              saving={operation.saving}
              authorizationVerified={directory.identityVerified}
              authorizationMessage={authorizationMessage}
              onRetryAuthorization={() => void verification.query.refetch()}
              feedback={operation.editorFeedback}
              onClose={operation.closeEditor}
              onRetrySnapshot={operation.retryEditorSnapshot}
              onLoadLatest={operation.loadLatestRoom}
              onReviewLatest={operation.reviewLatest}
              onRestartFromLatest={operation.restartEditorFromLatest}
              onReviewDirectory={operation.closeEditor}
              onReviewCreationDraft={operation.reviewCreationDraft}
              onResolveEditReconciliation={operation.resolveEditReconciliation}
              onRetryCreationVerification={operation.retryCreationVerification}
              onSubmit={operation.submitEditor}
            />
            <RoomDeactivationDialog
              key={
                operation.deactivationSession?.contextKey ===
                directory.accessKey
                  ? [
                      operation.deactivationSession.operationId,
                      operation.deactivationSession.phase,
                      operation.deactivationSession.snapshot?.etag ?? '',
                    ].join(':')
                  : 'deactivation-closed'
              }
              session={
                operation.deactivationSession?.contextKey ===
                directory.accessKey
                  ? operation.deactivationSession
                  : null
              }
              saving={operation.saving}
              authorizationVerified={directory.identityVerified}
              authorizationMessage={authorizationMessage}
              onRetryAuthorization={() => void verification.query.refetch()}
              feedback={operation.deactivationFeedback}
              onClose={operation.closeDeactivation}
              onRetrySnapshot={operation.retryDeactivationSnapshot}
              onLoadLatest={operation.loadLatestRoom}
              onReviewLatest={operation.reviewLatest}
              onRestartFromLatest={operation.restartDeactivationFromLatest}
              onConfirm={operation.confirmDeactivation}
            />
          </>
        )}
      </Main>
    </>
  )
}
