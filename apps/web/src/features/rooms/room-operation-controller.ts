import { i18n } from '@/lib/i18n'
import { featureValidationMessage, requestErrorFormMessage } from '@/lib/i18n/presentation'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
} from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import {
  classifyRoomMutationOutcome,
  createRoom,
  deactivateRoom,
  reconcileRoomCreation,
  roomDetail,
  roomOperationErrorMessage,
  updateRoom,
  type RoomPatchPayload,
  type RoomSnapshot,
} from './room-api'
import { synchronizeRoomCaches } from './room-cache'
import { type RoomDeactivationSession } from './room-deactivation-dialog'
import {
  type RoomEditorSession,
  type RoomEditorSubmit,
  type RoomOperationFeedback,
} from './room-editor-dialog'
import {
  reconcileRoomEdit,
  resolveRoomEditReconciliation,
  roomFormValuesFromEditableValues,
  type RoomConflictChoices,
  type RoomEditReconciliation,
} from './room-reconciliation'

class ObsoleteRoomOperationError extends Error {
  constructor() {
    super('Room-management authorization changed before the operation started.')
    this.name = 'ObsoleteRoomOperationError'
  }
}

type RoomOperationState =
  | {
      kind: 'idle'
    }
  | {
      kind: 'editor'
      session: RoomEditorSession
      feedback: RoomOperationFeedback | null
    }
  | {
      kind: 'deactivation'
      session: RoomDeactivationSession
      feedback: RoomOperationFeedback | null
    }

type Action =
  | {
      type: 'start-editor'
      session: RoomEditorSession
    }
  | {
      type: 'start-deactivation'
      session: RoomDeactivationSession
    }
  | {
      type: 'editor-snapshot-loaded'
      operationId: number
      contextKey: string
      snapshot: RoomSnapshot
    }
  | {
      type: 'editor-snapshot-failed'
      operationId: number
      contextKey: string
      error: string
    }
  | {
      type: 'deactivation-snapshot-loaded'
      operationId: number
      contextKey: string
      snapshot: RoomSnapshot
    }
  | {
      type: 'deactivation-snapshot-failed'
      operationId: number
      contextKey: string
      error: string
    }
  | {
      type: 'editor-feedback'
      operationId: number
      contextKey: string
      feedback: RoomOperationFeedback | null
    }
  | {
      type: 'deactivation-feedback'
      operationId: number
      contextKey: string
      feedback: RoomOperationFeedback | null
    }
  | {
      type: 'replace-editor'
      session: RoomEditorSession
      feedback: RoomOperationFeedback | null
    }
  | {
      type: 'replace-deactivation'
      session: RoomDeactivationSession
      feedback: RoomOperationFeedback | null
    }
  | { type: 'close' }
  | { type: 'invalidate-context' }

function isCurrent(
  state: RoomOperationState,
  operationId: number,
  contextKey: string
): boolean {
  return (
    state.kind !== 'idle' &&
    state.session.operationId === operationId &&
    state.session.contextKey === contextKey
  )
}

