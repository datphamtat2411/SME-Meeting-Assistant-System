import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MapPin, Pencil, Plus, Search, ShieldAlert, Users } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
import { useDirectorySearchDraft } from '@/hooks/use-directory-search-draft'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Header } from '@/components/layout/header'
import { HeaderActions } from '@/components/layout/header-actions'
import { Main } from '@/components/layout/main'
import {
  RequestEmpty,
  RequestError,
  RequestLoading,
} from '@/components/request-state'
import { currentUserQueryOptions } from '@/features/auth/session/current-user'
import {
  getRoomDirectoryAccess,
  constrainRoomSearch,
} from './room-access-policy'
import {
  classifyRoomMutationOutcome,
  createRoom,
  deactivateRoom,
  roomDetail,
  roomOperationErrorMessage,
  reconcileRoomCreation,
  roomPatchMatchesRoom,
  roomsQuery,
  updateRoom,
  type Room,
  type RoomSnapshot,
} from './room-api'
import { synchronizeRoomCaches } from './room-cache'
import {
  RoomDeactivationDialog,
  type RoomDeactivationSession,
} from './room-deactivation-dialog'
import {
  normalizeRoomSearch,
  resolveRoomDirectoryCriteria,
  roomSortFields,
  type RoomDirectorySearch,
  type RoomSort,
  type RoomStatus,
} from './room-directory-state'
import {
  RoomEditorDialog,
  type RoomEditorSession,
  type RoomEditorSubmit,
  type RoomOperationFeedback,
} from './room-editor-dialog'

type SearchChange = (
  patch: Partial<RoomDirectorySearch>,
  options?: { replace?: boolean }
) => void

const searchDebounceMs = 350
const pageSizeChoices = [10, 20, 50, 100]

function normalizeSearchDraft(value: string) {
  return normalizeRoomSearch({ q: value }).q
}

const roomSortLabels: Record<(typeof roomSortFields)[number], string> = {
  code: 'Room code',
  name: 'Name',
  capacity: 'Capacity',
  status: 'Status',
  createdAt: 'Date created',
}

function sameSearch(
  first: RoomDirectorySearch,
  second: RoomDirectorySearch
): boolean {
  const a = normalizeRoomSearch(first)
  const b = normalizeRoomSearch(second)
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) =>
        a[key as keyof RoomDirectorySearch] ===
        b[key as keyof RoomDirectorySearch]
    )
  )
}

function RoomStatusBadge({ status }: { status: Room['status'] }) {
  return (
    <Badge
      variant='outline'
      className={
        status === 'ACTIVE'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
          : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
      }
    >
      {status === 'ACTIVE' ? 'Active' : 'Inactive'}
    </Badge>
  )
}

function RoomLocation({ room }: { room: Room }) {
  return (
    <div className='flex min-w-32 items-center gap-2'>
      <MapPin
        aria-hidden='true'
        className='size-4 shrink-0 text-muted-foreground'
      />
      <span>{room.location || 'Not set'}</span>
    </div>
  )
}

function RoomCapacity({ room }: { room: Room }) {
  return (
    <div className='flex items-center gap-2'>
      <Users
        aria-hidden='true'
        className='size-4 shrink-0 text-muted-foreground'
      />
      <span>{room.capacity === null ? 'Not set' : room.capacity}</span>
    </div>
  )
}

