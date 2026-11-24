import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type {
  MemberEditorSession,
  MemberOperationFeedback,
} from './member-administration-controller'
import type { Member } from './member-api'
import {
  resolveMemberEditReconciliation,
  type MemberConflictChoices,
  type MemberEditReconciliation,
  type MemberEditableField,
} from './member-reconciliation'
import type { OrganizationalUnit } from './organization-api'

function fieldLabel(field: MemberEditableField): string {
  if (field === 'displayName') return 'Display name'
  if (field === 'primaryOrgUnitId') return 'Primary organizational unit'
  if (field === 'globalRole') return 'Global role'
  return 'Manager scope'
}

function displayEditableValue(
  value: unknown,
  units: readonly OrganizationalUnit[]
): string {
  if (Array.isArray(value)) {
    return value.length > 0
      ? value
          .map((id) => units.find((unit) => unit.id === id)?.name ?? id)
          .join(', ')
      : 'None'
  }
  return value === null || value === '' || value === undefined
    ? 'Not assigned'
    : String(value)
}

function memberSummary(member: Member) {
  return (
    <dl className='grid gap-3 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2'>
      <div>
        <dt className='text-muted-foreground'>Name</dt>
        <dd className='font-medium'>{member.displayName}</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>Email</dt>
        <dd className='font-medium break-all'>{member.email}</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>Role</dt>
        <dd className='font-medium'>
          {member.globalRole === 'DEPARTMENT_MANAGER'
            ? 'Department manager'
            : member.globalRole === 'ADMINISTRATOR'
              ? 'Administrator'
              : 'Employee'}
        </dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>Account status</dt>
        <dd className='font-medium'>
          {member.accountStatus === 'PENDING_SETUP'
            ? 'Pending secure setup'
            : member.accountStatus === 'ACTIVE'
              ? 'Active'
              : 'Inactive'}
        </dd>
      </div>
    </dl>
  )
}

function MemberConflictResolution({
  reconciliation,
  operationId,
  authorizationVerified,
  units,
  onResolve,
}: {
  reconciliation: MemberEditReconciliation
  operationId: number
  authorizationVerified: boolean
  units: readonly OrganizationalUnit[]
  onResolve: (
    operationId: number,
    reviewedVersion: string,
    choices: MemberConflictChoices
  ) => void
}) {
  const [choices, setChoices] = useState<MemberConflictChoices>({})
  const decision = resolveMemberEditReconciliation(reconciliation, choices)
  const requiredReviews =
    decision.status === 'unresolved' ? decision.requiredReviews : []
  const unresolved =
    decision.status === 'unresolved' &&
    (decision.unresolvedFields.length > 0 ||
      decision.unresolvedReviews.length > 0)
  const latestGrants = reconciliation.latest.member.managerScopeUnitIds
    .map((id) => units.find((unit) => unit.id === id)?.name ?? id)
    .join(', ')
  const intendedGrants = reconciliation.values.managerScopeUnitIds
    .map((id) => units.find((unit) => unit.id === id)?.name ?? id)
    .join(', ')

  return (
    <div className='space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3'>
      <div>
        <p className='font-medium'>Review retained changes</p>
        <p className='text-sm text-muted-foreground'>
          Compare the authoritative state with your original intent. Resolve
          conflicts and dependent role/scope changes before continuing. No
          second update is sent until you continue from this reviewed version.
        </p>
      </div>
      {reconciliation.conflicts.map((field) => {
        const comparison = reconciliation.fields[field]
        return (
          <fieldset key={field} className='space-y-2 rounded-md border p-3'>
            <legend className='px-1 text-sm font-medium'>
              {fieldLabel(field)}
            </legend>
            <label className='flex items-start gap-2 text-sm'>
              <input
                type='radio'
                name={`member-conflict-${field}`}
                checked={choices[field] === 'server'}
                onChange={() =>
                  setChoices((current) => ({ ...current, [field]: 'server' }))
                }
              />
              <span>
                <span className='block text-xs text-muted-foreground'>
                  Server value
                </span>
                <span className='block break-words'>
                  {displayEditableValue(comparison.latest, units)}
                </span>
              </span>
            </label>
            <label className='flex items-start gap-2 text-sm'>
              <input
                type='radio'
                name={`member-conflict-${field}`}
                checked={choices[field] === 'intent'}
                onChange={() =>
                  setChoices((current) => ({ ...current, [field]: 'intent' }))
                }
              />
              <span>
                <span className='block text-xs text-muted-foreground'>
                  Your intended value
                </span>
                <span className='block break-words'>
                  {displayEditableValue(comparison.intended, units)}
                </span>
              </span>
            </label>
          </fieldset>
        )
      })}
      {requiredReviews.includes('manager-scope-removal') && (
        <label className='flex items-start gap-2 rounded-md border border-amber-500/40 p-3 text-sm'>
          <input
            type='checkbox'
            checked={choices.reviewManagerScopeRemoval === true}
            onChange={(event) => {
              const checked = event.currentTarget.checked
              setChoices((current) => ({
                ...current,
                reviewManagerScopeRemoval: checked,
              }))
            }}
          />
          <span>
            <span className='block font-medium'>
              I understand this demotion removes all current manager grants
            </span>
            <span className='block text-muted-foreground'>
              Grants being removed: {latestGrants || 'None'}
            </span>
          </span>
        </label>
      )}
      {requiredReviews.includes('manager-scope-assignment') && (
        <label className='flex items-start gap-2 rounded-md border border-amber-500/40 p-3 text-sm'>
          <input
            type='checkbox'
            checked={choices.reviewManagerScopeAssignment === true}
            onChange={(event) => {
              const checked = event.currentTarget.checked
              setChoices((current) => ({
                ...current,
                reviewManagerScopeAssignment: checked,
              }))
            }}
          />
          <span>
            <span className='block font-medium'>
              I understand this assigns manager access to the selected units
            </span>
            <span className='block text-muted-foreground'>
              Grants being assigned: {intendedGrants || 'None'}
            </span>
          </span>
        </label>
      )}
      <Button
        type='button'
        variant='secondary'
        size='sm'
        disabled={!authorizationVerified || unresolved}
        onClick={() =>
          onResolve(operationId, reconciliation.latest.etag, choices)
        }
      >
        {reconciliation.conflicts.length > 0
          ? 'Resolve conflicts and continue'
          : 'Keep intended changes and continue'}
      </Button>
    </div>
  )
}