function reducer(
  state: RoomOperationState,
  action: Action
): RoomOperationState {
  switch (action.type) {
    case 'start-editor':
      return {
        kind: 'editor',
        session: action.session,
        feedback: null,
      }
    case 'start-deactivation':
      return {
        kind: 'deactivation',
        session: action.session,
        feedback: null,
      }
    case 'editor-snapshot-loaded':
      if (!isCurrent(state, action.operationId, action.contextKey)) {
        return state
      }
      if (state.kind !== 'editor' || state.session.mode !== 'edit') {
        return state
      }
      if (action.snapshot.room.status !== 'ACTIVE') {
        return {
          ...state,
          session: {
            ...state.session,
            status: 'error',
            loadError: featureValidationMessage('rooms:noLongerActiveEdit'),
          },
        }
      }
      return {
        ...state,
        session: {
          ...state.session,
          status: 'ready',
          snapshot: action.snapshot,
        },
      }
    case 'editor-snapshot-failed':
      if (!isCurrent(state, action.operationId, action.contextKey)) {
        return state
      }
      if (state.kind !== 'editor' || state.session.mode !== 'edit') {
        return state
      }
      return {
        ...state,
        session: {
          ...state.session,
          status: 'error',
          loadError: action.error,
        },
      }
    case 'deactivation-snapshot-loaded':
      if (!isCurrent(state, action.operationId, action.contextKey)) {
        return state
      }
      if (state.kind !== 'deactivation') return state
      if (action.snapshot.room.status !== 'ACTIVE') {
        return {
          ...state,
          session: {
            ...state.session,
            phase: 'error',
            loadError: featureValidationMessage('rooms:noLongerActive'),
          },
        }
      }
      return {
        ...state,
        session: {
          ...state.session,
          phase: 'confirm',
          snapshot: action.snapshot,
        },
      }
    case 'deactivation-snapshot-failed':
      if (!isCurrent(state, action.operationId, action.contextKey)) {
        return state
      }
      if (state.kind !== 'deactivation') return state
      return {
        ...state,
        session: {
          ...state.session,
          phase: 'error',
          loadError: action.error,
        },
      }
    case 'editor-feedback':
      if (!isCurrent(state, action.operationId, action.contextKey)) {
        return state
      }
      if (state.kind !== 'editor') return state
      return { ...state, feedback: action.feedback }
    case 'deactivation-feedback':
      if (!isCurrent(state, action.operationId, action.contextKey)) {
        return state
      }
      if (state.kind !== 'deactivation') return state
      return { ...state, feedback: action.feedback }
    case 'replace-editor':
      return {
        kind: 'editor',
        session: action.session,
        feedback: action.feedback,
      }
    case 'replace-deactivation':
      return {
        kind: 'deactivation',
        session: action.session,
        feedback: action.feedback,
      }
    case 'close':
    case 'invalidate-context':
      return { kind: 'idle' }
  }
}

function editReconciliationMessage(
  reconciliation: RoomEditReconciliation
): string {
  if (reconciliation.latest.room.status !== 'ACTIVE') {
    return featureValidationMessage('rooms:latestInactiveEdit')
  }
  if (reconciliation.conflicts.length > 0) {
    return featureValidationMessage('rooms:reconcileConflicts')
  }

  const fields = Object.values(reconciliation.fields)
  const hasIntent = fields.some((field) => field.userChanged)
  const hasServerChanges = fields.some((field) => field.serverChanged)
  const intendedValuesArePresent = fields.every(
    (field) =>
      !field.userChanged ||
      (field.intended !== undefined && field.latest === field.intended)
  )
  const latestMatchesOriginal = fields.every(
    (field) => field.latest === field.original
  )

  if (hasIntent && intendedValuesArePresent) {
    return hasServerChanges
      ? featureValidationMessage('rooms:alreadyContainsIndependent')
      : featureValidationMessage('rooms:alreadyContains')
  }
  if (latestMatchesOriginal && hasIntent) {
    return featureValidationMessage('rooms:matchesOriginal')
  }
  if (hasServerChanges) {
    return featureValidationMessage('rooms:independentChanges')
  }
  return featureValidationMessage('rooms:reviewLatestState')
}

function latestMatchesIntent(reconciliation: RoomEditReconciliation): boolean {
  return Object.values(reconciliation.fields).every(
    (field) =>
      !field.userChanged ||
      (field.intended !== undefined && field.latest === field.intended)
  )
}

interface RoomOperationControllerOptions {
  accessKey: string
  canManage: boolean
  identityVerified: boolean
}

