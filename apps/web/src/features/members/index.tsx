import { ShieldAlert, UserRound } from 'lucide-react'
import { useUiTranslation } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { useMemberAdministrationController } from './member-administration-controller'
import { MemberAdministrationDialog } from './member-administration-dialog'
import { useMemberDirectoryController } from './member-directory-controller'
import { MemberDirectoryPresentation } from './member-directory-presentation'
import type { MemberDirectorySearch } from './member-directory-state'
import { MemberLifecycleDialog } from './member-lifecycle-dialog'

type SearchChange = (
  patch: Partial<MemberDirectorySearch>,
  options?: { replace?: boolean }
) => void

export function MembersPage({
  search,
  onSearchChange,
}: {
  search: MemberDirectorySearch
  onSearchChange: SearchChange
}) {
  const { t } = useUiTranslation()
  const directory = useMemberDirectoryController({ search, onSearchChange })
  const administration = useMemberAdministrationController({
    access: directory.access,
    accessKey: directory.accessKey,
    identity: directory.identity,
    identityVerified: directory.identityVerified,
    authorizedUnits: directory.organizationUnits,
    organizationLookupStatus: directory.organizationLookup.status,
  })
  const { verification } = directory
  const authorizationMessage =
    verification.status === 'background-verification'
      ? t('members:verifyAccess')
      : t('members:verifyFailed')

  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'>
          <div>
            <p className='text-sm font-medium text-primary'>
              {t('members:administration')}
            </p>
            <h1 className='mt-1 text-2xl font-bold tracking-tight sm:text-3xl'>
              {t('members:title')}
            </h1>
            <p className='mt-2 max-w-2xl text-muted-foreground'>
              {t('members:description')}
            </p>
          </div>
          {directory.identityResolved &&
            directory.access.type === 'authorized' && (
              <Button
                disabled={!directory.identityVerified}
                onClick={administration.startCreate}
              >
                <UserRound className='size-4' />
                {t('members:add')}
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
                ? t('members:verifyForm')
                : t('members:verifyFormFailed')}
            </span>
            <Button
              size='sm'
              variant='outline'
              onClick={() => void verification.query.refetch()}
            >
              {t('members:retryVerification')}
            </Button>
          </div>
        )}

        {!directory.identityResolved ? (
          directory.identityError ? (
            <RequestError
              error={directory.identityError}
              retry={() => void verification.query.refetch()}
            />
          ) : (
            <RequestLoading label={t('members:verifyDirectory')} />
          )
        ) : directory.access.type === 'unresolved' ? (
          <RequestLoading label={t('members:verifyScope')} />
        ) : directory.access.type === 'denied' ? (
          <div
            role='alert'
            className='flex items-start gap-3 rounded-lg border p-5 text-muted-foreground'
          >
            <ShieldAlert className='mt-0.5 size-5 shrink-0' />
            <p>{t('members:scopeRequired')}</p>
          </div>
        ) : directory.access.type === 'empty-scope' ? (
          <CardlessEmptyScope />
        ) : !directory.canReadDirectory ? (
          <div
            role='alert'
            className='rounded-lg border border-amber-500/40 bg-amber-500/5 p-5 text-sm text-muted-foreground'
          >
            {t('members:hidden')}
          </div>
        ) : (
          <MemberDirectoryPresentation
            controller={directory}
            administration={administration}
            onSearchChange={onSearchChange}
            onEdit={administration.startEdit}
            onLifecycle={administration.startLifecycle}
          />
        )}

        {directory.identityResolved &&
          directory.access.type === 'authorized' &&
          directory.identity &&
          administration.editorSession?.contextKey === directory.accessKey && (
            <MemberAdministrationDialog
              key={`${administration.editorSession.operationId}`}
              session={administration.editorSession}
              saving={administration.saving}
              identity={directory.identity}
              authorizationVerified={administration.authorizationVerified}
              authorizationMessage={authorizationMessage}
              feedback={administration.editorFeedback}
              onRetryAuthorization={() => void verification.query.refetch()}
              units={directory.organizationUnits}
              lookupStatus={directory.organizationLookup.status}
              onClose={administration.closeEditor}
              onRetrySnapshot={administration.retryEditorSnapshot}
              onRetryVerification={administration.retryEditorVerification}
              onDiscardEdit={administration.discardEdit}
              onReviewDirectory={administration.closeEditor}
              onReviewCreationDraft={administration.reviewCreationDraft}
              onReviewExistingAccount={(email) => {
                administration.closeEditor()
                onSearchChange(
                  { q: email.slice(0, 200), page: undefined },
                  {
                    replace: true,
                  }
                )
              }}
              onResolveEditReconciliation={
                administration.resolveEditReconciliation
              }
              onSubmit={administration.submitEditor}
            />
          )}
        {directory.identityResolved &&
          directory.access.type === 'authorized' &&
          directory.identity &&
          administration.lifecycleSession?.contextKey ===
            directory.accessKey && (
            <MemberLifecycleDialog
              key={`${administration.lifecycleSession.operationId}`}
              session={administration.lifecycleSession}
              saving={administration.saving}
              authorizationVerified={administration.authorizationVerified}
              authorizationMessage={authorizationMessage}
              feedback={administration.lifecycleFeedback}
              canRenewConfirmation={
                administration.canRenewLifecycleConfirmation
              }
              onRetryAuthorization={() => void verification.query.refetch()}
              onClose={administration.closeLifecycle}
              onRetrySnapshot={administration.retryLifecycleSnapshot}
              onRetryVerification={administration.retryLifecycleVerification}
              onReviewForConfirmation={
                administration.reviewLifecycleForConfirmation
              }
              onConfirm={administration.confirmLifecycle}
            />
          )}
      </Main>
    </>
  )
}

function CardlessEmptyScope() {
  const { t } = useUiTranslation()
  return (
    <div className='overflow-hidden rounded-lg border'>
      <div className='border-b p-6'>
        <h2 className='font-semibold'>{t('members:directory')}</h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          {t('members:scopeHelp')}
        </p>
      </div>
      <RequestEmpty
        title={t('members:noScope')}
        description={t('members:noScopeHelp')}
      />
    </div>
  )
}