export function MemberEditorRecoveryPanel({
  session,
  feedback,
  authorizationVerified,
  units,
  onRetryVerification,
  onDiscardEdit,
  onReviewDirectory,
  onReviewCreationDraft,
  onReviewExistingAccount,
  onResolveEditReconciliation,
}: {
  session: MemberEditorSession | null
  feedback: MemberOperationFeedback | null
  authorizationVerified: boolean
  units: readonly OrganizationalUnit[]
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
}) {
  if (!session) return null
  const reviewRequired =
    session.phase === 'verification-required' ||
    session.phase === 'verifying' ||
    session.phase === 'review' ||
    session.phase === 'verification-failed' ||
    session.phase === 'review-found' ||
    session.phase === 'review-not-found'
  const reviewedSnapshot = feedback?.latestSnapshot
  const reconciliation = feedback?.editReconciliation
  const foundCreation =
    feedback?.creationReconciliation?.status === 'found'
      ? feedback.creationReconciliation
      : undefined

  return (
    <>
      {feedback && (
        <div
          role='alert'
          className={`space-y-2 rounded-md border p-3 text-sm ${
            reviewRequired
              ? 'border-amber-500/40 bg-amber-500/5'
              : 'border-destructive/30 bg-destructive/5'
          }`}
        >
          <p>{feedback.message}</p>
          {feedback.reconciliationError && (
            <p className='text-destructive'>{feedback.reconciliationError}</p>
          )}
          {feedback.reconciliationLoading && (
            <p role='status' className='text-muted-foreground'>
              Loading authoritative state for review…
            </p>
          )}
          {feedback.creationReconciliation?.status === 'found' && (
            <div className='rounded-md border bg-background p-3'>
              <p className='font-medium'>
                Matching authorized account:{' '}
                {feedback.creationReconciliation.member.displayName}
              </p>
              <p className='break-all text-muted-foreground'>
                {feedback.creationReconciliation.member.email}
              </p>
            </div>
          )}
          {feedback.creationReconciliation?.status === 'not-found' && (
            <p className='text-muted-foreground'>
              No matching account was visible in the authorized directory.
            </p>
          )}
        </div>
      )}
      {reviewedSnapshot && session.mode === 'edit' && (
        <div className='space-y-2 rounded-md border bg-muted/30 p-3 text-sm'>
          <p className='font-medium'>Latest authoritative member state</p>
          {memberSummary(reviewedSnapshot.member)}
          <div className='flex flex-wrap gap-2'>
            <Button
              type='button'
              size='sm'
              variant='secondary'
              disabled={!authorizationVerified}
              onClick={() =>
                onDiscardEdit(session.operationId, reviewedSnapshot.etag)
              }
            >
              Discard my edits and restart from latest
            </Button>
          </div>
        </div>
      )}
      {reconciliation &&
        session.mode === 'edit' &&
        (reviewRequired ||
          reconciliation.conflicts.length > 0 ||
          reconciliation.requiredReviews.length > 0) && (
          <MemberConflictResolution
            key={reconciliation.latest.etag}
            reconciliation={reconciliation}
            operationId={session.operationId}
            authorizationVerified={authorizationVerified}
            units={units}
            onResolve={onResolveEditReconciliation}
          />
        )}
      {reviewRequired && session.mode === 'create' && (
        <div className='flex flex-wrap gap-2'>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={feedback?.reconciliationLoading}
            onClick={() => onRetryVerification(session.operationId)}
          >
            Retry verification
          </Button>
          {feedback?.creationReconciliation?.status === 'not-found' && (
            <Button
              type='button'
              variant='secondary'
              size='sm'
              onClick={() => onReviewCreationDraft(session.operationId)}
            >
              Review preserved draft
            </Button>
          )}
          {foundCreation && (
            <Button
              type='button'
              variant='secondary'
              size='sm'
              onClick={() =>
                onReviewExistingAccount(foundCreation.member.email)
              }
            >
              Review existing account
            </Button>
          )}
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={onReviewDirectory}
          >
            Review members
          </Button>
        </div>
      )}
      {reviewRequired && session.mode === 'edit' && (
        <div className='flex flex-wrap gap-2'>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={feedback?.reconciliationLoading || !authorizationVerified}
            onClick={() => onRetryVerification(session.operationId)}
          >
            {feedback?.reconciliationLoading
              ? 'Loading latest member…'
              : 'Reload latest for review'}
          </Button>
        </div>
      )}
    </>
  )
}
