import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import {
  currentUserQueryKey,
  type AuthContext,
} from '@/features/auth/session/current-user'
import {
  getMemberDirectoryAccess,
  type MemberDirectoryAccess,
} from './member-access-policy'
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
  updateMember,
  type Member,
  type MemberCreatePayload,
  type MemberPatchPayload,
  type MemberSnapshot,
} from './member-api'
import {
  synchronizeMemberCaches,
  type MemberCacheMutation,
  type MemberMutationOrigin,
} from './member-cache'
import { createMemberEditorRecovery } from './member-editor-recovery'
import { createMemberLifecycleRecovery } from './member-lifecycle-recovery'
import {
  createMemberOperationRequestCoordinator,
  type MemberOperationRequest,
  type MemberOperationRequestCoordinator,
} from './member-operation-requests'
import {
  memberOperationReducer,
  selectEditorFeedback,
  selectEditorSession,
  selectLifecycleFeedback,
  selectLifecycleSession,
  selectOperationCapabilities,
  storeMemberOperationFeedback,
  type MemberAuthorizationContext,
  type MemberOperationAction,
  type MemberOperationFeedback,
  type MemberOperationState,
} from './member-operation-state'
import {
  resolveMemberEditReconciliation,
  type MemberConflictChoices,
} from './member-reconciliation'
import type { OrganizationalUnit } from './organization-api'

export type { MemberLifecycleAction }
export type {
  MemberEditorSession,
  MemberLifecycleSession,
  MemberOperationFeedback,
} from './member-operation-state'

class ObsoleteMemberOperationError extends Error {
  constructor() {
    super(
      'Member-management authorization changed before the operation started.'
    )
    this.name = 'ObsoleteMemberOperationError'
  }
}

const snapshotVerificationDeferredMessage =
  'Current administration access could not be verified while loading the member. The protected response was discarded; verify access and retry the authoritative snapshot.'

const submissionAuthorizationBlockedMessage =
  'Current administration access changed before the request was sent. No mutation was dispatched; verify access and review the preserved values before trying again.'

export type MemberEditorSubmit =
  | {
      operationId: number
      contextKey: string
      mode: 'create'
      payload: MemberCreatePayload
    }
  | {
      operationId: number
      contextKey: string
      mode: 'edit'
      snapshot: MemberSnapshot
      payload: MemberPatchPayload
    }

type MemberEditorMutationInput = MemberEditorSubmit & {
  origin: MemberMutationOrigin
}

type MemberLifecycleMutationInput = {
  operationId: number
  contextKey: string
  action: MemberLifecycleAction
  snapshot: MemberSnapshot
  origin: MemberMutationOrigin
}

interface MemberAdministrationControllerOptions {
  access: MemberDirectoryAccess
  accessKey: string
  identity?: AuthContext
  identityVerified: boolean
  authorizedUnits: OrganizationalUnit[]
  organizationLookupStatus: 'loading' | 'error' | 'success'
}

type MemberChangedField =
  | 'displayName'
  | 'globalRole'
  | 'primaryOrgUnitId'
  | 'managerScopeUnitIds'