export function useRoomOperationController({
  accessKey,
  canManage,
  identityVerified,
}: RoomOperationControllerOptions) {
  const queryClient = useQueryClient()
  const [state, dispatch] = useReducer(reducer, { kind: 'idle' })
  const stateRef = useRef(state)
  const authorizationRef = useRef({ accessKey, identityVerified })
  const operationSequence = useRef(0)
  const snapshotController = useRef<AbortController | null>(null)
  const reconciliationController = useRef<AbortController | null>(null)
  const mutationInFlight = useRef<number | null>(null)
  const previousAccessKey = useRef(accessKey)

  useLayoutEffect(() => {
    stateRef.current = state
    authorizationRef.current = { accessKey, identityVerified }
  }, [accessKey, identityVerified, state])

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
    dispatch({ type: 'invalidate-context' })
  }, [abortReads, accessKey])

  useEffect(() => abortReads, [abortReads])

  const nextOperationId = useCallback(() => {
    abortReads()
    operationSequence.current += 1
    return operationSequence.current
  }, [abortReads])

  const loadEditorSnapshot = useCallback(
    async (roomId: string, operationId: number, contextKey: string) => {
      const controller = new AbortController()
      snapshotController.current = controller
      try {
        const snapshot = await roomDetail(roomId, controller.signal)
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
          error: requestErrorFormMessage(normalizeCoreApiError(error)),
        })
      } finally {
        if (snapshotController.current === controller) {
          snapshotController.current = null
        }
      }
    },
    [isCurrentOperation]
  )

  const loadDeactivationSnapshot = useCallback(
    async (roomId: string, operationId: number, contextKey: string) => {
      const controller = new AbortController()
      snapshotController.current = controller
      try {
        const snapshot = await roomDetail(roomId, controller.signal)
        if (!isCurrentOperation(operationId, contextKey)) return
        dispatch({
          type: 'deactivation-snapshot-loaded',
          operationId,
          contextKey,
          snapshot,
        })
      } catch (error) {
        if (controller.signal.aborted) return
        if (!isCurrentOperation(operationId, contextKey)) return
        dispatch({
          type: 'deactivation-snapshot-failed',
          operationId,
          contextKey,
          error: requestErrorFormMessage(normalizeCoreApiError(error)),
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
    if (
      !canManage ||
      !identityVerified ||
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
  }, [accessKey, canManage, identityVerified, nextOperationId])

  const startEdit = useCallback(
    (roomId: string) => {
      if (
        !canManage ||
        !identityVerified ||
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
          roomId,
          status: 'loading',
        },
      })
      void loadEditorSnapshot(roomId, operationId, accessKey)
    },
    [
      accessKey,
      canManage,
      identityVerified,
      loadEditorSnapshot,
      nextOperationId,
    ]
  )

  const startDeactivation = useCallback(
    (roomId: string) => {
      if (
        !canManage ||
        !identityVerified ||
        mutationInFlight.current !== null ||
        authorizationRef.current.accessKey !== accessKey
      ) {
        return
      }
      const operationId = nextOperationId()
      dispatch({
        type: 'start-deactivation',
        session: {
          operationId,
          contextKey: accessKey,
          roomId,
          phase: 'loading',
        },
      })
      void loadDeactivationSnapshot(roomId, operationId, accessKey)
    },
    [
      accessKey,
      canManage,
      identityVerified,
      loadDeactivationSnapshot,
      nextOperationId,
    ]
  )

  const mutation = useMutation({
    mutationFn: async (input: RoomEditorSubmit) => {
      if (
        authorizationRef.current.accessKey !== input.contextKey ||
        !authorizationRef.current.identityVerified
      ) {
        throw new ObsoleteRoomOperationError()
      }
      if (input.mode === 'create') {
        return {
          mutation: 'created' as const,
          snapshot: await createRoom(input.payload),
        }
      }
      return {
        mutation: 'updated' as const,
        snapshot: await updateRoom(
          input.snapshot.room.id,
          input.payload,
          input.snapshot.etag
        ),
      }
    },
    onSuccess: async (result, input) => {
      await synchronizeRoomCaches(queryClient, result.mutation)
      if (!isCurrentOperation(input.operationId, input.contextKey)) return
      toast.success(
        result.mutation === 'created' ? i18n.t('rooms:created') : i18n.t('rooms:updated')
      )
      dispatch({ type: 'close' })
    },
    onError: async (error, input) => {
      if (error instanceof ObsoleteRoomOperationError) return
      const outcome = classifyRoomMutationOutcome(error)
      const normalizedError = normalizeCoreApiError(error)
      const baseFeedback: RoomOperationFeedback = {
        outcome,
        message: roomOperationErrorMessage(
          error,
          input.mode === 'create' ? 'create' : 'edit',
          featureValidationMessage
        ),
        fieldErrors: normalizedError.fieldErrors,
        ...(input.mode === 'edit'
          ? {
              originalSnapshot: input.snapshot,
              submittedPatch: input.payload,
            }
          : { submittedCreationPayload: input.payload }),
      }

      if (outcome === 'uncertain' || outcome === 'unknown') {
        await synchronizeRoomCaches(
          queryClient,
          input.mode === 'create' ? 'created' : 'updated'
        )
        if (!isCurrentOperation(input.operationId, input.contextKey)) return
        dispatch({
          type: 'editor-feedback',
          operationId: input.operationId,
          contextKey: input.contextKey,
          feedback: { ...baseFeedback, reconciliationLoading: true },
        })
        if (input.mode === 'create') {
          await verifyCreation(
            input.operationId,
            input.contextKey,
            input.payload,
            baseFeedback
          )
        } else {
          await verifyEdit(
            input.operationId,
            input.contextKey,
            input.snapshot,
            input.payload,
            baseFeedback
          )
        }
        return
      }

      if (normalizedError.status === 404) {
        await queryClient.invalidateQueries({ queryKey: ['rooms'] })
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
    },
  })

  const verifyCreation = useCallback(
    async (
      operationId: number,
      contextKey: string,
      payload: Parameters<typeof reconcileRoomCreation>[0],
      baseFeedback?: RoomOperationFeedback
    ) => {
      if (!isCurrentOperation(operationId, contextKey)) return
      reconciliationController.current?.abort()
      const controller = new AbortController()
      reconciliationController.current = controller
      const current =
        stateRef.current.kind === 'editor' &&
        stateRef.current.session.operationId === operationId
          ? stateRef.current.feedback
          : null
      dispatch({
        type: 'editor-feedback',
        operationId,
        contextKey,
        feedback: {
          ...(baseFeedback ??
            current ?? {
              outcome: 'unknown',
              message:
                featureValidationMessage('rooms:createUnconfirmed'),
            }),
          submittedCreationPayload: payload,
          creationReconciliation: undefined,
          reconciliationError: undefined,
          reconciliationLoading: true,
        },
      })
      try {
        const result = await reconcileRoomCreation(payload, controller.signal)
        if (!isCurrentOperation(operationId, contextKey)) return
        const feedback =
          stateRef.current.kind === 'editor'
            ? stateRef.current.feedback
            : undefined
        const message =
          result.status === 'found'
            ? result.metadataMatches
              ? featureValidationMessage('rooms:exactCodeMatches')
              : featureValidationMessage('rooms:exactCodeDiffers')
            : featureValidationMessage('rooms:noExactCode')
        dispatch({
          type: 'editor-feedback',
          operationId,
          contextKey,
          feedback: {
            ...(feedback ?? baseFeedback!),
            message,
            creationReconciliation: result,
            reconciliationError: undefined,
            reconciliationLoading: false,
            submittedCreationPayload: payload,
          },
        })
      } catch (error) {
        if (controller.signal.aborted) return
        if (!isCurrentOperation(operationId, contextKey)) return
        const feedback =
          stateRef.current.kind === 'editor'
            ? stateRef.current.feedback
            : undefined
        dispatch({
          type: 'editor-feedback',
          operationId,
          contextKey,
          feedback: {
            ...(feedback ?? baseFeedback!),
            creationReconciliation: undefined,
            reconciliationError: requestErrorFormMessage(normalizeCoreApiError(error)),
            reconciliationLoading: false,
            submittedCreationPayload: payload,
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
      original: RoomSnapshot,
      payload: RoomPatchPayload,
      baseFeedback?: RoomOperationFeedback,
      latestOverride?: RoomSnapshot
    ) => {
      if (!isCurrentOperation(operationId, contextKey)) return
      reconciliationController.current?.abort()
      const controller = new AbortController()
      reconciliationController.current = controller
      const fallbackFeedback: RoomOperationFeedback = {
        outcome: 'unknown',
        message:
          featureValidationMessage('rooms:editUnconfirmed'),
      }
      const initialFeedback =
        baseFeedback ??
        (stateRef.current.kind === 'editor'
          ? stateRef.current.feedback
          : null) ??
        fallbackFeedback
      dispatch({
        type: 'editor-feedback',
        operationId,
        contextKey,
        feedback: {
          ...initialFeedback,
          originalSnapshot: original,
          submittedPatch: payload,
          reconciliationLoading: !latestOverride,
        },
      })
      try {
        const latest =
          latestOverride ??
          (await roomDetail(original.room.id, controller.signal))
        if (!isCurrentOperation(operationId, contextKey)) return
        const reconciliation = reconcileRoomEdit(original, payload, latest)
        const currentFeedback =
          stateRef.current.kind === 'editor' ? stateRef.current.feedback : null
        dispatch({
          type: 'editor-feedback',
          operationId,
          contextKey,
          feedback: {
            ...(currentFeedback ?? initialFeedback),
            message: editReconciliationMessage(reconciliation),
            latestSnapshot: latest,
            editReconciliation: reconciliation,
            latestMatchesRequest: latestMatchesIntent(reconciliation),
            originalSnapshot: original,
            submittedPatch: payload,
            reconciliationError: undefined,
            reconciliationLoading: false,
          },
        })
      } catch (error) {
        if (controller.signal.aborted) return
        if (!isCurrentOperation(operationId, contextKey)) return
        const currentFeedback =
          stateRef.current.kind === 'editor' ? stateRef.current.feedback : null
        dispatch({
          type: 'editor-feedback',
          operationId,
          contextKey,
          feedback: {
            ...(currentFeedback ?? initialFeedback),
            originalSnapshot: original,
            submittedPatch: payload,
            reconciliationError: requestErrorFormMessage(normalizeCoreApiError(error)),
            reconciliationLoading: false,
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

  const deactivationMutation = useMutation({
    mutationFn: async ({
      snapshot,
      contextKey,
    }: {
      snapshot: RoomSnapshot
      operationId: number
      contextKey: string
    }) => {
      if (
        authorizationRef.current.accessKey !== contextKey ||
        !authorizationRef.current.identityVerified
      ) {
        throw new ObsoleteRoomOperationError()
      }
      return deactivateRoom(snapshot.room.id, snapshot.etag)
    },
    onSuccess: async (_result, input) => {
      await synchronizeRoomCaches(queryClient, 'deactivated')
      if (!isCurrentOperation(input.operationId, input.contextKey)) return
      toast.success(i18n.t('rooms:deactivated'))
      dispatch({ type: 'close' })
    },
    onError: async (error, input) => {
      if (error instanceof ObsoleteRoomOperationError) return
      const outcome = classifyRoomMutationOutcome(error)
      const normalizedError = normalizeCoreApiError(error)
      const baseFeedback: RoomOperationFeedback = {
        outcome,
        message: roomOperationErrorMessage(error, 'deactivate', featureValidationMessage),
        fieldErrors: normalizedError.fieldErrors,
      }
      if (outcome === 'uncertain' || outcome === 'unknown') {
        await synchronizeRoomCaches(queryClient, 'deactivated')
        if (!isCurrentOperation(input.operationId, input.contextKey)) return
        const controller = new AbortController()
        reconciliationController.current?.abort()
        reconciliationController.current = controller
        try {
          const latest = await roomDetail(
            input.snapshot.room.id,
            controller.signal
          )
          if (!isCurrentOperation(input.operationId, input.contextKey)) return
          dispatch({
            type: 'deactivation-feedback',
            operationId: input.operationId,
            contextKey: input.contextKey,
            feedback: {
              ...baseFeedback,
              message:
                latest.room.status === 'INACTIVE'
                  ? featureValidationMessage('rooms:verifiedInactive')
                  : featureValidationMessage('rooms:verifiedActive'),
              latestSnapshot: latest,
            },
          })
        } catch (reconciliationError) {
          if (controller.signal.aborted) return
          if (!isCurrentOperation(input.operationId, input.contextKey)) return
          dispatch({
            type: 'deactivation-feedback',
            operationId: input.operationId,
            contextKey: input.contextKey,
            feedback: {
              ...baseFeedback,
              reconciliationError:
                requestErrorFormMessage(normalizeCoreApiError(reconciliationError)),
            },
          })
        } finally {
          if (reconciliationController.current === controller) {
            reconciliationController.current = null
          }
        }
        return
      }
      if (normalizedError.status === 404) {
        await queryClient.invalidateQueries({ queryKey: ['rooms'] })
      }
      if (isCurrentOperation(input.operationId, input.contextKey)) {
        dispatch({
          type: 'deactivation-feedback',
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
    },
  })
  const { mutate: mutateRoom, isPending: roomMutationPending } = mutation
  const { mutate: mutateDeactivation, isPending: deactivationMutationPending } =
    deactivationMutation

  const submitEditor = useCallback(
    (input: RoomEditorSubmit) => {
      if (
        !isCurrentOperation(input.operationId, input.contextKey) ||
        !authorizationRef.current.identityVerified ||
        mutationInFlight.current !== null ||
        roomMutationPending ||
        deactivationMutationPending
      ) {
        return
      }
      mutationInFlight.current = input.operationId
      dispatch({
        type: 'editor-feedback',
        operationId: input.operationId,
        contextKey: input.contextKey,
        feedback: null,
      })
      mutateRoom(input)
    },
    [
      deactivationMutationPending,
      isCurrentOperation,
      mutateRoom,
      roomMutationPending,
    ]
  )

  const confirmDeactivation = useCallback(
    (snapshot: RoomSnapshot, operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'deactivation' ||
        current.session.operationId !== operationId ||
        current.session.contextKey !== accessKey ||
        !authorizationRef.current.identityVerified ||
        mutationInFlight.current !== null ||
        deactivationMutationPending
      ) {
        return
      }
      mutationInFlight.current = operationId
      dispatch({
        type: 'deactivation-feedback',
        operationId,
        contextKey: accessKey,
        feedback: null,
      })
      mutateDeactivation({
        snapshot,
        operationId,
        contextKey: accessKey,
      })
    },
    [accessKey, deactivationMutationPending, mutateDeactivation]
  )

  const close = useCallback(() => {
    abortReads()
    dispatch({ type: 'close' })
  }, [abortReads])

  const retryEditorSnapshot = useCallback(
    (roomId: string, operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'editor' ||
        current.session.operationId !== operationId ||
        current.session.contextKey !== accessKey ||
        !identityVerified
      ) {
        return
      }
      dispatch({
        type: 'replace-editor',
        session: {
          ...current.session,
          mode: 'edit',
          roomId,
          status: 'loading',
        },
        feedback: null,
      })
      void loadEditorSnapshot(roomId, operationId, accessKey)
    },
    [accessKey, identityVerified, loadEditorSnapshot]
  )

  const retryDeactivationSnapshot = useCallback(
    (roomId: string, operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'deactivation' ||
        current.session.operationId !== operationId ||
        current.session.contextKey !== accessKey ||
        !identityVerified
      ) {
        return
      }
      dispatch({
        type: 'replace-deactivation',
        session: {
          ...current.session,
          roomId,
          phase: 'loading',
          snapshot: undefined,
          loadError: undefined,
        },
        feedback: null,
      })
      void loadDeactivationSnapshot(roomId, operationId, accessKey)
    },
    [accessKey, identityVerified, loadDeactivationSnapshot]
  )

  const loadLatestRoom = useCallback(
    async (roomId: string) => {
      const current = stateRef.current
      if (
        current.kind === 'idle' ||
        !authorizationRef.current.identityVerified ||
        current.session.contextKey !== accessKey
      ) {
        throw new Error(
          'Verify room-management access before loading room data.'
        )
      }
      const controller = new AbortController()
      reconciliationController.current?.abort()
      reconciliationController.current = controller
      try {
        const snapshot = await roomDetail(roomId, controller.signal)
        if (
          !isCurrentOperation(
            current.session.operationId,
            current.session.contextKey
          )
        ) {
          throw new Error(
            'The room operation context changed before the latest state was received.'
          )
        }
        return snapshot
      } finally {
        if (reconciliationController.current === controller) {
          reconciliationController.current = null
        }
      }
    },
    [accessKey, isCurrentOperation]
  )

  const reviewLatest = useCallback(
    (snapshot: RoomSnapshot, operationId: number) => {
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

  const resolveEditReconciliation = useCallback(
    (operationId: number, choices: RoomConflictChoices) => {
      const current = stateRef.current
      if (
        current.kind !== 'editor' ||
        current.session.operationId !== operationId ||
        current.session.mode !== 'edit' ||
        !current.feedback?.editReconciliation ||
        !identityVerified
      ) {
        return
      }
      const reconciliation = current.feedback.editReconciliation
      const resolved = resolveRoomEditReconciliation(reconciliation, choices)
      if (resolved.status === 'unresolved') return
      if (reconciliation.latest.room.status !== 'ACTIVE') return
      const nextId = nextOperationId()
      dispatch({
        type: 'replace-editor',
        session: {
          operationId: nextId,
          contextKey: current.session.contextKey,
          mode: 'edit',
          roomId: reconciliation.latest.room.id,
          status: 'ready',
          snapshot: reconciliation.latest,
          initialValues: roomFormValuesFromEditableValues(
            reconciliation.latest.room,
            resolved.values
          ),
        },
        feedback: null,
      })
      if (Object.keys(resolved.patch).length === 0) {
        toast.success(i18n.t('rooms:upToDate'), {
          description:
            i18n.t('rooms:noAdditionalUpdate'),
        })
      }
    },
    [identityVerified, nextOperationId]
  )

  const restartEditorFromLatest = useCallback(
    (snapshot: RoomSnapshot, operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'editor' ||
        current.session.operationId !== operationId ||
        current.session.mode !== 'edit' ||
        !identityVerified ||
        snapshot.room.status !== 'ACTIVE'
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
          roomId: snapshot.room.id,
          status: 'ready',
          snapshot,
        },
        feedback: null,
      })
    },
    [identityVerified, nextOperationId]
  )

  const restartDeactivationFromLatest = useCallback(
    (snapshot: RoomSnapshot, operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'deactivation' ||
        current.session.operationId !== operationId ||
        !identityVerified ||
        snapshot.room.status !== 'ACTIVE'
      ) {
        return
      }
      const nextId = nextOperationId()
      dispatch({
        type: 'replace-deactivation',
        session: {
          operationId: nextId,
          contextKey: current.session.contextKey,
          roomId: snapshot.room.id,
          phase: 'confirm',
          snapshot,
        },
        feedback: null,
      })
    },
    [identityVerified, nextOperationId]
  )

  const reviewCreationDraft = useCallback(
    (operationId: number) => {
      const current = stateRef.current
      if (
        current.kind !== 'editor' ||
        current.session.operationId !== operationId ||
        current.session.mode !== 'create' ||
        current.feedback?.creationReconciliation?.status !== 'not-found' ||
        !identityVerified
      ) {
        return
      }
      dispatch({
        type: 'editor-feedback',
        operationId,
        contextKey: current.session.contextKey,
        feedback: null,
      })
    },
    [identityVerified]
  )

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
        !identityVerified
      ) {
        return
      }
      void verifyCreation(
        operationId,
        current.session.contextKey,
        payload,
        current.feedback ?? undefined
      )
    },
    [identityVerified, verifyCreation]
  )

  return {
    editorSession: state.kind === 'editor' ? state.session : null,
    editorFeedback: state.kind === 'editor' ? state.feedback : null,
    deactivationSession: state.kind === 'deactivation' ? state.session : null,
    deactivationFeedback: state.kind === 'deactivation' ? state.feedback : null,
    saving: roomMutationPending || deactivationMutationPending,
    startCreate,
    startEdit,
    startDeactivation,
    closeEditor: close,
    closeDeactivation: close,
    retryEditorSnapshot,
    retryDeactivationSnapshot,
    loadLatestRoom,
    reviewLatest,
    restartEditorFromLatest,
    restartDeactivationFromLatest,
    resolveEditReconciliation,
    reviewCreationDraft,
    retryCreationVerification,
    submitEditor,
    confirmDeactivation,
  }
}
