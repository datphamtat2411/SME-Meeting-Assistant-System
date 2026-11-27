import { i18n, useUiTranslation } from '@/lib/i18n'
import { localizedValidationMessage } from '@/lib/i18n/presentation'
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
  if (field === 'displayName') return i18n.t('members:displayName')
  if (field === 'primaryOrgUnitId') return i18n.t('members:primaryUnit')
  if (field === 'globalRole') return i18n.t('members:globalRole')
  return i18n.t('members:managerScope')
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
      : i18n.t('members:none')
  }
  return value === null || value === '' || value === undefined
    ? i18n.t('members:notAssigned')
    : String(value)
}

function memberSummary(member: Member) {
  return (
    <dl className='grid gap-3 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2'>
      <div>
        <dt className='text-muted-foreground'>{i18n.t('members:name')}</dt>
        <dd className='font-medium'>{member.displayName}</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>{i18n.t('members:email')}</dt>
        <dd className='font-medium break-all'>{member.email}</dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>{i18n.t('members:roleLabel')}</dt>
        <dd className='font-medium'>
          {member.globalRole === 'DEPARTMENT_MANAGER'
            ? i18n.t('members:departmentManager')
            : member.globalRole === 'ADMINISTRATOR'
              ? i18n.t('members:administrator')
              : i18n.t('members:employee')}
        </dd>
      </div>
      <div>
        <dt className='text-muted-foreground'>{i18n.t('members:accountStatusLabel')}</dt>
        <dd className='font-medium'>
          {member.accountStatus === 'PENDING_SETUP'
            ? i18n.t('members:pendingSecureSetup')
            : member.accountStatus === 'ACTIVE'
              ? i18n.t('members:active')
              : i18n.t('members:inactive')}
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
  const { t } = useUiTranslation()
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
        <p className='font-medium'>{t('members:reviewRetained')}</p>
        <p className='text-sm text-muted-foreground'>
          {t('members:reviewRetainedHelp')}
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
                  {t('members:serverValue')}
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
                  {t('members:intendedValue')}
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
              {t('members:understandDemotion')}
            </span>
            <span className='block text-muted-foreground'>
              {t('members:grantsRemoved', { grants: latestGrants || t('members:none') })}
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
              {t('members:understandScope')}
            </span>
            <span className='block text-muted-foreground'>
              {t('members:grantsAssigned', { grants: intendedGrants || t('members:none') })}
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
          ? t('members:resolveConflicts')
          : t('members:keepChanges')}
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
  const { t } = useUiTranslation()
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
          <p>{localizedValidationMessage(feedback.message, t)}</p>
          {feedback.reconciliationError && (
            <p className='text-destructive'>{localizedValidationMessage(feedback.reconciliationError, t)}</p>
          )}
          {feedback.reconciliationLoading && (
            <p role='status' className='text-muted-foreground'>
              {t('members:loadingReview')}
            </p>
          )}
          {feedback.creationReconciliation?.status === 'found' && (
            <div className='rounded-md border bg-background p-3'>
              <p className='font-medium'>
                {t('members:matchingAccount')}
                {feedback.creationReconciliation.member.displayName}
              </p>
              <p className='break-all text-muted-foreground'>
                {feedback.creationReconciliation.member.email}
              </p>
            </div>
          )}
          {feedback.creationReconciliation?.status === 'not-found' && (
            <p className='text-muted-foreground'>
              {t('members:noMatch')}
            </p>
          )}
        </div>
      )}
      {reviewedSnapshot && session.mode === 'edit' && (
        <div className='space-y-2 rounded-md border bg-muted/30 p-3 text-sm'>
          <p className='font-medium'>{t('members:latestMemberState')}</p>
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
              {t('members:discardEdits')}
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
            {t('members:retryVerification')}
          </Button>
          {feedback?.creationReconciliation?.status === 'not-found' && (
            <Button
              type='button'
              variant='secondary'
              size='sm'
              onClick={() => onReviewCreationDraft(session.operationId)}
            >
              {t('members:reviewDraft')}
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
              {t('members:reviewAccount')}
            </Button>
          )}
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={onReviewDirectory}
          >
            {t('members:reviewMembers')}
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
              ? t('members:loadingLatest')
              : t('members:reloadLatest')}
          </Button>
        </div>
      )}
    </>
  )
}