function changedMemberFields(
  payload: MemberPatchPayload
): MemberChangedField[] {
  return Object.keys(payload).filter(
    (field): field is MemberChangedField =>
      field === 'displayName' ||
      field === 'globalRole' ||
      field === 'primaryOrgUnitId' ||
      field === 'managerScopeUnitIds'
  )
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

export function useMemberAdministrationController({
  access,
  accessKey,
  identity,
  identityVerified,
  authorizedUnits,
  organizationLookupStatus,
}: MemberAdministrationControllerOptions) {
  const queryClient = useQueryClient()
  const [state, dispatch] = useReducer(memberOperationReducer, {
    kind: 'idle',
  })
  const stateRef = useRef<MemberOperationState>(state)
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
  const mutationInFlight = useRef<number | null>(null)
  const previousAuthorizationKey = useRef(
    `${accessKey}:${identity?.userId ?? ''}:${identity?.session.id ?? ''}`
  )
  const sessionRevalidationPendingRef = useRef(false)
  const [mutationOperationId, setMutationOperationId] = useState<number | null>(
    null
  )
  const [sessionRevalidationPending, setSessionRevalidationPending] =
    useState(false)

  const requestsRef = useRef<MemberOperationRequestCoordinator | null>(null)
  const getRequests = useCallback(() => {
    if (requestsRef.current === null) {
      requestsRef.current = createMemberOperationRequestCoordinator()
    }
    return requestsRef.current
  }, [])

  const dispatchOperation = useCallback((action: MemberOperationAction) => {
    stateRef.current = memberOperationReducer(stateRef.current, action)
    dispatch(action)
  }, [])

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

  const canPerformPrivilegedAction = useCallback(
    (contextKey: string) => {
      const authorization = authorizationRef.current
      const currentUserState =
        queryClient.getQueryState<AuthContext>(currentUserQueryKey)
      const currentIdentity = currentUserState?.data
      const currentAccess = currentIdentity
        ? getMemberDirectoryAccess(currentIdentity)
        : undefined
      return (
        authorization.accessKey === contextKey &&
        authorization.identityVerified &&
        !sessionRevalidationPendingRef.current &&
        currentUserState?.status === 'success' &&
        currentUserState.fetchStatus === 'idle' &&
        currentIdentity !== undefined &&
        currentAccess?.type === 'authorized' &&
        currentAccess.queryScopeKey === contextKey &&
        currentIdentity.userId === authorization.identity?.userId &&
        currentIdentity.session.id === authorization.identity?.session.id &&
        accessRef.current.type === 'authorized' &&
        currentIdentity.session.id.length > 0
      )
    },
    [queryClient]
  )

  const isCurrentOperationContext = useCallback(
    (operationId: number, contextKey: string): boolean => {
      const current = stateRef.current
      const currentUserState =
        queryClient.getQueryState<AuthContext>(currentUserQueryKey)
      const currentIdentity =
        currentUserState?.data ?? authorizationRef.current.identity
      const currentAccess = currentUserState?.data
        ? getMemberDirectoryAccess(currentUserState.data)
        : undefined
      return (
        current.kind !== 'idle' &&
        current.operationId === operationId &&
        current.authorization.contextKey === contextKey &&
        authorizationRef.current.accessKey === contextKey &&
        accessRef.current.type === 'authorized' &&
        currentIdentity !== undefined &&
        (currentAccess === undefined ||
          (currentAccess.type === 'authorized' &&
            currentAccess.queryScopeKey === contextKey)) &&
        current.authorization.actorId === currentIdentity.userId &&
        current.authorization.sessionId === currentIdentity.session.id
      )
    },
    [queryClient]
  )

  const getAuthorizedAccess = useCallback(
    () =>
      accessRef.current.type === 'authorized' ? accessRef.current : undefined,
    []
  )
  const getCurrentIdentity = useCallback(
    () => authorizationRef.current.identity,
    []
  )

  const captureMutationOrigin = useCallback((): MemberMutationOrigin | null => {
    const currentIdentity = authorizationRef.current.identity
    if (
      !currentIdentity ||
      !authorizationRef.current.identityVerified ||
      sessionRevalidationPendingRef.current
    ) {
      return null
    }
    return {
      actorId: currentIdentity.userId,
      sessionId: currentIdentity.session.id,
      authorizationContextKey: authorizationRef.current.accessKey,
    }
  }, [])

  const synchronizeMutation = useCallback(
    async (mutation: MemberCacheMutation, origin: MemberMutationOrigin) => {
      await synchronizeMemberCaches(
        queryClient,
        {
          ...mutation,
          actor: { userId: origin.actorId },
          origin,
        },
        {
          activeIdentity: authorizationRef.current.identity,
          beforeAuthorizationRefresh: async () => {
            const currentIdentity = authorizationRef.current.identity
            if (
              !currentIdentity ||
              currentIdentity.userId !== origin.actorId ||
              currentIdentity.session.id !== origin.sessionId ||
              authorizationRef.current.accessKey !==
                origin.authorizationContextKey
            ) {
              return
            }
            sessionRevalidationPendingRef.current = true
            setSessionRevalidationPending(true)
            try {
              await queryClient.invalidateQueries({
                queryKey: currentUserQueryKey,
              })
            } finally {
              const latestIdentity = authorizationRef.current.identity
              if (
                latestIdentity?.userId === origin.actorId &&
                latestIdentity.session.id === origin.sessionId &&
                authorizationRef.current.accessKey ===
                  origin.authorizationContextKey
              ) {
                sessionRevalidationPendingRef.current = false
                setSessionRevalidationPending(false)
              }
            }
          },
        }
      )
    },
    [queryClient]
  )

  useEffect(() => {
    const currentKey = `${accessKey}:${identity?.userId ?? ''}:${identity?.session.id ?? ''}`
    if (previousAuthorizationKey.current === currentKey) return
    previousAuthorizationKey.current = currentKey
    getRequests().cancelAllRequests()
    mutationInFlight.current = null
    setMutationOperationId(null)
    sessionRevalidationPendingRef.current = false
    setSessionRevalidationPending(false)
    dispatchOperation({
      type: 'AUTHORIZATION_CONTEXT_INVALIDATED',
      contextKey: accessKey,
    })
  }, [accessKey, dispatchOperation, getRequests, identity])

  useEffect(() => () => getRequests().cancelAllRequests(), [getRequests])

  const nextOperationId = useCallback(() => {
    getRequests().cancelAllRequests()
    operationSequence.current += 1
    return operationSequence.current
  }, [getRequests])

  const beginOperationRequest = useCallback(
    (
      operationId: number,
      contextKey: string,
      purpose: string,
      currentCheck: () => boolean
    ) =>
      getRequests().beginRequest({
        operationId,
        contextKey,
        purpose,
        isOperationCurrent: currentCheck,
        isAuthorizationAllowed: () => canPerformPrivilegedAction(contextKey),
      }),
    [canPerformPrivilegedAction, getRequests]
  )

  const loadEditorSnapshot = useCallback(
    async (
      memberId: string,
      operationId: number,
      contextKey: string,
      request: MemberOperationRequest
    ) => {
      try {
        const snapshot = await memberDetail(memberId, request.signal)
        if (
          !getRequests().isCurrentRequest(request, {
            operationId,
            contextKey,
          }) ||
          !isCurrentOperationContext(operationId, contextKey)
        ) {
          return
        }
        if (!canPerformPrivilegedAction(contextKey)) {
          dispatchOperation({
            type: 'SNAPSHOT_DEFERRED',
            operationId,
            contextKey,
            requestId: request.requestId,
            message: snapshotVerificationDeferredMessage,
          })
          return
        }
        const currentIdentity = authorizationRef.current.identity
        if (
          !currentIdentity ||
          !canManageMemberTarget(currentIdentity, snapshot.member)
        ) {
          throw new Error(
            'The current account can no longer manage this member.'
          )
        }
        dispatchOperation({
          type: 'SNAPSHOT_LOADED',
          operationId,
          contextKey,
          requestId: request.requestId,
          snapshot,
        })
      } catch (error) {
        if (
          request.signal.aborted ||
          !getRequests().isCurrentRequest(request, {
            operationId,
            contextKey,
          }) ||
          !isCurrentOperationContext(operationId, contextKey)
        ) {
          return
        }
        if (!canPerformPrivilegedAction(contextKey)) {
          dispatchOperation({
            type: 'SNAPSHOT_DEFERRED',
            operationId,
            contextKey,
            requestId: request.requestId,
            message: snapshotVerificationDeferredMessage,
          })
          return
        }
        dispatchOperation({
          type: 'SNAPSHOT_FAILED',
          operationId,
          contextKey,
          requestId: request.requestId,
          error: normalizeCoreApiError(error).message,
        })
      } finally {
        getRequests().completeRequest(request)
      }
    },
    [
      canPerformPrivilegedAction,
      dispatchOperation,
      getRequests,
      isCurrentOperationContext,
    ]
  )

  const loadLifecycleSnapshot = useCallback(
    async (
      memberId: string,
      action: MemberLifecycleAction,
      operationId: number,
      contextKey: string,
      request: MemberOperationRequest
    ) => {
      try {
        const snapshot = await memberDetail(memberId, request.signal)
        if (
          !getRequests().isCurrentRequest(request, {
            operationId,
            contextKey,
          }) ||
          !isCurrentOperationContext(operationId, contextKey)
        ) {
          return
        }
        if (!canPerformPrivilegedAction(contextKey)) {
          dispatchOperation({
            type: 'SNAPSHOT_DEFERRED',
            operationId,
            contextKey,
            requestId: request.requestId,
            message: snapshotVerificationDeferredMessage,
          })
          return
        }
        const currentIdentity = authorizationRef.current.identity
        if (
          !currentIdentity ||
          !canPerformMemberLifecycle(currentIdentity, snapshot.member, action)
        ) {
          throw new Error(
            'This lifecycle operation is no longer eligible for the current account or member state.'
          )
        }
        dispatchOperation({
          type: 'SNAPSHOT_LOADED',
          operationId,
          contextKey,
          requestId: request.requestId,
          snapshot,
        })
      } catch (error) {
        if (
          request.signal.aborted ||
          !getRequests().isCurrentRequest(request, {
            operationId,
            contextKey,
          }) ||
          !isCurrentOperationContext(operationId, contextKey)
        ) {
          return
        }
        if (!canPerformPrivilegedAction(contextKey)) {
          dispatchOperation({
            type: 'SNAPSHOT_DEFERRED',
            operationId,
            contextKey,
            requestId: request.requestId,
            message: snapshotVerificationDeferredMessage,
          })
          return
        }
        dispatchOperation({
          type: 'SNAPSHOT_FAILED',
          operationId,
          contextKey,
          requestId: request.requestId,
          error: normalizeCoreApiError(error).message,
        })
      } finally {
        getRequests().completeRequest(request)
      }
    },
    [
      canPerformPrivilegedAction,
      dispatchOperation,
      getRequests,
      isCurrentOperationContext,
    ]
  )

  const startCreate = useCallback(() => {
    const currentIdentity = authorizationRef.current.identity
    if (
      !currentIdentity ||
      !canProvisionMember(currentIdentity) ||
      !canPerformPrivilegedAction(accessKey) ||
      mutationInFlight.current !== null
    ) {
      return
    }
    const operationId = nextOperationId()
    const authorization: MemberAuthorizationContext = {
      actorId: currentIdentity.userId,
      sessionId: currentIdentity.session.id,
      contextKey: accessKey,
    }
    dispatchOperation({
      type: 'START_CREATE',
      operationId,
      authorization,
    })
  }, [
    accessKey,
    canPerformPrivilegedAction,
    dispatchOperation,
    nextOperationId,
  ])

  const startEdit = useCallback(
    (member: Pick<Member, 'id' | 'globalRole' | 'primaryOrgUnitId'>) => {
      const currentIdentity = authorizationRef.current.identity
      if (
        !currentIdentity ||
        !canManageMemberTarget(currentIdentity, member as Member) ||
        !canPerformPrivilegedAction(accessKey) ||
        mutationInFlight.current !== null
      ) {
        return
      }
      const operationId = nextOperationId()
      const request = beginOperationRequest(
        operationId,
        accessKey,
        'editor-snapshot',
        () => canPerformPrivilegedAction(accessKey)
      )
      if (!request) return
      const authorization: MemberAuthorizationContext = {
        actorId: currentIdentity.userId,
        sessionId: currentIdentity.session.id,
        contextKey: accessKey,
      }
      dispatchOperation({
        type: 'START_EDIT',
        operationId,
        authorization,
        memberId: member.id,
        requestId: request.requestId,
      })
      void loadEditorSnapshot(member.id, operationId, accessKey, request)
    },
    [
      accessKey,
      beginOperationRequest,
      dispatchOperation,
      canPerformPrivilegedAction,
      loadEditorSnapshot,
      nextOperationId,
    ]
  )

  const startLifecycle = useCallback(
    (member: Member, action: MemberLifecycleAction) => {
      const currentIdentity = authorizationRef.current.identity
      if (
        !currentIdentity ||
        !canPerformMemberLifecycle(currentIdentity, member, action) ||
        !canPerformPrivilegedAction(accessKey) ||
        mutationInFlight.current !== null
      ) {
        return
      }
      const operationId = nextOperationId()
      const request = beginOperationRequest(
        operationId,
        accessKey,
        'lifecycle-snapshot',
        () => canPerformPrivilegedAction(accessKey)
      )
      if (!request) return
      const authorization: MemberAuthorizationContext = {
        actorId: currentIdentity.userId,
        sessionId: currentIdentity.session.id,
        contextKey: accessKey,
      }
      dispatchOperation({
        type: 'START_LIFECYCLE',
        operationId,
        authorization,
        memberId: member.id,
        action,
        requestId: request.requestId,
      })
      void loadLifecycleSnapshot(
        member.id,
        action,
        operationId,
        accessKey,
        request
      )
    },
    [
      accessKey,
      beginOperationRequest,
      dispatchOperation,
      canPerformPrivilegedAction,
      loadLifecycleSnapshot,
      nextOperationId,
    ]
  )

  const editorRecoveryRef = useRef<ReturnType<
    typeof createMemberEditorRecovery
  > | null>(null)
  const getEditorRecovery = useCallback(() => {
    if (editorRecoveryRef.current === null) {
      editorRecoveryRef.current = createMemberEditorRecovery({
        requests: getRequests(),
        dispatch: dispatchOperation,
        getAccess: getAuthorizedAccess,
        isAuthorizationAllowed: canPerformPrivilegedAction,
        isOperationCurrent: isCurrentOperationContext,
      })
    }
    return editorRecoveryRef.current
  }, [
    dispatchOperation,
    getAuthorizedAccess,
    getRequests,
    canPerformPrivilegedAction,
    isCurrentOperationContext,
  ])

  const lifecycleRecoveryRef = useRef<ReturnType<
    typeof createMemberLifecycleRecovery
  > | null>(null)
  const getLifecycleRecovery = useCallback(() => {
    if (lifecycleRecoveryRef.current === null) {
      lifecycleRecoveryRef.current = createMemberLifecycleRecovery({
        requests: getRequests(),
        dispatch: dispatchOperation,
        getIdentity: getCurrentIdentity,
        isAuthorizationAllowed: canPerformPrivilegedAction,
        isOperationCurrent: isCurrentOperationContext,
      })
    }
    return lifecycleRecoveryRef.current
  }, [
    dispatchOperation,
    getCurrentIdentity,
    getRequests,
    canPerformPrivilegedAction,
    isCurrentOperationContext,
  ])

  const assertMutationOriginCurrent = useCallback(
    (origin: MemberMutationOrigin, contextKey: string) => {
      const currentIdentity = authorizationRef.current.identity
      if (
        !canPerformPrivilegedAction(contextKey) ||
        authorizationRef.current.accessKey !== contextKey ||
        !currentIdentity ||
        currentIdentity.userId !== origin.actorId ||
        currentIdentity.session.id !== origin.sessionId
      ) {
        throw new ObsoleteMemberOperationError()
      }
    },
    [canPerformPrivilegedAction]
  )

  const { mutate: mutateEditor } = useMutation({
    mutationFn: async (input: MemberEditorMutationInput) => {
      assertMutationOriginCurrent(input.origin, input.contextKey)
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
          changedFields: changedMemberFields(input.payload),
        },
        snapshot: await updateMember(
          input.snapshot.member.id,
          input.payload,
          input.snapshot.etag
        ),
      }
    },
    onSuccess: async (result, input) => {
      await synchronizeMutation(
        { ...result.mutation, outcome: 'confirmed' },
        input.origin
      )
      if (!isCurrentOperationContext(input.operationId, input.contextKey))
        return
      dispatchOperation({
        type: 'SUBMISSION_CONFIRMED',
        operationId: input.operationId,
        contextKey: input.contextKey,
      })
      toast.success(
        result.mutation.type === 'created'
          ? 'Account provisioned; secure setup is still required'
          : 'Member updated'
      )
    },
    onError: async (error, input) => {
      if (error instanceof ObsoleteMemberOperationError) {
        if (isCurrentOperationContext(input.operationId, input.contextKey)) {
          dispatchOperation({
            type: 'SUBMISSION_REJECTED',
            operationId: input.operationId,
            contextKey: input.contextKey,
            feedback: storeMemberOperationFeedback({
              outcome: 'rejected',
              message: submissionAuthorizationBlockedMessage,
              ...(input.mode === 'create'
                ? { submittedCreationPayload: input.payload }
                : {
                    originalSnapshot: input.snapshot,
                    submittedPatch: input.payload,
                  }),
            }),
          })
        }
        return
      }
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
        await synchronizeMutation(
          input.mode === 'create'
            ? { type: 'created', outcome: 'uncertain' }
            : {
                type: 'updated',
                targetMemberId: input.snapshot.member.id,
                changedFields: changedMemberFields(input.payload),
                outcome: 'uncertain',
              },
          input.origin
        )
        if (!isCurrentOperationContext(input.operationId, input.contextKey))
          return
        dispatchOperation({
          type: 'SUBMISSION_UNCERTAIN',
          operationId: input.operationId,
          contextKey: input.contextKey,
          feedback: storeMemberOperationFeedback(baseFeedback),
        })
        if (input.mode === 'create') {
          void getEditorRecovery().verifyCreation({
            operationId: input.operationId,
            contextKey: input.contextKey,
            payload: input.payload,
          })
        } else {
          void getEditorRecovery().verifyEdit({
            operationId: input.operationId,
            contextKey: input.contextKey,
            original: input.snapshot,
            payload: input.payload,
          })
        }
        return
      }

      if (isCurrentOperationContext(input.operationId, input.contextKey)) {
        dispatchOperation({
          type: 'SUBMISSION_REJECTED',
          operationId: input.operationId,
          contextKey: input.contextKey,
          feedback: storeMemberOperationFeedback(baseFeedback),
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

  const { mutate: mutateLifecycle } = useMutation({
    mutationFn: async (input: MemberLifecycleMutationInput) => {
      assertMutationOriginCurrent(input.origin, input.contextKey)
      const currentIdentity = authorizationRef.current.identity
      if (
        !currentIdentity ||
        !canPerformMemberLifecycle(
          currentIdentity,
          input.snapshot.member,
          input.action
        )
      ) {
        throw new ObsoleteMemberOperationError()
      }
      return {
        mutation: statusMutationName(input.action),
        targetMemberId: input.snapshot.member.id,
        snapshot: await changeMemberStatus(
          input.snapshot.member.id,
          input.action,
          input.snapshot.etag
        ),
      }
    },
    onSuccess: async (result, input) => {
      await synchronizeMutation(
        {
          type: result.mutation,
          targetMemberId: result.targetMemberId,
          outcome: 'confirmed',
        },
        input.origin
      )
      if (!isCurrentOperationContext(input.operationId, input.contextKey))
        return
      dispatchOperation({
        type: 'SUBMISSION_CONFIRMED',
        operationId: input.operationId,
        contextKey: input.contextKey,
      })
      toast.success(lifecycleSuccessMessage(input.action))
    },
    onError: async (error, input) => {
      if (error instanceof ObsoleteMemberOperationError) {
        if (isCurrentOperationContext(input.operationId, input.contextKey)) {
          dispatchOperation({
            type: 'SUBMISSION_REJECTED',
            operationId: input.operationId,
            contextKey: input.contextKey,
            feedback: storeMemberOperationFeedback({
              outcome: 'rejected',
              message: submissionAuthorizationBlockedMessage,
            }),
          })
        }
        return
      }
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
        await synchronizeMutation(
          {
            type: statusMutationName(input.action),
            targetMemberId: input.snapshot.member.id,
            outcome: 'uncertain',
          },
          input.origin
        )
        if (!isCurrentOperationContext(input.operationId, input.contextKey))
          return
        dispatchOperation({
          type: 'SUBMISSION_UNCERTAIN',
          operationId: input.operationId,
          contextKey: input.contextKey,
          feedback: storeMemberOperationFeedback(baseFeedback),
        })
        void getLifecycleRecovery().verifyLifecycle({
          operationId: input.operationId,
          contextKey: input.contextKey,
          action: input.action,
          originalSnapshot: input.snapshot,
        })
        return
      }
      if (isCurrentOperationContext(input.operationId, input.contextKey)) {
        dispatchOperation({
          type: 'SUBMISSION_REJECTED',
          operationId: input.operationId,
          contextKey: input.contextKey,
          feedback: storeMemberOperationFeedback(baseFeedback),
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

  const submitEditor = useCallback(
    (input: MemberEditorSubmit) => {
      const current = stateRef.current
      if (
        current.kind === 'idle' ||
        mutationInFlight.current !== null ||
        !isCurrentOperationContext(input.operationId, input.contextKey) ||
        !canPerformPrivilegedAction(input.contextKey) ||
        !selectOperationCapabilities(current).canSubmit
      ) {
        return
      }
      let mutationInput: MemberEditorMutationInput
      if (
        current.kind === 'create' &&
        input.mode === 'create' &&
        (current.phase === 'ready' || current.phase === 'rejected')
      ) {
        const origin = captureMutationOrigin()
        if (!origin) return
        mutationInput = { ...input, origin }
      } else if (
        current.kind === 'edit' &&
        input.mode === 'edit' &&
        (current.phase === 'ready' || current.phase === 'rejected') &&
        input.snapshot.member.id === current.reviewedSnapshot.member.id &&
        input.snapshot.etag === current.reviewedSnapshot.etag
      ) {
        const origin = captureMutationOrigin()
        if (!origin) return
        mutationInput = {
          ...input,
          snapshot: current.reviewedSnapshot,
          origin,
        }
      } else {
        return
      }

      const payload =
        mutationInput.mode === 'create'
          ? mutationInput.payload
          : mutationInput.payload
      mutationInFlight.current = input.operationId
      setMutationOperationId(input.operationId)
      dispatchOperation({
        type: 'SUBMISSION_STARTED',
        operationId: input.operationId,
        contextKey: input.contextKey,
        payload,
      })
      mutateEditor(mutationInput)
    },
    [
      captureMutationOrigin,
      canPerformPrivilegedAction,
      dispatchOperation,
      isCurrentOperationContext,
      mutateEditor,
    ]
  )

  const confirmLifecycle = useCallback(
    (operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'lifecycle' ||
        current.operationId !== operationId ||
        current.authorization.contextKey !== accessKey ||
        !selectOperationCapabilities(current).canSubmit ||
        mutationInFlight.current !== null ||
        !isCurrentOperationContext(operationId, accessKey) ||
        !canPerformPrivilegedAction(accessKey)
      ) {
        return
      }
      const origin = captureMutationOrigin()
      if (!origin) return
      const snapshot =
        current.phase === 'confirm' || current.phase === 'rejected'
          ? current.reviewedSnapshot
          : undefined
      if (!snapshot) return
      mutationInFlight.current = operationId
      setMutationOperationId(operationId)
      dispatchOperation({
        type: 'SUBMISSION_STARTED',
        operationId,
        contextKey: accessKey,
      })
      mutateLifecycle({
        operationId,
        contextKey: accessKey,
        action: current.action,
        snapshot,
        origin,
      })
    },
    [
      accessKey,
      captureMutationOrigin,
      canPerformPrivilegedAction,
      dispatchOperation,
      isCurrentOperationContext,
      mutateLifecycle,
    ]
  )

  const retryEditorSnapshot = useCallback(
    (memberId: string, operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'edit' ||
        current.phase !== 'load-error' ||
        current.operationId !== operationId ||
        current.authorization.contextKey !== accessKey ||
        !canPerformPrivilegedAction(accessKey)
      ) {
        return
      }
      const request = beginOperationRequest(
        operationId,
        accessKey,
        'editor-snapshot',
        () => isCurrentOperationContext(operationId, accessKey)
      )
      if (!request) return
      dispatchOperation({
        type: 'SNAPSHOT_REQUESTED',
        operationId,
        contextKey: accessKey,
        requestId: request.requestId,
      })
      void loadEditorSnapshot(memberId, operationId, accessKey, request)
    },
    [
      accessKey,
      beginOperationRequest,
      canPerformPrivilegedAction,
      dispatchOperation,
      isCurrentOperationContext,
      loadEditorSnapshot,
    ]
  )

  const retryLifecycleSnapshot = useCallback(
    (memberId: string, operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'lifecycle' ||
        current.phase !== 'load-error' ||
        current.operationId !== operationId ||
        current.authorization.contextKey !== accessKey ||
        !canPerformPrivilegedAction(accessKey)
      ) {
        return
      }
      const request = beginOperationRequest(
        operationId,
        accessKey,
        'lifecycle-snapshot',
        () => isCurrentOperationContext(operationId, accessKey)
      )
      if (!request) return
      dispatchOperation({
        type: 'SNAPSHOT_REQUESTED',
        operationId,
        contextKey: accessKey,
        requestId: request.requestId,
      })
      void loadLifecycleSnapshot(
        memberId,
        current.action,
        operationId,
        accessKey,
        request
      )
    },
    [
      accessKey,
      beginOperationRequest,
      canPerformPrivilegedAction,
      dispatchOperation,
      isCurrentOperationContext,
      loadLifecycleSnapshot,
    ]
  )

  const retryEditorVerification = useCallback(
    (operationId: number) => {
      const current = stateRef.current
      if (
        current.kind === 'create' &&
        current.operationId === operationId &&
        (current.phase === 'verification-required' ||
          current.phase === 'verification-failed' ||
          current.phase === 'review-found' ||
          current.phase === 'review-not-found') &&
        canPerformPrivilegedAction(current.authorization.contextKey)
      ) {
        void getEditorRecovery().verifyCreation({
          operationId,
          contextKey: current.authorization.contextKey,
          payload: current.submittedPayload,
        })
        return
      }
      if (
        current.kind === 'edit' &&
        current.operationId === operationId &&
        (current.phase === 'verification-required' ||
          current.phase === 'verification-failed' ||
          current.phase === 'review') &&
        canPerformPrivilegedAction(current.authorization.contextKey)
      ) {
        void getEditorRecovery().verifyEdit({
          operationId,
          contextKey: current.authorization.contextKey,
          original: current.originalSnapshot,
          payload: current.submittedPatch,
        })
      }
    },
    [canPerformPrivilegedAction, getEditorRecovery]
  )

  const retryLifecycleVerification = useCallback(
    (operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'lifecycle' ||
        current.operationId !== operationId ||
        (current.phase !== 'verification-required' &&
          current.phase !== 'verification-failed' &&
          current.phase !== 'review') ||
        !canPerformPrivilegedAction(current.authorization.contextKey)
      ) {
        return
      }
      void getLifecycleRecovery().verifyLifecycle({
        operationId,
        contextKey: current.authorization.contextKey,
        action: current.action,
        originalSnapshot: current.originalSnapshot,
      })
    },
    [canPerformPrivilegedAction, getLifecycleRecovery]
  )

  const reviewCreationDraft = useCallback(
    (operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'create' ||
        current.operationId !== operationId ||
        current.phase !== 'review-not-found' ||
        !canPerformPrivilegedAction(current.authorization.contextKey)
      ) {
        return
      }
      dispatchOperation({
        type: 'CREATION_DRAFT_REVIEWED',
        operationId,
        contextKey: current.authorization.contextKey,
      })
    },
    [canPerformPrivilegedAction, dispatchOperation]
  )

  const resolveEditReconciliation = useCallback(
    (
      operationId: number,
      reviewedVersion: string,
      choices: MemberConflictChoices
    ) => {
      const current = stateRef.current
      if (
        current.kind !== 'edit' ||
        current.operationId !== operationId ||
        current.phase !== 'review' ||
        current.latestSnapshot.etag !== reviewedVersion ||
        !canPerformPrivilegedAction(current.authorization.contextKey)
      ) {
        return
      }
      const resolved = resolveMemberEditReconciliation(
        current.reconciliation,
        choices
      )
      if (resolved.status === 'unresolved') return
      if (resolved.status === 'invalid') {
        dispatchOperation({
          type: 'RECOVERY_VALIDATION_FAILED',
          operationId,
          contextKey: current.authorization.contextKey,
          reviewedVersion,
          message: resolved.message,
        })
        return
      }
      const nextId = nextOperationId()
      dispatchOperation({
        type: 'EDIT_RECONCILIATION_RESOLVED',
        operationId,
        contextKey: current.authorization.contextKey,
        reviewedVersion,
        nextOperationId: nextId,
        values: resolved.values,
      })
      if (Object.keys(resolved.patch).length === 0) {
        toast.success('Member is already up to date', {
          description:
            'The reviewed server state already contains the retained changes. No additional update was sent.',
        })
      }
    },
    [canPerformPrivilegedAction, dispatchOperation, nextOperationId]
  )

  const discardEdit = useCallback(
    (operationId: number, reviewedVersion: string) => {
      const current = stateRef.current
      if (
        current.kind !== 'edit' ||
        current.operationId !== operationId ||
        current.phase !== 'review' ||
        current.latestSnapshot.etag !== reviewedVersion ||
        !canPerformPrivilegedAction(current.authorization.contextKey)
      ) {
        return
      }
      const nextId = nextOperationId()
      dispatchOperation({
        type: 'EDIT_DISCARDED',
        operationId,
        contextKey: current.authorization.contextKey,
        reviewedVersion,
        nextOperationId: nextId,
      })
    },
    [canPerformPrivilegedAction, dispatchOperation, nextOperationId]
  )

  const reviewLifecycleForConfirmation = useCallback(
    (operationId: number, reviewedVersion: string) => {
      const current = stateRef.current
      if (
        current.kind !== 'lifecycle' ||
        current.operationId !== operationId ||
        current.phase !== 'review' ||
        current.latestSnapshot.etag !== reviewedVersion ||
        !current.eligible ||
        current.desiredStatePresent ||
        !canPerformPrivilegedAction(current.authorization.contextKey)
      ) {
        return
      }
      const nextId = nextOperationId()
      dispatchOperation({
        type: 'LIFECYCLE_REVIEW_CONFIRMED',
        operationId,
        contextKey: current.authorization.contextKey,
        reviewedVersion,
        nextOperationId: nextId,
      })
    },
    [canPerformPrivilegedAction, dispatchOperation, nextOperationId]
  )

  const close = useCallback(() => {
    getRequests().cancelAllRequests()
    const current = stateRef.current
    mutationInFlight.current = null
    setMutationOperationId(null)
    if (current.kind !== 'idle') {
      dispatchOperation({
        type: 'OPERATION_CLOSED',
        operationId: current.operationId,
        contextKey: current.authorization.contextKey,
      })
    }
  }, [dispatchOperation, getRequests])

  const capabilities = selectOperationCapabilities(state)
  const activeMutationPending =
    state.kind !== 'idle' && mutationOperationId === state.operationId
  const editorSession = useMemo(() => selectEditorSession(state), [state])
  const lifecycleSession = useMemo(() => selectLifecycleSession(state), [state])

  return {
    operationState: state,
    editorOperation:
      state.kind === 'create' || state.kind === 'edit' ? state : null,
    lifecycleOperation: state.kind === 'lifecycle' ? state : null,
    editorSession,
    editorFeedback: selectEditorFeedback(state),
    lifecycleSession,
    lifecycleFeedback: selectLifecycleFeedback(state),
    saving: activeMutationPending,
    statusMutationPending: activeMutationPending,
    capabilities,
    startCreate,
    startEdit,
    startLifecycle,
    closeEditor: close,
    closeLifecycle: close,
    retryEditorSnapshot,
    retryLifecycleSnapshot,
    retryEditorVerification,
    retryLifecycleVerification,
    reviewCreationDraft,
    discardEdit,
    resolveEditReconciliation,
    reviewLifecycleForConfirmation,
    submitEditor,
    confirmLifecycle,
    authorizationKey: accessKey,
    authorizationVerified: identityVerified && !sessionRevalidationPending,
    isAuthorizationContextCurrent: (key: string) =>
      authorizationRef.current.accessKey === key,
    canSubmit: capabilities.canSubmit,
    canRetryVerification: capabilities.canRetryVerification,
    canResolveEdit: capabilities.canResolveEdit,
    canRenewLifecycleConfirmation: capabilities.canRenewLifecycleConfirmation,
  }
}

export type MemberAdministrationController = ReturnType<
  typeof useMemberAdministrationController
>
