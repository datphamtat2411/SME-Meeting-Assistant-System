import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import type { AuthContext } from '@/features/auth/session/current-user'
import type { MemberDirectoryAccess } from './member-access-policy'
import {
  assertMemberCreateAllowed,
  assertMemberPatchAllowed,
  canManageMemberTarget,
  canPerformMemberLifecycle,
  canProvisionMember,
  type MemberLifecycleAction,
} from './member-administration-policy'
import {
  classifyMemberMutationOutcome,
  changeMemberStatus,
  createMember,
  memberDetail,
  memberOperationErrorMessage,
  reconcileMemberCreation,
  updateMember,
  type Member,
  type MemberCreatePayload,
  type MemberPatchPayload,
  type MemberSnapshot,
  type MemberCreationReconciliation,
} from './member-api'
import {
  synchronizeMemberCaches,
  type MemberCacheMutation,
} from './member-cache'
import { type MemberFormValues } from './member-form'
import {
  memberFormValuesFromEditableValues,
  memberPatchMatchesMember,
  reconcileMemberEdit,
  resolveMemberEditReconciliation,
  type MemberConflictChoices,
  type MemberEditReconciliation,
} from './member-reconciliation'
import type { OrganizationalUnit } from './organization-api'

export type { MemberLifecycleAction }

class ObsoleteMemberOperationError extends Error {
  constructor() {
    super(
      'Member-management authorization changed before the operation started.'
    )
    this.name = 'ObsoleteMemberOperationError'
  }
}

export type MemberEditorSession =
  | {
      operationId: number
      contextKey: string
      mode: 'create'
      status: 'ready'
    }
  | {
      operationId: number
      contextKey: string
      mode: 'edit'
      memberId: string
      status: 'loading' | 'error' | 'ready'
      snapshot?: MemberSnapshot
      initialValues?: MemberFormValues
      loadError?: string
    }

export interface MemberOperationFeedback {
  outcome: 'rejected' | 'precondition' | 'uncertain' | 'unknown'
  message: string
  fieldErrors?: Record<string, string[]>
  latestSnapshot?: MemberSnapshot
  originalSnapshot?: MemberSnapshot
  submittedPatch?: MemberPatchPayload
  submittedCreationPayload?: MemberCreatePayload
  creationReconciliation?: MemberCreationReconciliation
  editReconciliation?: MemberEditReconciliation
  latestMatchesRequest?: boolean
  reconciliationError?: string
  reconciliationLoading?: boolean
}

export interface MemberEditorSubmitBase {
  operationId: number
  contextKey: string
}

export type MemberEditorSubmit =
  | (MemberEditorSubmitBase & {
      mode: 'create'
      payload: MemberCreatePayload
    })
  | (MemberEditorSubmitBase & {
      mode: 'edit'
      snapshot: MemberSnapshot
      payload: MemberPatchPayload
    })

export interface MemberLifecycleSession {
  operationId: number
  contextKey: string
  memberId: string
  action: MemberLifecycleAction
  phase: 'loading' | 'error' | 'confirm'
  snapshot?: MemberSnapshot
  loadError?: string
}

type OperationState =
  | { kind: 'idle' }
  | {
      kind: 'editor'
      session: MemberEditorSession
      feedback: MemberOperationFeedback | null
    }
  | {
      kind: 'lifecycle'
      session: MemberLifecycleSession
      feedback: MemberOperationFeedback | null
    }

type Action =
  | { type: 'start-editor'; session: MemberEditorSession }
  | { type: 'start-lifecycle'; session: MemberLifecycleSession }
  | {
      type: 'editor-snapshot-loaded'
      operationId: number
      contextKey: string
      snapshot: MemberSnapshot
    }
  | {
      type: 'editor-snapshot-failed'
      operationId: number
      contextKey: string
      error: string
    }
  | {
      type: 'lifecycle-snapshot-loaded'
      operationId: number
      contextKey: string
      snapshot: MemberSnapshot
    }
  | {
      type: 'lifecycle-snapshot-failed'
      operationId: number
      contextKey: string
      error: string
    }
  | {
      type: 'editor-feedback'
      operationId: number
      contextKey: string
      feedback: MemberOperationFeedback | null
    }
  | {
      type: 'lifecycle-feedback'
      operationId: number
      contextKey: string
      feedback: MemberOperationFeedback | null
    }
  | {
      type: 'replace-editor'
      session: MemberEditorSession
      feedback: MemberOperationFeedback | null
    }
  | {
      type: 'replace-lifecycle'
      session: MemberLifecycleSession
      feedback: MemberOperationFeedback | null
    }
  | { type: 'close' }
  | { type: 'invalidate-context' }

function isCurrent(
  state: OperationState,
  operationId: number,
  contextKey: string
): boolean {
  return (
    state.kind !== 'idle' &&
    state.session.operationId === operationId &&
    state.session.contextKey === contextKey
  )
}

