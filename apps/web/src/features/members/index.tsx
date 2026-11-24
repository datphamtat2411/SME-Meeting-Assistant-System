import { ShieldAlert, UserRound } from 'lucide-react'
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
  const directory = useMemberDirectoryController({ search, onSearchChange })
  const administration = useMemberAdministrationController({
    access: directory.access,
    accessKey: directory.accessKey,
    identity: directory.identity,
    identityVerified: directory.identityVerified,
  })
  const { verification } = directory
  const authorizationMessage =
    verification.status === 'background-verification'
      ? 'Verifying current administration access. Member changes are paused until verification completes.'
      : 'Current administration access could not be verified. Your draft is preserved; verify access before submitting.'

  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'>
          <div>
            <p className='text-sm font-medium text-primary'>Administration</p>
            <h1 className='mt-1 text-2xl font-bold tracking-tight sm:text-3xl'>
              Members
            </h1>
            <p className='mt-2 max-w-2xl text-muted-foreground'>
              Search organizational accounts and the management scope available
              to your role.
            </p>
          </div>
          {directory.identityResolved &&
            directory.access.type === 'authorized' && (
              <Button
                disabled={!directory.identityVerified}
                onClick={() => administration.openAdministration(null)}
              >
                <UserRound className='size-4' />
                Add member
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
                ? 'Verifying current administration access. Existing form state is preserved; submissions are paused.'
                : 'Current administration access could not be verified. Existing form state is preserved; verify access before submitting.'}
            </span>
            <Button
              size='sm'
              variant='outline'
              onClick={() => void verification.query.refetch()}
            >
              Retry verification
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
            <RequestLoading label='Verifying member-directory access…' />
          )
        ) : directory.access.type === 'unresolved' ? (
          <RequestLoading label='Verifying member-directory scope…' />
        ) : directory.access.type === 'denied' ? (
          <div
            role='alert'
            className='flex items-start gap-3 rounded-lg border p-5 text-muted-foreground'
          >
            <ShieldAlert className='mt-0.5 size-5 shrink-0' />
            <p>
              Member directory access requires an authorized management scope.
            </p>
          </div>
        ) : directory.access.type === 'empty-scope' ? (
          <CardlessEmptyScope />
        ) : !directory.canReadDirectory ? (
          <div
            role='alert'
            className='rounded-lg border border-amber-500/40 bg-amber-500/5 p-5 text-sm text-muted-foreground'
          >
            Member records are hidden until the current authorization can be
            verified. Retry verification to continue.
          </div>
        ) : (
          <MemberDirectoryPresentation
            controller={directory}
            administration={administration}
            onSearchChange={onSearchChange}
            onEdit={administration.openAdministration}
            onLifecycle={administration.runLifecycle}
          />
        )}

        {directory.identityResolved &&
          directory.access.type === 'authorized' &&
          directory.identity &&
          administration.administrationDialog?.contextKey ===
            directory.accessKey && (
            <MemberAdministrationDialog
              key={`${administration.administrationDialog.contextKey}:${administration.administrationDialog.member?.id ?? 'new'}`}
              open
              member={administration.administrationDialog.member}
              identity={directory.identity}
              authorizationKey={administration.authorizationKey}
              authorizationVerified={administration.authorizationVerified}
              authorizationMessage={authorizationMessage}
              isAuthorizationContextCurrent={
                administration.isAuthorizationContextCurrent
              }
              onRetryAuthorization={() => void verification.query.refetch()}
              units={directory.units}
              onOpenChange={(open) => {
                if (!open) administration.closeAdministration()
              }}
            />
          )}
      </Main>
    </>
  )
}

function CardlessEmptyScope() {
  return (
    <div className='overflow-hidden rounded-lg border'>
      <div className='border-b p-6'>
        <h2 className='font-semibold'>Member directory</h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          The directory is limited to organizational units explicitly granted to
          your account.
        </p>
      </div>
      <RequestEmpty
        title='No members in scope'
        description='No organizational units are granted for member management.'
      />
    </div>
  )
}