export function RoomsPage({
  search,
  onSearchChange,
}: {
  search: RoomDirectorySearch
  onSearchChange: SearchChange
}) {
  const queryClient = useQueryClient()
  const identity = useQuery(currentUserQueryOptions())
  const identityErrorStatus = identity.isRefetchError
    ? normalizeCoreApiError(identity.error).status
    : undefined
  const identityDenied =
    identityErrorStatus === 401 || identityErrorStatus === 403
  const identityResolved = identity.isSuccess && !identityDenied
  const identityVerified =
    identityResolved && !identity.isFetching && !identity.isRefetchError
  const access = getRoomDirectoryAccess(
    identityResolved ? identity.data : undefined
  )
  const accessKey =
    access.type === 'authorized' ? access.queryScopeKey : access.type
  const currentAuthorization = useRef({ accessKey, identityVerified })
  useLayoutEffect(() => {
    currentAuthorization.current = { accessKey, identityVerified }
  }, [accessKey, identityVerified])
  const constrainedSearch =
    access.type === 'authorized'
      ? constrainRoomSearch(search, identity.data)
      : normalizeRoomSearch(search)
  const criteria = resolveRoomDirectoryCriteria(constrainedSearch)
  const { draft: searchDraft, updateDraft: updateSearchDraft } =
    useDirectorySearchDraft({
      criteriaKey: JSON.stringify([accessKey, normalizeRoomSearch(search)]),
      committedQuery: criteria.q,
      normalize: normalizeSearchDraft,
      onCommit: (q) => onSearchChange({ q }, { replace: true }),
      delayMs: searchDebounceMs,
    })
  const directory = useQuery(roomsQuery(criteria, access))
  const [editorSession, setEditorSession] = useState<RoomEditorSession | null>(
    null
  )
  const [deactivationSession, setDeactivationSession] =
    useState<RoomDeactivationSession | null>(null)
  const [editorFeedback, setEditorFeedback] =
    useState<RoomOperationFeedback | null>(null)
  const [deactivationFeedback, setDeactivationFeedback] =
    useState<RoomOperationFeedback | null>(null)
  const operationSequence = useRef(0)
  const activeOperation = useRef(0)
  const mutationInFlight = useRef(false)
  const recoveryController = useRef<AbortController | null>(null)
  const previousAccessKey = useRef(accessKey)

  function isCurrentOperation(operationId: number, contextKey: string) {
    return (
      activeOperation.current === operationId &&
      currentAuthorization.current.accessKey === contextKey
    )
  }

  const mutation = useMutation({
    mutationFn: async (input: RoomEditorSubmit) => {
      if (
        currentAuthorization.current.accessKey !== input.contextKey ||
        !currentAuthorization.current.identityVerified
      ) {
        throw new Error(
          'Room-management authorization changed before the operation started.'
        )
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
        result.mutation === 'created' ? 'Room created' : 'Room updated'
      )
      activeOperation.current = 0
      setEditorSession(null)
      setEditorFeedback(null)
    },
    onError: async (error, input) => {
      const outcome = classifyRoomMutationOutcome(error)
      const normalizedError = normalizeCoreApiError(error)
      const baseFeedback: RoomOperationFeedback = {
        outcome,
        message: roomOperationErrorMessage(
          error,
          input.mode === 'create' ? 'create' : 'edit'
        ),
        fieldErrors: normalizedError.fieldErrors,
      }
      if (outcome === 'uncertain' || outcome === 'unknown') {
        await synchronizeRoomCaches(
          queryClient,
          input.mode === 'create' ? 'created' : 'updated'
        )
        if (!isCurrentOperation(input.operationId, input.contextKey)) return
        const controller = new AbortController()
        recoveryController.current?.abort()
        recoveryController.current = controller
        if (input.mode === 'create') {
          try {
            const creationReconciliation = await reconcileRoomCreation(
              input.payload,
              controller.signal
            )
            if (!isCurrentOperation(input.operationId, input.contextKey)) return
            const message =
              creationReconciliation.status === 'found'
                ? creationReconciliation.metadataMatches
                  ? 'The exact room code already exists and its metadata matches the submitted request. The request may have succeeded; no second request was sent.'
                  : 'The exact room code already exists with different metadata. Review the existing record before deciding what to do.'
                : 'No exact room code was found in the authoritative catalog. Review the preserved draft before explicitly deciding whether to retry.'
            setEditorFeedback({
              ...baseFeedback,
              message,
              creationReconciliation,
            })
          } catch (reconciliationError) {
            if (!isCurrentOperation(input.operationId, input.contextKey)) return
            setEditorFeedback({
              ...baseFeedback,
              reconciliationError:
                normalizeCoreApiError(reconciliationError).message,
            })
          }
          return
        }
        try {
          const latest = await roomDetail(
            input.snapshot.room.id,
            controller.signal
          )
          if (!isCurrentOperation(input.operationId, input.contextKey)) return
          const latestMatchesRequest = roomPatchMatchesRoom(
            latest.room,
            input.payload
          )
          setEditorFeedback({
            ...baseFeedback,
            message: latestMatchesRequest
              ? 'The latest room state matches the submitted changes. The request may have succeeded; review the room before any retry.'
              : 'The latest room state matches neither the submitted edit nor the prior room snapshot. Review it before deciding what to do.',
            latestSnapshot: latest,
            latestMatchesRequest,
          })
        } catch (reconciliationError) {
          if (!isCurrentOperation(input.operationId, input.contextKey)) return
          setEditorFeedback({
            ...baseFeedback,
            reconciliationError:
              normalizeCoreApiError(reconciliationError).message,
          })
        }
        return
      } else if (normalizedError.status === 404) {
        await queryClient.invalidateQueries({ queryKey: ['rooms'] })
      }
      if (isCurrentOperation(input.operationId, input.contextKey)) {
        setEditorFeedback(baseFeedback)
      }
    },
    onSettled: () => {
      mutationInFlight.current = false
    },
  })
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
        currentAuthorization.current.accessKey !== contextKey ||
        !currentAuthorization.current.identityVerified
      ) {
        throw new Error(
          'Room-management authorization changed before the operation started.'
        )
      }
      return deactivateRoom(snapshot.room.id, snapshot.etag)
    },
    onSuccess: async (_result, input) => {
      await synchronizeRoomCaches(queryClient, 'deactivated')
      if (!isCurrentOperation(input.operationId, input.contextKey)) return
      toast.success('Room deactivated')
      activeOperation.current = 0
      setDeactivationSession(null)
      setDeactivationFeedback(null)
    },
    onError: async (error, input) => {
      const outcome = classifyRoomMutationOutcome(error)
      const normalizedError = normalizeCoreApiError(error)
      const baseFeedback: RoomOperationFeedback = {
        outcome,
        message: roomOperationErrorMessage(error, 'deactivate'),
        fieldErrors: normalizedError.fieldErrors,
      }
      if (outcome === 'uncertain' || outcome === 'unknown') {
        await synchronizeRoomCaches(queryClient, 'deactivated')
        if (!isCurrentOperation(input.operationId, input.contextKey)) return
        const controller = new AbortController()
        recoveryController.current?.abort()
        recoveryController.current = controller
        try {
          const latest = await roomDetail(
            input.snapshot.room.id,
            controller.signal
          )
          if (!isCurrentOperation(input.operationId, input.contextKey)) return
          setDeactivationFeedback({
            ...baseFeedback,
            message:
              latest.room.status === 'INACTIVE'
                ? 'The server has verified the room as inactive. We cannot determine whether this request caused the change; the verified state is shown below.'
                : 'The latest server state remains active. We cannot determine whether this request was applied; review the current state before deciding what to do.',
            latestSnapshot: latest,
          })
        } catch (reconciliationError) {
          if (!isCurrentOperation(input.operationId, input.contextKey)) return
          setDeactivationFeedback({
            ...baseFeedback,
            reconciliationError:
              normalizeCoreApiError(reconciliationError).message,
          })
        }
        return
      } else if (normalizedError.status === 404) {
        await queryClient.invalidateQueries({ queryKey: ['rooms'] })
      }
      if (isCurrentOperation(input.operationId, input.contextKey)) {
        setDeactivationFeedback(baseFeedback)
      }
    },
    onSettled: () => {
      mutationInFlight.current = false
    },
  })

  useEffect(() => {
    if (previousAccessKey.current === accessKey) return
    previousAccessKey.current = accessKey
    activeOperation.current = 0
    recoveryController.current?.abort()
    recoveryController.current = null
    setEditorSession(null)
    setDeactivationSession(null)
    setEditorFeedback(null)
    setDeactivationFeedback(null)
  }, [accessKey])

  useEffect(() => {
    if (!identityResolved || access.type !== 'authorized') return
    if (!sameSearch(search, constrainedSearch)) {
      onSearchChange(
        {
          q: constrainedSearch.q,
          status: constrainedSearch.status,
          sort: constrainedSearch.sort,
          page: constrainedSearch.page,
          size: constrainedSearch.size,
        },
        { replace: true }
      )
    }
  }, [access, constrainedSearch, identityResolved, onSearchChange, search])

  useEffect(() => {
    if (
      !directory.data ||
      directory.isPlaceholderData ||
      !directory.data.outOfRange
    ) {
      return
    }
    const page = Math.max(directory.data.pagination.totalPages - 1, 0)
    onSearchChange({ page }, { replace: true })
  }, [directory.data, directory.isPlaceholderData, onSearchChange])

  function nextOperationId() {
    recoveryController.current?.abort()
    recoveryController.current = null
    operationSequence.current += 1
    activeOperation.current = operationSequence.current
    setEditorSession(null)
    setDeactivationSession(null)
    setEditorFeedback(null)
    setDeactivationFeedback(null)
    return operationSequence.current
  }

  function openCreate() {
    if (!identityVerified || !canManage) return
    const operationId = nextOperationId()
    setEditorSession({
      operationId,
      contextKey: accessKey,
      mode: 'create',
      status: 'ready',
    })
  }

  function closeEditor() {
    recoveryController.current?.abort()
    recoveryController.current = null
    activeOperation.current = 0
    setEditorSession(null)
    setEditorFeedback(null)
  }

  function openEdit(room: Room) {
    if (!identityVerified || !canManage) return
    const operationId = nextOperationId()
    setEditorSession({
      operationId,
      contextKey: accessKey,
      mode: 'edit',
      roomId: room.id,
      status: 'loading',
    })
    void loadEditorSnapshot(room.id, operationId, accessKey)
  }

  async function loadEditorSnapshot(
    roomId: string,
    operationId: number,
    contextKey: string
  ) {
    try {
      const snapshot = await roomDetail(roomId)
      if (!isCurrentOperation(operationId, contextKey)) return
      if (snapshot.room.status !== 'ACTIVE') {
        setEditorSession({
          operationId,
          contextKey,
          mode: 'edit',
          roomId,
          status: 'error',
          loadError: 'This room is no longer active and cannot be edited.',
        })
        return
      }
      setEditorSession({
        operationId,
        contextKey,
        mode: 'edit',
        roomId,
        status: 'ready',
        snapshot,
      })
    } catch (error) {
      if (!isCurrentOperation(operationId, contextKey)) return
      setEditorSession({
        operationId,
        contextKey,
        mode: 'edit',
        roomId,
        status: 'error',
        loadError: normalizeCoreApiError(error).message,
      })
    }
  }

  function retryEditorSnapshot(roomId: string, operationId: number) {
    if (
      activeOperation.current !== operationId ||
      !identityVerified ||
      !editorSession ||
      editorSession.operationId !== operationId ||
      editorSession.contextKey !== accessKey
    ) {
      return
    }
    setEditorSession({
      operationId,
      contextKey: editorSession.contextKey,
      mode: 'edit',
      roomId,
      status: 'loading',
    })
    void loadEditorSnapshot(roomId, operationId, editorSession.contextKey)
  }

  function openDeactivation(room: Room) {
    if (!identityVerified || !canManage) return
    const operationId = nextOperationId()
    setDeactivationSession({
      operationId,
      contextKey: accessKey,
      roomId: room.id,
      phase: 'loading',
    })
    void loadDeactivationSnapshot(room.id, operationId, accessKey)
  }

  async function loadDeactivationSnapshot(
    roomId: string,
    operationId: number,
    contextKey: string
  ) {
    try {
      const snapshot = await roomDetail(roomId)
      if (!isCurrentOperation(operationId, contextKey)) return
      if (snapshot.room.status !== 'ACTIVE') {
        setDeactivationSession({
          operationId,
          contextKey,
          roomId,
          phase: 'error',
          loadError: 'This room is no longer active.',
        })
        return
      }
      setDeactivationSession({
        operationId,
        contextKey,
        roomId,
        phase: 'confirm',
        snapshot,
      })
    } catch (error) {
      if (!isCurrentOperation(operationId, contextKey)) return
      setDeactivationSession({
        operationId,
        contextKey,
        roomId,
        phase: 'error',
        loadError: normalizeCoreApiError(error).message,
      })
    }
  }

  function retryDeactivationSnapshot(roomId: string, operationId: number) {
    if (
      activeOperation.current !== operationId ||
      !identityVerified ||
      !deactivationSession ||
      deactivationSession.operationId !== operationId ||
      deactivationSession.contextKey !== accessKey
    ) {
      return
    }
    setDeactivationSession({
      operationId,
      contextKey: deactivationSession.contextKey,
      roomId,
      phase: 'loading',
    })
    void loadDeactivationSnapshot(
      roomId,
      operationId,
      deactivationSession.contextKey
    )
  }

  function closeDeactivation() {
    recoveryController.current?.abort()
    recoveryController.current = null
    activeOperation.current = 0
    setDeactivationSession(null)
    setDeactivationFeedback(null)
  }

  function restartEditorFromLatest(
    snapshot: RoomSnapshot,
    operationId: number
  ) {
    if (
      activeOperation.current !== operationId ||
      !editorSession ||
      editorSession.operationId !== operationId ||
      !identityVerified
    ) {
      return
    }
    const nextId = nextOperationId()
    setEditorSession({
      operationId: nextId,
      contextKey: editorSession.contextKey,
      mode: 'edit',
      roomId: snapshot.room.id,
      status: 'ready',
      snapshot,
    })
    setEditorFeedback(null)
  }

  function keepEditorDraftFromLatest(
    snapshot: RoomSnapshot,
    operationId: number
  ) {
    if (
      activeOperation.current !== operationId ||
      !editorSession ||
      editorSession.operationId !== operationId ||
      editorSession.mode !== 'edit' ||
      !identityVerified
    ) {
      return
    }
    setEditorSession({
      ...editorSession,
      status: 'ready',
      snapshot,
    })
    setEditorFeedback(null)
  }

  function restartDeactivationFromLatest(
    snapshot: RoomSnapshot,
    operationId: number
  ) {
    if (
      activeOperation.current !== operationId ||
      !deactivationSession ||
      deactivationSession.operationId !== operationId ||
      !identityVerified
    ) {
      return
    }
    const nextId = nextOperationId()
    setDeactivationSession({
      operationId: nextId,
      contextKey: deactivationSession.contextKey,
      roomId: snapshot.room.id,
      phase: 'confirm',
      snapshot,
    })
    setDeactivationFeedback(null)
  }

  function reviewCreationDraft(operationId: number) {
    if (
      activeOperation.current !== operationId ||
      !editorSession ||
      editorSession.mode !== 'create' ||
      editorSession.operationId !== operationId ||
      editorSession.contextKey !== accessKey ||
      !identityVerified
    ) {
      return
    }
    setEditorFeedback(null)
  }

  function handleEditorSubmit(input: RoomEditorSubmit) {
    if (
      !isCurrentOperation(input.operationId, input.contextKey) ||
      !currentAuthorization.current.identityVerified ||
      mutationInFlight.current ||
      mutation.isPending ||
      deactivationMutation.isPending
    ) {
      return
    }
    mutationInFlight.current = true
    setEditorFeedback(null)
    mutation.mutate(input)
  }

  function confirmDeactivation(snapshot: RoomSnapshot, operationId: number) {
    const contextKey = deactivationSession?.contextKey
    if (
      activeOperation.current !== operationId ||
      !contextKey ||
      !isCurrentOperation(operationId, contextKey) ||
      !currentAuthorization.current.identityVerified ||
      mutationInFlight.current ||
      deactivationMutation.isPending
    ) {
      return
    }
    mutationInFlight.current = true
    setDeactivationFeedback(null)
    deactivationMutation.mutate({ snapshot, operationId, contextKey })
  }

  async function loadLatestRoom(roomId: string): Promise<RoomSnapshot> {
    const operationId = activeOperation.current
    const contextKey = accessKey
    if (!identityVerified) {
      throw new Error('Verify room-management access before loading room data.')
    }
    const snapshot = await roomDetail(roomId)
    if (
      !isCurrentOperation(operationId, contextKey) ||
      !currentAuthorization.current.identityVerified
    ) {
      throw new Error(
        'The room operation context changed before the latest state was received.'
      )
    }
    return snapshot
  }

  const authorized = access.type === 'authorized' && identityResolved
  const canManage = authorized && access.canManage
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
              Browse room availability and maintain canonical room metadata.
            </p>
          </div>
          {canManage && (
            <Button disabled={!identityVerified} onClick={openCreate}>
              <Plus aria-hidden='true' className='size-4' />
              Add room
            </Button>
          )}
        </div>

        {!identityResolved ? (
          identity.isError ? (
            <RequestError
              error={identity.error}
              retry={() => void identity.refetch()}
            />
          ) : (
            <RequestLoading label='Verifying room-directory access…' />
          )
        ) : (
          <>
            {identity.data && !identityVerified && !identityDenied && (
              <div
                role='status'
                className='flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm'
              >
                <span>
                  {identity.isFetching
                    ? 'Verifying current room-management access. Existing directory and form state are preserved; submissions are paused.'
                    : 'Current room-management access could not be verified. Existing form state is preserved; verify access before submitting.'}
                </span>
                {!identity.isFetching && (
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => void identity.refetch()}
                  >
                    Retry verification
                  </Button>
                )}
              </div>
            )}
            {!canManage && (
              <p className='flex items-center gap-2 text-sm text-muted-foreground'>
                <ShieldAlert aria-hidden='true' className='size-4 shrink-0' />
                Room changes require administrator permission. Only active rooms
                are included in this catalog for assignment eligibility.
              </p>
            )}
            <Card className='overflow-hidden'>
              <CardHeader className='gap-4 border-b'>
                <div>
                  <CardTitle>Room directory</CardTitle>
                  <CardDescription className='mt-1'>
                    {canManage
                      ? 'Search and review active or inactive room records.'
                      : 'Search active room records eligible for meeting assignments. Status does not indicate real-time availability.'}
                  </CardDescription>
                </div>
                <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
                  <div className='relative sm:col-span-2'>
                    <Search
                      aria-hidden='true'
                      className='pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground'
                    />
                    <Input
                      value={searchDraft}
                      onChange={(event) =>
                        updateSearchDraft(event.target.value)
                      }
                      maxLength={200}
                      placeholder='Search room name or code'
                      aria-label='Search rooms'
                      className='pl-9'
                    />
                  </div>
                  {canManage && (
                    <>
                      <div className='space-y-1.5'>
                        <span className='text-xs font-medium text-muted-foreground'>
                          Lifecycle status
                        </span>
                        <Select
                          value={criteria.status ?? 'all'}
                          onValueChange={(value) =>
                            onSearchChange({
                              status:
                                value === 'all'
                                  ? undefined
                                  : (value as RoomStatus),
                            })
                          }
                        >
                          <SelectTrigger aria-label='Filter by room status'>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value='all'>All statuses</SelectItem>
                            <SelectItem value='ACTIVE'>Active</SelectItem>
                            <SelectItem value='INACTIVE'>Inactive</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className='space-y-1.5'>
                        <span className='text-xs font-medium text-muted-foreground'>
                          Sort rooms
                        </span>
                        <Select
                          value={criteria.sort}
                          onValueChange={(value) =>
                            onSearchChange({ sort: value as RoomSort })
                          }
                        >
                          <SelectTrigger aria-label='Sort rooms'>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {roomSortFields.flatMap((field) => [
                              <SelectItem
                                key={`${field},asc`}
                                value={`${field},asc`}
                              >
                                {roomSortLabels[field]} · ascending
                              </SelectItem>,
                              <SelectItem
                                key={`${field},desc`}
                                value={`${field},desc`}
                              >
                                {roomSortLabels[field]} · descending
                              </SelectItem>,
                            ])}
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  )}
                </div>
                <div className='flex flex-wrap items-center justify-between gap-3'>
                  <label className='flex items-center gap-2 text-sm text-muted-foreground'>
                    Rows per page
                    <Select
                      value={String(criteria.size)}
                      onValueChange={(value) =>
                        onSearchChange({ size: Number(value) })
                      }
                    >
                      <SelectTrigger
                        aria-label='Rows per page'
                        className='w-24'
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {!pageSizeChoices.includes(criteria.size) && (
                          <SelectItem value={String(criteria.size)}>
                            {criteria.size}
                          </SelectItem>
                        )}
                        {pageSizeChoices.map((size) => (
                          <SelectItem key={size} value={String(size)}>
                            {size}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  {directory.isFetching && !directory.isPending && (
                    <span
                      role='status'
                      className='text-xs text-muted-foreground'
                    >
                      Updating room results…
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardContent className='space-y-4 p-0'>
                {directory.isPending ? (
                  <RequestLoading label='Loading rooms…' />
                ) : directory.isError ? (
                  <div className='p-4'>
                    <RequestError
                      error={directory.error}
                      retry={() => void directory.refetch()}
                    />
                  </div>
                ) : directory.data.items.length === 0 ? (
                  <div className='p-4'>
                    <RequestEmpty
                      title={
                        criteria.q || criteria.status
                          ? 'No rooms match these filters'
                          : 'No rooms are found'
                      }
                      description='Try another search or adjust the room filters.'
                    />
                  </div>
                ) : (
                  <div className='overflow-x-auto'>
                    <Table className='min-w-[900px]'>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Code</TableHead>
                          <TableHead>Room</TableHead>
                          <TableHead>Location</TableHead>
                          <TableHead>Capacity</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Notes</TableHead>
                          {canManage && (
                            <TableHead className='text-end'>Actions</TableHead>
                          )}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {directory.data.items.map((room) => (
                          <TableRow key={room.id}>
                            <TableCell className='font-mono text-xs'>
                              {room.code}
                            </TableCell>
                            <TableCell className='min-w-40 font-medium'>
                              {room.name}
                            </TableCell>
                            <TableCell>
                              <RoomLocation room={room} />
                            </TableCell>
                            <TableCell>
                              <RoomCapacity room={room} />
                            </TableCell>
                            <TableCell>
                              <RoomStatusBadge status={room.status} />
                            </TableCell>
                            <TableCell className='max-w-60 whitespace-normal text-muted-foreground'>
                              {room.notes ?? '—'}
                            </TableCell>
                            {canManage && (
                              <TableCell className='text-end'>
                                <div className='flex justify-end gap-1'>
                                  {room.status === 'ACTIVE' && (
                                    <>
                                      <Button
                                        variant='ghost'
                                        size='sm'
                                        aria-label={`Edit ${room.name}`}
                                        disabled={!identityVerified}
                                        onClick={() => openEdit(room)}
                                      >
                                        <Pencil
                                          aria-hidden='true'
                                          className='size-4'
                                        />
                                        Edit
                                      </Button>
                                      <Button
                                        variant='ghost'
                                        size='sm'
                                        aria-label={`Deactivate ${room.name}`}
                                        disabled={
                                          !identityVerified ||
                                          deactivationMutation.isPending ||
                                          mutation.isPending
                                        }
                                        onClick={() => openDeactivation(room)}
                                      >
                                        Deactivate
                                      </Button>
                                    </>
                                  )}
                                </div>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {directory.data && (
                  <div className='flex flex-col gap-3 border-t px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between'>
                    <span>
                      {directory.data.pagination.totalElements}{' '}
                      {directory.data.pagination.totalElements === 1
                        ? 'room'
                        : 'rooms'}
                      {directory.isPlaceholderData && (
                        <span role='status'> · Updating results…</span>
                      )}
                    </span>
                    <div className='flex items-center justify-between gap-3 sm:justify-end'>
                      <span>
                        Page {directory.data.pagination.page + 1} of{' '}
                        {Math.max(directory.data.pagination.totalPages, 1)}
                      </span>
                      <div className='flex gap-2'>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={
                            directory.isPlaceholderData ||
                            !directory.data.pagination.hasPrevious
                          }
                          onClick={() =>
                            onSearchChange({
                              page: directory.data.pagination.page - 1,
                            })
                          }
                        >
                          Previous
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={
                            directory.isPlaceholderData ||
                            !directory.data.pagination.hasNext
                          }
                          onClick={() =>
                            onSearchChange({
                              page: directory.data.pagination.page + 1,
                            })
                          }
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {identityResolved && canManage && (
          <>
            <RoomEditorDialog
              key={
                editorSession?.contextKey === accessKey
                  ? [
                      editorSession.operationId,
                      editorSession.mode,
                      editorSession.status,
                    ].join(':')
                  : 'editor-closed'
              }
              session={
                editorSession?.contextKey === accessKey ? editorSession : null
              }
              saving={mutation.isPending}
              authorizationVerified={identityVerified}
              feedback={editorFeedback}
              onClose={closeEditor}
              onRetrySnapshot={retryEditorSnapshot}
              onLoadLatest={loadLatestRoom}
              onRestartFromLatest={restartEditorFromLatest}
              onReviewDirectory={closeEditor}
              onReviewCreationDraft={reviewCreationDraft}
              onKeepDraftFromLatest={keepEditorDraftFromLatest}
              onSubmit={handleEditorSubmit}
            />
            <RoomDeactivationDialog
              key={
                deactivationSession?.contextKey === accessKey
                  ? [
                      deactivationSession.operationId,
                      deactivationSession.phase,
                      deactivationSession.snapshot?.etag ?? '',
                    ].join(':')
                  : 'deactivation-closed'
              }
              session={
                deactivationSession?.contextKey === accessKey
                  ? deactivationSession
                  : null
              }
              saving={deactivationMutation.isPending}
              authorizationVerified={identityVerified}
              feedback={deactivationFeedback}
              onClose={closeDeactivation}
              onRetrySnapshot={retryDeactivationSnapshot}
              onLoadLatest={loadLatestRoom}
              onRestartFromLatest={restartDeactivationFromLatest}
              onConfirm={confirmDeactivation}
            />
          </>
        )}
      </Main>
    </>
  )
}