function reducer(state: OperationState, action: Action): OperationState {
  switch (action.type) {
    case 'start-editor':
      return { kind: 'editor', session: action.session, feedback: null }
    case 'start-lifecycle':
      return { kind: 'lifecycle', session: action.session, feedback: null }
    case 'editor-snapshot-loaded':
      if (!isCurrent(state, action.operationId, action.contextKey)) return state
      if (state.kind !== 'editor' || state.session.mode !== 'edit') return state
      return {
        ...state,
        session: {
          ...state.session,
          status: 'ready',
          snapshot: action.snapshot,
        },
      }
    case 'editor-snapshot-failed':
      if (!isCurrent(state, action.operationId, action.contextKey)) return state
      if (state.kind !== 'editor' || state.session.mode !== 'edit') return state
      return {
        ...state,
        session: { ...state.session, status: 'error', loadError: action.error },
      }
    case 'lifecycle-snapshot-loaded':
      if (!isCurrent(state, action.operationId, action.contextKey)) return state
      if (state.kind !== 'lifecycle') return state
      return {
        ...state,
        session: {
          ...state.session,
          phase: 'confirm',
          snapshot: action.snapshot,
        },
      }
    case 'lifecycle-snapshot-failed':
      if (!isCurrent(state, action.operationId, action.contextKey)) return state
      if (state.kind !== 'lifecycle') return state
      return {
        ...state,
        session: { ...state.session, phase: 'error', loadError: action.error },
      }
    case 'editor-feedback':
      if (!isCurrent(state, action.operationId, action.contextKey)) return state
      if (state.kind !== 'editor') return state
      return { ...state, feedback: action.feedback }
    case 'lifecycle-feedback':
      if (!isCurrent(state, action.operationId, action.contextKey)) return state
      if (state.kind !== 'lifecycle') return state
      return { ...state, feedback: action.feedback }
    case 'replace-editor':
      return {
        kind: 'editor',
        session: action.session,
        feedback: action.feedback,
      }
    case 'replace-lifecycle':
      return {
        kind: 'lifecycle',
        session: action.session,
        feedback: action.feedback,
      }
    case 'close':
    case 'invalidate-context':
      return { kind: 'idle' }
  }
}

function statusMutationName(
  action: MemberLifecycleAction
): Extract<
  MemberCacheMutation,
  { type: 'deactivated' | 'reactivated' | 'setup-reissued' }
>['type'] {
  if (action === 'deactivate') return 'deactivated'
  if (action === 'reactivate') return 'reactivated'
  return 'setup-reissued'
}

function lifecycleSuccessMessage(action: MemberLifecycleAction): string {
  if (action === 'deactivate') return 'Account deactivated'
  if (action === 'reactivate') return 'Account reactivated'
  return 'New secure setup process requested'
}

function lifecycleVerifiedStateMessage(
  action: MemberLifecycleAction,
  latest: MemberSnapshot
): string {
  if (action === 'account-setup/reissue') {
    return 'The account remains pending setup. Ordinary account data cannot independently establish whether the reissue request was applied or whether a setup email was delivered.'
  }
  const expected = action === 'deactivate' ? 'INACTIVE' : 'ACTIVE'
  if (latest.member.accountStatus === expected) {
    return `The server currently verifies this account as ${expected === 'ACTIVE' ? 'active' : 'inactive'}. We cannot determine whether this request caused that state; no second request was sent.`
  }
  return `The server currently verifies this account as ${latest.member.accountStatus === 'ACTIVE' ? 'active' : latest.member.accountStatus === 'INACTIVE' ? 'inactive' : 'pending setup'}. The requested lifecycle change was not confirmed; review the account before deciding what to do.`
}

function editReconciliationMessage(reconciliation: MemberEditReconciliation) {
  if (reconciliation.conflicts.length > 0) {
    return 'The latest member state contains field conflicts. Compare the server values with your intended changes and resolve each conflict before continuing.'
  }
  const fields = Object.values(reconciliation.fields)
  const hasIntent = fields.some((field) => field.userChanged)
  const hasServerChanges = fields.some((field) => field.serverChanged)
  const intendedValuesArePresent = fields.every(
    (field) =>
      !field.userChanged ||
      (field.intended !== undefined &&
        (Array.isArray(field.latest) && Array.isArray(field.intended)
          ? field.latest.length === field.intended.length &&
            field.latest.every((id) => field.intended?.includes(id))
          : field.latest === field.intended))
  )
  if (hasIntent && intendedValuesArePresent) {
    return hasServerChanges
      ? 'The latest member state already contains your intended values and also includes independent server changes. No second request was sent; review the current state before continuing.'
      : 'The latest member state already contains your intended values. The request may have succeeded, but the result cannot be attributed and no second request was sent.'
  }
  return hasServerChanges
    ? 'The latest member state includes independent server changes. Your intended changes are preserved for review against this version.'
    : 'Review the latest authoritative member state before deciding what to do.'
}

