import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MapPin, Pencil, Plus, Search, ShieldAlert, Users } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeCoreApiError } from '@/lib/core-api'
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
  const identityResolved = identity.isSuccess
  const access = getRoomDirectoryAccess(
    identityResolved ? identity.data : undefined
  )
  const constrainedSearch =
    access.type === 'authorized'
      ? constrainRoomSearch(search, identity.data)
      : normalizeRoomSearch(search)
  const criteria = resolveRoomDirectoryCriteria(constrainedSearch)
  const directory = useQuery(roomsQuery(criteria, access))
  const [searchDraftState, setSearchDraftState] = useState(() => ({
    criteria: criteria.q ?? '',
    value: criteria.q ?? '',
  }))
  const searchDraft =
    searchDraftState.criteria === (criteria.q ?? '')
      ? searchDraftState.value
      : (criteria.q ?? '')
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
  const mutation = useMutation({
    mutationFn: async (input: RoomEditorSubmit) => {
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
      if (activeOperation.current !== input.operationId) return
      await synchronizeRoomCaches(queryClient, result.mutation)
      if (activeOperation.current !== input.operationId) return
      toast.success(
        result.mutation === 'created' ? 'Room created' : 'Room updated'
      )
      activeOperation.current = 0
      setEditorSession(null)
      setEditorFeedback(null)
    },
    onError: async (error, input) => {
      if (activeOperation.current !== input.operationId) return
      const outcome = classifyRoomMutationOutcome(error)
      const normalizedError = normalizeCoreApiError(error)
      setEditorFeedback({
        outcome,
        message: roomOperationErrorMessage(
          error,
          input.mode === 'create' ? 'create' : 'edit'
        ),
        fieldErrors: normalizedError.fieldErrors,
      })
      if (outcome === 'uncertain' || outcome === 'unknown') {
        await synchronizeRoomCaches(
          queryClient,
          input.mode === 'create' ? 'created' : 'updated'
        )
      } else if (normalizedError.status === 404) {
        await queryClient.invalidateQueries({ queryKey: ['rooms'] })
      }
    },
  })
  const deactivationMutation = useMutation({
    mutationFn: async ({
      snapshot,
    }: {
      snapshot: RoomSnapshot
      operationId: number
    }) => deactivateRoom(snapshot.room.id, snapshot.etag),
    onSuccess: async (_result, input) => {
      if (activeOperation.current !== input.operationId) return
      await synchronizeRoomCaches(queryClient, 'deactivated')
      if (activeOperation.current !== input.operationId) return
      toast.success('Room deactivated')
      activeOperation.current = 0
      setDeactivationSession(null)
      setDeactivationFeedback(null)
    },
    onError: async (error, input) => {
      if (activeOperation.current !== input.operationId) return
      const outcome = classifyRoomMutationOutcome(error)
      const normalizedError = normalizeCoreApiError(error)
      setDeactivationFeedback({
        outcome,
        message: roomOperationErrorMessage(error, 'deactivate'),
        fieldErrors: normalizedError.fieldErrors,
      })
      if (outcome === 'uncertain' || outcome === 'unknown') {
        await synchronizeRoomCaches(queryClient, 'deactivated')
      } else if (normalizedError.status === 404) {
        await queryClient.invalidateQueries({ queryKey: ['rooms'] })
      }
    },
  })

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

  useEffect(() => {
    const nextQuery = normalizeRoomSearch({ q: searchDraft }).q
    if (nextQuery === criteria.q) return
    const timer = window.setTimeout(() => {
      onSearchChange({ q: nextQuery }, { replace: true })
    }, searchDebounceMs)
    return () => window.clearTimeout(timer)
  }, [criteria.q, onSearchChange, searchDraft])

  function nextOperationId() {
    operationSequence.current += 1
    activeOperation.current = operationSequence.current
    setEditorFeedback(null)
    setDeactivationFeedback(null)
    return operationSequence.current
  }

  function openCreate() {
    const operationId = nextOperationId()
    setEditorSession({ operationId, mode: 'create', status: 'ready' })
  }

  function closeEditor() {
    activeOperation.current = 0
    setEditorSession(null)
    setEditorFeedback(null)
  }

  function openEdit(room: Room) {
    const operationId = nextOperationId()
    setEditorSession({
      operationId,
      mode: 'edit',
      roomId: room.id,
      status: 'loading',
    })
    void loadEditorSnapshot(room.id, operationId)
  }

  async function loadEditorSnapshot(roomId: string, operationId: number) {
    try {
      const snapshot = await roomDetail(roomId)
      if (activeOperation.current !== operationId) return
      if (snapshot.room.status !== 'ACTIVE') {
        setEditorSession({
          operationId,
          mode: 'edit',
          roomId,
          status: 'error',
          loadError: 'This room is no longer active and cannot be edited.',
        })
        return
      }
      setEditorSession({
        operationId,
        mode: 'edit',
        roomId,
        status: 'ready',
        snapshot,
      })
    } catch (error) {
      if (activeOperation.current !== operationId) return
      setEditorSession({
        operationId,
        mode: 'edit',
        roomId,
        status: 'error',
        loadError: normalizeCoreApiError(error).message,
      })
    }
  }

  function retryEditorSnapshot(roomId: string, operationId: number) {
    if (activeOperation.current !== operationId) return
    setEditorSession({
      operationId,
      mode: 'edit',
      roomId,
      status: 'loading',
    })
    void loadEditorSnapshot(roomId, operationId)
  }

  function openDeactivation(room: Room) {
    const operationId = nextOperationId()
    setDeactivationSession({
      operationId,
      roomId: room.id,
      phase: 'loading',
    })
    void loadDeactivationSnapshot(room.id, operationId)
  }

  async function loadDeactivationSnapshot(roomId: string, operationId: number) {
    try {
      const snapshot = await roomDetail(roomId)
      if (activeOperation.current !== operationId) return
      if (snapshot.room.status !== 'ACTIVE') {
        setDeactivationSession({
          operationId,
          roomId,
          phase: 'error',
          loadError: 'This room is no longer active.',
        })
        return
      }
      setDeactivationSession({
        operationId,
        roomId,
        phase: 'confirm',
        snapshot,
      })
    } catch (error) {
      if (activeOperation.current !== operationId) return
      setDeactivationSession({
        operationId,
        roomId,
        phase: 'error',
        loadError: normalizeCoreApiError(error).message,
      })
    }
  }

  function retryDeactivationSnapshot(roomId: string, operationId: number) {
    if (activeOperation.current !== operationId) return
    setDeactivationSession({ operationId, roomId, phase: 'loading' })
    void loadDeactivationSnapshot(roomId, operationId)
  }

  function closeDeactivation() {
    activeOperation.current = 0
    setDeactivationSession(null)
    setDeactivationFeedback(null)
  }

  function restartEditorFromLatest(
    snapshot: RoomSnapshot,
    operationId: number
  ) {
    if (activeOperation.current !== operationId) return
    setEditorSession({
      operationId,
      mode: 'edit',
      roomId: snapshot.room.id,
      status: 'ready',
      snapshot,
    })
    setEditorFeedback(null)
  }

  function restartDeactivationFromLatest(
    snapshot: RoomSnapshot,
    operationId: number
  ) {
    if (activeOperation.current !== operationId) return
    setDeactivationSession({
      operationId,
      roomId: snapshot.room.id,
      phase: 'confirm',
      snapshot,
    })
    setDeactivationFeedback(null)
  }

  function handleEditorSubmit(input: RoomEditorSubmit) {
    if (activeOperation.current !== input.operationId || mutation.isPending) {
      return
    }
    setEditorFeedback(null)
    mutation.mutate(input)
  }

  function confirmDeactivation(snapshot: RoomSnapshot, operationId: number) {
    if (
      activeOperation.current !== operationId ||
      deactivationMutation.isPending
    ) {
      return
    }
    setDeactivationFeedback(null)
    deactivationMutation.mutate({ snapshot, operationId })
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
            <Button onClick={openCreate}>
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
            {!canManage && (
              <p className='flex items-center gap-2 text-sm text-muted-foreground'>
                <ShieldAlert aria-hidden='true' className='size-4 shrink-0' />
                Room changes require administrator permission. Only active rooms
                are available in this directory.
              </p>
            )}
            <Card className='overflow-hidden'>
              <CardHeader className='gap-4 border-b'>
                <div>
                  <CardTitle>Room directory</CardTitle>
                  <CardDescription className='mt-1'>
                    {canManage
                      ? 'Search and review active or inactive room records.'
                      : 'Search rooms currently available for meeting assignments.'}
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
                        setSearchDraftState({
                          criteria: criteria.q ?? '',
                          value: event.target.value,
                        })
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
                          : 'No rooms are available'
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
                editorSession
                  ? [
                      editorSession.operationId,
                      editorSession.mode,
                      editorSession.status,
                      editorSession.mode === 'edit'
                        ? (editorSession.snapshot?.etag ?? '')
                        : '',
                    ].join(':')
                  : 'editor-closed'
              }
              session={editorSession}
              saving={mutation.isPending}
              feedback={editorFeedback}
              onClose={closeEditor}
              onRetrySnapshot={retryEditorSnapshot}
              onLoadLatest={roomDetail}
              onRestartFromLatest={restartEditorFromLatest}
              onReviewDirectory={closeEditor}
              onSubmit={handleEditorSubmit}
            />
            <RoomDeactivationDialog
              key={
                deactivationSession
                  ? [
                      deactivationSession.operationId,
                      deactivationSession.phase,
                      deactivationSession.snapshot?.etag ?? '',
                    ].join(':')
                  : 'deactivation-closed'
              }
              session={deactivationSession}
              saving={deactivationMutation.isPending}
              feedback={deactivationFeedback}
              onClose={closeDeactivation}
              onRetrySnapshot={retryDeactivationSnapshot}
              onLoadLatest={roomDetail}
              onRestartFromLatest={restartDeactivationFromLatest}
              onConfirm={confirmDeactivation}
            />
          </>
        )}
      </Main>
    </>
  )
}