interface MemberAdministrationControllerOptions {
  access: MemberDirectoryAccess
  accessKey: string
  identity?: AuthContext
  identityVerified: boolean
  authorizedUnits: OrganizationalUnit[]
  organizationLookupStatus: 'loading' | 'error' | 'success'
}

export function useMemberAdministrationController({
  access,
  accessKey,
  identity,
  identityVerified,
  authorizedUnits,
  organizationLookupStatus,
}: MemberAdministrationControllerOptions) {
  const queryClient = useQueryClient()
  const [state, dispatch] = useReducer(reducer, { kind: 'idle' })
  const stateRef = useRef(state)
  const authorizationRef = useRef({
    accessKey,
    identityVerified,
    identity,
  })
  const accessRef = useRef(access)
  const unitsRef = useRef({
    units: authorizedUnits,
    status: organizationLookupStatus,
  })
  const operationSequence = useRef(0)
  const snapshotController = useRef<AbortController | null>(null)
  const reconciliationController = useRef<AbortController | null>(null)
  const mutationInFlight = useRef<number | null>(null)
  const [mutationOperationId, setMutationOperationId] = useState<number | null>(
    null
  )
  const previousAccessKey = useRef(accessKey)

  useLayoutEffect(() => {
    stateRef.current = state
    authorizationRef.current = { accessKey, identityVerified, identity }
    accessRef.current = access
    unitsRef.current = {
      units: authorizedUnits,
      status: organizationLookupStatus,
    }
  }, [
    access,
    accessKey,
    authorizedUnits,
    identity,
    identityVerified,
    organizationLookupStatus,
    state,
  ])

  const isCurrentOperation = useCallback(
    (operationId: number, contextKey: string) =>
      isCurrent(stateRef.current, operationId, contextKey) &&
      authorizationRef.current.accessKey === contextKey,
    []
  )

  const abortReads = useCallback(() => {
    snapshotController.current?.abort()
    snapshotController.current = null
    reconciliationController.current?.abort()
    reconciliationController.current = null
  }, [])

  useEffect(() => {
    if (previousAccessKey.current === accessKey) return
    previousAccessKey.current = accessKey
    abortReads()
    mutationInFlight.current = null
    setMutationOperationId(null)
    dispatch({ type: 'invalidate-context' })
  }, [abortReads, accessKey])

  useEffect(() => abortReads, [abortReads])

  const nextOperationId = useCallback(() => {
    abortReads()
    operationSequence.current += 1
    return operationSequence.current
  }, [abortReads])

  const loadEditorSnapshot = useCallback(
    async (memberId: string, operationId: number, contextKey: string) => {
      const controller = new AbortController()
      snapshotController.current = controller
      try {
        const snapshot = await memberDetail(memberId, controller.signal)
        const currentIdentity = authorizationRef.current.identity
        if (
          !currentIdentity ||
          !canManageMemberTarget(currentIdentity, snapshot.member)
        ) {
          throw new Error(
            'The current account can no longer manage this member.'
          )
        }
        if (!isCurrentOperation(operationId, contextKey)) return
        dispatch({
          type: 'editor-snapshot-loaded',
          operationId,
          contextKey,
          snapshot,
        })
      } catch (error) {
        if (controller.signal.aborted) return
        if (!isCurrentOperation(operationId, contextKey)) return
        dispatch({
          type: 'editor-snapshot-failed',
          operationId,
          contextKey,
          error: normalizeCoreApiError(error).message,
        })
      } finally {
        if (snapshotController.current === controller) {
          snapshotController.current = null
        }
      }
    },
    [isCurrentOperation]
  )

  const loadLifecycleSnapshot = useCallback(
    async (
      memberId: string,
      action: MemberLifecycleAction,
      operationId: number,
      contextKey: string
    ) => {
      const controller = new AbortController()
      snapshotController.current = controller
      try {
        const snapshot = await memberDetail(memberId, controller.signal)
        const currentIdentity = authorizationRef.current.identity
        if (
          !currentIdentity ||
          !canPerformMemberLifecycle(currentIdentity, snapshot.member, action)
        ) {
          throw new Error(
            'This lifecycle operation is no longer eligible for the current account or member state.'
          )
        }
        if (!isCurrentOperation(operationId, contextKey)) return
        dispatch({
          type: 'lifecycle-snapshot-loaded',
          operationId,
          contextKey,
          snapshot,
        })
      } catch (error) {
        if (controller.signal.aborted) return
        if (!isCurrentOperation(operationId, contextKey)) return
        dispatch({
          type: 'lifecycle-snapshot-failed',
          operationId,
          contextKey,
          error: normalizeCoreApiError(error).message,
        })
      } finally {
        if (snapshotController.current === controller) {
          snapshotController.current = null
        }
      }
    },
    [isCurrentOperation]
  )

  const startCreate = useCallback(() => {
    const currentIdentity = authorizationRef.current.identity
    if (
      !currentIdentity ||
      !canProvisionMember(currentIdentity) ||
      !authorizationRef.current.identityVerified ||
      mutationInFlight.current !== null ||
      authorizationRef.current.accessKey !== accessKey
    ) {
      return
    }
    const operationId = nextOperationId()
    dispatch({
      type: 'start-editor',
      session: {
        operationId,
        contextKey: accessKey,
        mode: 'create',
        status: 'ready',
      },
    })
  }, [accessKey, nextOperationId])

  const startEdit = useCallback(
    (member: Pick<Member, 'id' | 'globalRole' | 'primaryOrgUnitId'>) => {
      const currentIdentity = authorizationRef.current.identity
      if (
        !currentIdentity ||
        !canManageMemberTarget(currentIdentity, member as Member) ||
        !authorizationRef.current.identityVerified ||
        mutationInFlight.current !== null ||
        authorizationRef.current.accessKey !== accessKey
      ) {
        return
      }
      const operationId = nextOperationId()
      dispatch({
        type: 'start-editor',
        session: {
          operationId,
          contextKey: accessKey,
          mode: 'edit',
          memberId: member.id,
          status: 'loading',
        },
      })
      void loadEditorSnapshot(member.id, operationId, accessKey)
    },
    [accessKey, loadEditorSnapshot, nextOperationId]
  )

  const startLifecycle = useCallback(
    (member: Member, action: MemberLifecycleAction) => {
      const currentIdentity = authorizationRef.current.identity
      if (
        !currentIdentity ||
        !canPerformMemberLifecycle(currentIdentity, member, action) ||
        !authorizationRef.current.identityVerified ||
        mutationInFlight.current !== null ||
        authorizationRef.current.accessKey !== accessKey
      ) {
        return
      }
      const operationId = nextOperationId()
      dispatch({
        type: 'start-lifecycle',
        session: {
          operationId,
          contextKey: accessKey,
          memberId: member.id,
          action,
          phase: 'loading',
        },
      })
      void loadLifecycleSnapshot(member.id, action, operationId, accessKey)
    },
    [accessKey, loadLifecycleSnapshot, nextOperationId]
  )

  const verifyCreation = useCallback(
    async (
      operationId: number,
      contextKey: string,
      payload: MemberCreatePayload,
      baseFeedback: MemberOperationFeedback
    ) => {
      if (!isCurrentOperation(operationId, contextKey)) return
      const currentAccess = accessRef.current
      if (currentAccess.type !== 'authorized') return
      reconciliationController.current?.abort()
      const controller = new AbortController()
      reconciliationController.current = controller
      dispatch({
        type: 'editor-feedback',
        operationId,
        contextKey,
        feedback: {
          ...baseFeedback,
          submittedCreationPayload: payload,
          reconciliationLoading: true,
          creationReconciliation: undefined,
          reconciliationError: undefined,
        },
      })
      try {
        const result = await reconcileMemberCreation(
          payload,
          currentAccess,
          controller.signal
        )
        if (!isCurrentOperation(operationId, contextKey)) return
        const message =
          result.status === 'found'
            ? result.metadataMatches
              ? 'A visible account has the submitted normalized email and matching metadata. The request may have succeeded, but no second request was sent.'
              : 'A visible account has the submitted normalized email but different metadata. Review that account before deciding what to do.'
            : result.visibilityLimited
              ? 'No matching account is visible in your current management scope. This does not establish that the email is globally unused or that the original request failed.'
              : 'No matching account was found in the authoritative directory. The original request was not confirmed; review the preserved draft before explicitly deciding whether to retry.'
        dispatch({
          type: 'editor-feedback',
          operationId,
          contextKey,
          feedback: {
            ...baseFeedback,
            message,
            creationReconciliation: result,
            submittedCreationPayload: payload,
            reconciliationLoading: false,
            reconciliationError: undefined,
          },
        })
      } catch (error) {
        if (controller.signal.aborted) return
        if (!isCurrentOperation(operationId, contextKey)) return
        dispatch({
          type: 'editor-feedback',
          operationId,
          contextKey,
          feedback: {
            ...baseFeedback,
            submittedCreationPayload: payload,
            reconciliationLoading: false,
            reconciliationError: normalizeCoreApiError(error).message,
          },
        })
      } finally {
        if (reconciliationController.current === controller) {
          reconciliationController.current = null
        }
      }
    },
    [isCurrentOperation]
  )

  const verifyEdit = useCallback(
    async (
      operationId: number,
      contextKey: string,
      original: MemberSnapshot,
      payload: MemberPatchPayload,
      baseFeedback: MemberOperationFeedback,
      latestOverride?: MemberSnapshot
    ) => {
      if (!isCurrentOperation(operationId, contextKey)) return
      reconciliationController.current?.abort()
      const controller = new AbortController()
      reconciliationController.current = controller
      dispatch({
        type: 'editor-feedback',
        operationId,
        contextKey,
        feedback: {
          ...baseFeedback,
          originalSnapshot: original,
          submittedPatch: payload,
          reconciliationLoading: latestOverride === undefined,
        },
      })
      try {
        const latest =
          latestOverride ??
          (await memberDetail(original.member.id, controller.signal))
        if (!isCurrentOperation(operationId, contextKey)) return
        const reconciliation = reconcileMemberEdit(original, payload, latest)
        dispatch({
          type: 'editor-feedback',
          operationId,
          contextKey,
          feedback: {
            ...baseFeedback,
            message: editReconciliationMessage(reconciliation),
            latestSnapshot: latest,
            originalSnapshot: original,
            submittedPatch: payload,
            editReconciliation: reconciliation,
            latestMatchesRequest: memberPatchMatchesMember(
              latest.member,
              payload
            ),
            reconciliationLoading: false,
            reconciliationError: undefined,
          },
        })
      } catch (error) {
        if (controller.signal.aborted) return
        if (!isCurrentOperation(operationId, contextKey)) return
        dispatch({
          type: 'editor-feedback',
          operationId,
          contextKey,
          feedback: {
            ...baseFeedback,
            originalSnapshot: original,
            submittedPatch: payload,
            reconciliationLoading: false,
            reconciliationError: normalizeCoreApiError(error).message,
          },
        })
      } finally {
        if (reconciliationController.current === controller) {
          reconciliationController.current = null
        }
      }
    },
    [isCurrentOperation]
  )

  const editorMutation = useMutation({
    mutationFn: async (input: MemberEditorSubmit) => {
      if (
        authorizationRef.current.accessKey !== input.contextKey ||
        !authorizationRef.current.identityVerified
      ) {
        throw new ObsoleteMemberOperationError()
      }
      const currentIdentity = authorizationRef.current.identity
      if (!currentIdentity) throw new ObsoleteMemberOperationError()
      const units =
        unitsRef.current.status === 'success'
          ? unitsRef.current.units
          : undefined
      if (input.mode === 'create') {
        assertMemberCreateAllowed(currentIdentity, input.payload, units)
        return {
          mutation: { type: 'created' as const },
          snapshot: await createMember(input.payload),
        }
      }
      assertMemberPatchAllowed(
        currentIdentity,
        input.snapshot.member,
        input.payload,
        units
      )
      return {
        mutation: {
          type: 'updated' as const,
          targetMemberId: input.snapshot.member.id,
          changedFields: Object.keys(input.payload) as Array<
            | 'displayName'
            | 'globalRole'
            | 'primaryOrgUnitId'
            | 'managerScopeUnitIds'
          >,
        },
        snapshot: await updateMember(
          input.snapshot.member.id,
          input.payload,
          input.snapshot.etag
        ),
      }
    },
    onSuccess: async (result, input) => {
      await synchronizeMemberCaches(queryClient, {
        ...result.mutation,
        actor: authorizationRef.current.identity
          ? { userId: authorizationRef.current.identity.userId }
          : undefined,
        outcome: 'confirmed',
      })
      if (!isCurrentOperation(input.operationId, input.contextKey)) return
      toast.success(
        result.mutation.type === 'created'
          ? 'Account provisioned; secure setup is still required'
          : 'Member updated'
      )
      dispatch({ type: 'close' })
    },
    onError: async (error, input) => {
      if (error instanceof ObsoleteMemberOperationError) return
      const outcome = classifyMemberMutationOutcome(error)
      const normalized = normalizeCoreApiError(error)
      const baseFeedback: MemberOperationFeedback = {
        outcome,
        message: memberOperationErrorMessage(
          error,
          input.mode === 'create' ? 'create' : 'edit'
        ),
        fieldErrors: normalized.fieldErrors,
        ...(input.mode === 'create'
          ? { submittedCreationPayload: input.payload }
          : {
              originalSnapshot: input.snapshot,
              submittedPatch: input.payload,
            }),
      }

      if (
        outcome === 'uncertain' ||
        outcome === 'unknown' ||
        outcome === 'precondition'
      ) {
        if (input.mode === 'create') {
          await synchronizeMemberCaches(queryClient, {
            type: 'created',
            actor: authorizationRef.current.identity
              ? { userId: authorizationRef.current.identity.userId }
              : undefined,
            outcome: 'uncertain',
          })
          if (isCurrentOperation(input.operationId, input.contextKey)) {
            await verifyCreation(
              input.operationId,
              input.contextKey,
              input.payload,
              baseFeedback
            )
          }
        } else {
          await synchronizeMemberCaches(queryClient, {
            type: 'updated',
            targetMemberId: input.snapshot.member.id,
            changedFields: Object.keys(input.payload) as Array<
              | 'displayName'
              | 'globalRole'
              | 'primaryOrgUnitId'
              | 'managerScopeUnitIds'
            >,
            actor: authorizationRef.current.identity
              ? { userId: authorizationRef.current.identity.userId }
              : undefined,
            outcome: 'uncertain',
          })
          if (isCurrentOperation(input.operationId, input.contextKey)) {
            await verifyEdit(
              input.operationId,
              input.contextKey,
              input.snapshot,
              input.payload,
              baseFeedback
            )
          }
        }
        return
      }

      if (isCurrentOperation(input.operationId, input.contextKey)) {
        dispatch({
          type: 'editor-feedback',
          operationId: input.operationId,
          contextKey: input.contextKey,
          feedback: baseFeedback,
        })
      }
    },
    onSettled: (_result, _error, input) => {
      if (mutationInFlight.current === input.operationId) {
        mutationInFlight.current = null
      }
      setMutationOperationId((current) =>
        current === input.operationId ? null : current
      )
    },
  })

  const verifyLifecycle = useCallback(
    async (
      operationId: number,
      contextKey: string,
      input: {
        action: MemberLifecycleAction
        snapshot: MemberSnapshot
      },
      baseFeedback: MemberOperationFeedback
    ) => {
      if (!isCurrentOperation(operationId, contextKey)) return
      reconciliationController.current?.abort()
      const controller = new AbortController()
      reconciliationController.current = controller
      dispatch({
        type: 'lifecycle-feedback',
        operationId,
        contextKey,
        feedback: { ...baseFeedback, reconciliationLoading: true },
      })
      try {
        const latest = await memberDetail(
          input.snapshot.member.id,
          controller.signal
        )
        if (!isCurrentOperation(operationId, contextKey)) return
        dispatch({
          type: 'lifecycle-feedback',
          operationId,
          contextKey,
          feedback: {
            ...baseFeedback,
            message: lifecycleVerifiedStateMessage(input.action, latest),
            latestSnapshot: latest,
            reconciliationLoading: false,
            reconciliationError: undefined,
          },
        })
      } catch (error) {
        if (controller.signal.aborted) return
        if (!isCurrentOperation(operationId, contextKey)) return
        dispatch({
          type: 'lifecycle-feedback',
          operationId,
          contextKey,
          feedback: {
            ...baseFeedback,
            reconciliationLoading: false,
            reconciliationError: normalizeCoreApiError(error).message,
          },
        })
      } finally {
        if (reconciliationController.current === controller) {
          reconciliationController.current = null
        }
      }
    },
    [isCurrentOperation]
  )

  const lifecycleMutation = useMutation({
    mutationFn: async ({
      snapshot,
      action,
      contextKey,
    }: {
      snapshot: MemberSnapshot
      action: MemberLifecycleAction
      operationId: number
      contextKey: string
    }) => {
      if (
        authorizationRef.current.accessKey !== contextKey ||
        !authorizationRef.current.identityVerified
      ) {
        throw new ObsoleteMemberOperationError()
      }
      const currentIdentity = authorizationRef.current.identity
      if (
        !currentIdentity ||
        !canPerformMemberLifecycle(currentIdentity, snapshot.member, action)
      ) {
        throw new ObsoleteMemberOperationError()
      }
      return {
        mutation: statusMutationName(action),
        targetMemberId: snapshot.member.id,
        snapshot: await changeMemberStatus(
          snapshot.member.id,
          action,
          snapshot.etag
        ),
      }
    },
    onSuccess: async (result, input) => {
      await synchronizeMemberCaches(queryClient, {
        type: result.mutation,
        targetMemberId: result.targetMemberId,
        actor: authorizationRef.current.identity
          ? { userId: authorizationRef.current.identity.userId }
          : undefined,
        outcome: 'confirmed',
      })
      if (!isCurrentOperation(input.operationId, input.contextKey)) return
      toast.success(lifecycleSuccessMessage(input.action))
      dispatch({ type: 'close' })
    },
    onError: async (error, input) => {
      if (error instanceof ObsoleteMemberOperationError) return
      const outcome = classifyMemberMutationOutcome(error)
      const normalized = normalizeCoreApiError(error)
      const baseFeedback: MemberOperationFeedback = {
        outcome,
        message: memberOperationErrorMessage(error, input.action),
        fieldErrors: normalized.fieldErrors,
      }
      if (
        outcome === 'uncertain' ||
        outcome === 'unknown' ||
        outcome === 'precondition'
      ) {
        await synchronizeMemberCaches(queryClient, {
          type: statusMutationName(input.action),
          targetMemberId: input.snapshot.member.id,
          actor: authorizationRef.current.identity
            ? { userId: authorizationRef.current.identity.userId }
            : undefined,
          outcome: 'uncertain',
        })
        if (isCurrentOperation(input.operationId, input.contextKey)) {
          await verifyLifecycle(
            input.operationId,
            input.contextKey,
            { action: input.action, snapshot: input.snapshot },
            baseFeedback
          )
        }
        return
      }
      if (isCurrentOperation(input.operationId, input.contextKey)) {
        dispatch({
          type: 'lifecycle-feedback',
          operationId: input.operationId,
          contextKey: input.contextKey,
          feedback: baseFeedback,
        })
      }
    },
    onSettled: (_result, _error, input) => {
      if (mutationInFlight.current === input.operationId) {
        mutationInFlight.current = null
      }
      setMutationOperationId((current) =>
        current === input.operationId ? null : current
      )
    },
  })
  const { mutate: mutateEditor } = editorMutation
  const { mutate: mutateLifecycle } = lifecycleMutation

  const submitEditor = useCallback(
    (input: MemberEditorSubmit) => {
      if (
        !isCurrentOperation(input.operationId, input.contextKey) ||
        !authorizationRef.current.identityVerified ||
        mutationInFlight.current !== null
      ) {
        return
      }
      mutationInFlight.current = input.operationId
      setMutationOperationId(input.operationId)
      dispatch({
        type: 'editor-feedback',
        operationId: input.operationId,
        contextKey: input.contextKey,
        feedback: null,
      })
      mutateEditor(input)
    },
    [isCurrentOperation, mutateEditor]
  )

  const confirmLifecycle = useCallback(
    (snapshot: MemberSnapshot, operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'lifecycle' ||
        current.session.operationId !== operationId ||
        current.session.contextKey !== accessKey ||
        current.session.phase !== 'confirm' ||
        !authorizationRef.current.identityVerified ||
        mutationInFlight.current !== null
      ) {
        return
      }
      mutationInFlight.current = operationId
      setMutationOperationId(operationId)
      dispatch({
        type: 'lifecycle-feedback',
        operationId,
        contextKey: accessKey,
        feedback: null,
      })
      mutateLifecycle({
        snapshot,
        action: current.session.action,
        operationId,
        contextKey: accessKey,
      })
    },
    [accessKey, mutateLifecycle]
  )

  const loadLatestMember = useCallback(
    async (memberId: string) => {
      const current = stateRef.current
      if (
        current.kind === 'idle' ||
        current.session.contextKey !== accessKey ||
        !authorizationRef.current.identityVerified
      ) {
        throw new Error('Verify member-management access before loading data.')
      }
      const controller = new AbortController()
      reconciliationController.current?.abort()
      reconciliationController.current = controller
      try {
        return await memberDetail(memberId, controller.signal)
      } finally {
        if (reconciliationController.current === controller) {
          reconciliationController.current = null
        }
      }
    },
    [accessKey]
  )

  const reviewLatestEditor = useCallback(
    (snapshot: MemberSnapshot, operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'editor' ||
        current.session.operationId !== operationId ||
        current.session.mode !== 'edit' ||
        !current.feedback?.submittedPatch ||
        !current.feedback.originalSnapshot
      ) {
        return
      }
      void verifyEdit(
        operationId,
        current.session.contextKey,
        current.feedback.originalSnapshot,
        current.feedback.submittedPatch,
        current.feedback,
        snapshot
      )
    },
    [verifyEdit]
  )

  const reviewLatestLifecycle = useCallback(
    (snapshot: MemberSnapshot, operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'lifecycle' ||
        current.session.operationId !== operationId ||
        !current.feedback
      ) {
        return
      }
      dispatch({
        type: 'lifecycle-feedback',
        operationId,
        contextKey: current.session.contextKey,
        feedback: {
          ...current.feedback,
          latestSnapshot: snapshot,
          reconciliationLoading: false,
          reconciliationError: undefined,
        },
      })
    },
    []
  )

  const restartEditorFromLatest = useCallback(
    (snapshot: MemberSnapshot, operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'editor' ||
        current.session.operationId !== operationId ||
        current.session.mode !== 'edit' ||
        !authorizationRef.current.identityVerified
      ) {
        return
      }
      const nextId = nextOperationId()
      dispatch({
        type: 'replace-editor',
        session: {
          operationId: nextId,
          contextKey: current.session.contextKey,
          mode: 'edit',
          memberId: snapshot.member.id,
          status: 'ready',
          snapshot,
        },
        feedback: null,
      })
    },
    [nextOperationId]
  )

  const resolveEditReconciliation = useCallback(
    (operationId: number, choices: MemberConflictChoices) => {
      const current = stateRef.current
      if (
        current.kind !== 'editor' ||
        current.session.operationId !== operationId ||
        current.session.mode !== 'edit' ||
        !current.feedback?.editReconciliation ||
        !authorizationRef.current.identityVerified
      ) {
        return
      }
      const reconciliation = current.feedback.editReconciliation
      const resolved = resolveMemberEditReconciliation(reconciliation, choices)
      if (resolved.status === 'unresolved') return
      if (resolved.status === 'invalid') {
        dispatch({
          type: 'editor-feedback',
          operationId,
          contextKey: current.session.contextKey,
          feedback: {
            ...current.feedback,
            reconciliationError: resolved.message,
          },
        })
        return
      }
      const nextId = nextOperationId()
      dispatch({
        type: 'replace-editor',
        session: {
          operationId: nextId,
          contextKey: current.session.contextKey,
          mode: 'edit',
          memberId: reconciliation.latest.member.id,
          status: 'ready',
          snapshot: reconciliation.latest,
          initialValues: memberFormValuesFromEditableValues(
            reconciliation.latest.member,
            resolved.values
          ),
        },
        feedback: null,
      })
      if (Object.keys(resolved.patch).length === 0) {
        toast.success('Member is already up to date', {
          description:
            'The reviewed server state already contains the retained changes. No additional update was sent.',
        })
      }
    },
    [nextOperationId]
  )

  const restartLifecycleFromLatest = useCallback(
    (snapshot: MemberSnapshot, operationId: number) => {
      const current = stateRef.current
      const actor = authorizationRef.current.identity
      if (
        current.kind !== 'lifecycle' ||
        current.session.operationId !== operationId ||
        !actor ||
        !authorizationRef.current.identityVerified ||
        !canPerformMemberLifecycle(
          actor,
          snapshot.member,
          current.session.action
        )
      ) {
        return
      }
      const nextId = nextOperationId()
      dispatch({
        type: 'replace-lifecycle',
        session: {
          operationId: nextId,
          contextKey: current.session.contextKey,
          memberId: snapshot.member.id,
          action: current.session.action,
          phase: 'confirm',
          snapshot,
        },
        feedback: null,
      })
    },
    [nextOperationId]
  )

  const retryEditorSnapshot = useCallback(
    (memberId: string, operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'editor' ||
        current.session.operationId !== operationId ||
        current.session.mode !== 'edit' ||
        current.session.contextKey !== accessKey ||
        !authorizationRef.current.identityVerified
      ) {
        return
      }
      dispatch({
        type: 'replace-editor',
        session: {
          ...current.session,
          memberId,
          status: 'loading',
          snapshot: undefined,
          loadError: undefined,
        },
        feedback: null,
      })
      void loadEditorSnapshot(memberId, operationId, accessKey)
    },
    [accessKey, loadEditorSnapshot]
  )

  const retryLifecycleSnapshot = useCallback(
    (memberId: string, operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'lifecycle' ||
        current.session.operationId !== operationId ||
        current.session.contextKey !== accessKey ||
        !authorizationRef.current.identityVerified
      ) {
        return
      }
      dispatch({
        type: 'replace-lifecycle',
        session: {
          ...current.session,
          memberId,
          phase: 'loading',
          snapshot: undefined,
          loadError: undefined,
        },
        feedback: null,
      })
      void loadLifecycleSnapshot(
        memberId,
        current.session.action,
        operationId,
        accessKey
      )
    },
    [accessKey, loadLifecycleSnapshot]
  )

  const reviewCreationDraft = useCallback((operationId: number) => {
    const current = stateRef.current
    if (
      current.kind !== 'editor' ||
      current.session.operationId !== operationId ||
      current.session.mode !== 'create' ||
      current.feedback?.creationReconciliation?.status !== 'not-found' ||
      current.feedback.reconciliationLoading ||
      !authorizationRef.current.identityVerified
    ) {
      return
    }
    dispatch({
      type: 'editor-feedback',
      operationId,
      contextKey: current.session.contextKey,
      feedback: null,
    })
  }, [])

  const retryCreationVerification = useCallback(
    (operationId: number) => {
      const current = stateRef.current
      const payload =
        current.kind === 'editor'
          ? current.feedback?.submittedCreationPayload
          : undefined
      if (
        current.kind !== 'editor' ||
        current.session.operationId !== operationId ||
        current.session.mode !== 'create' ||
        !payload ||
        !authorizationRef.current.identityVerified
      ) {
        return
      }
      void verifyCreation(
        operationId,
        current.session.contextKey,
        payload,
        current.feedback ?? {
          outcome: 'unknown',
          message:
            'The provisioning outcome could not be confirmed. Review the authorized directory before deciding what to do.',
        }
      )
    },
    [verifyCreation]
  )

  const close = useCallback(() => {
    abortReads()
    mutationInFlight.current = null
    setMutationOperationId(null)
    dispatch({ type: 'close' })
  }, [abortReads])

  const activeMutationPending =
    state.kind !== 'idle' && mutationOperationId === state.session.operationId

  return {
    editorSession: state.kind === 'editor' ? state.session : null,
    editorFeedback: state.kind === 'editor' ? state.feedback : null,
    lifecycleSession: state.kind === 'lifecycle' ? state.session : null,
    lifecycleFeedback: state.kind === 'lifecycle' ? state.feedback : null,
    saving: activeMutationPending,
    statusMutationPending: activeMutationPending,
    startCreate,
    startEdit,
    startLifecycle,
    closeEditor: close,
    closeLifecycle: close,
    retryEditorSnapshot,
    retryLifecycleSnapshot,
    loadLatestMember,
    reviewLatestEditor,
    reviewLatestLifecycle,
    restartEditorFromLatest,
    restartLifecycleFromLatest,
    resolveEditReconciliation,
    reviewCreationDraft,
    retryCreationVerification,
    submitEditor,
    confirmLifecycle,
    authorizationKey: accessKey,
    authorizationVerified: identityVerified,
    isAuthorizationContextCurrent: (key: string) =>
      authorizationRef.current.accessKey === key,
  }
}

export type MemberAdministrationController = ReturnType<
  typeof useMemberAdministrationController
>
