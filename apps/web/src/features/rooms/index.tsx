import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Search, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  createRoom,
  deactivateRoom,
  roomDetail,
  roomsQuery,
  updateRoom,
  type Room,
} from './room-api'

type Draft = {
  code: string
  name: string
  location: string
  capacity: string
  notes: string
}
const blank: Draft = {
  code: '',
  name: '',
  location: '',
  capacity: '',
  notes: '',
}
function toDraft(room: Room | null): Draft {
  return room
    ? {
        code: room.code,
        name: room.name,
        location: room.location ?? '',
        capacity: room.capacity == null ? '' : String(room.capacity),
        notes: room.notes ?? '',
      }
    : { ...blank }
}

export function RoomsPage() {
  const qc = useQueryClient()
  const identity = useQuery(currentUserQueryOptions())
  const canManage = identity.data?.globalRole === 'ADMINISTRATOR'
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const query = useQuery(roomsQuery(page, search))
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Room | null>(null)
  const [draft, setDraft] = useState<Draft>(blank)
  const [busy, setBusy] = useState(false)
  const mutation = useMutation({
    mutationFn: async (data: Draft) => {
      const payload = {
        code: data.code.trim(),
        name: data.name.trim(),
        location: data.location.trim() || null,
        capacity: data.capacity ? Number(data.capacity) : null,
        notes: data.notes.trim() || null,
      }
      if (!selected) return createRoom(payload)
      const fresh = await roomDetail(selected.id)
      return updateRoom(
        selected.id,
        {
          name: payload.name,
          location: payload.location,
          capacity: payload.capacity,
          notes: payload.notes,
        },
        fresh.etag
      )
    },
    onSuccess: () => {
      toast.success('Room saved')
      setOpen(false)
      void qc.invalidateQueries({ queryKey: ['rooms'] })
    },
    onError: (error) =>
      toast.error('Room could not be saved', {
        description: error instanceof Error ? error.message : undefined,
      }),
  })
  function edit(room: Room | null) {
    setSelected(room)
    setDraft(toDraft(room))
    setOpen(true)
  }
  async function deactivate(room: Room) {
    if (
      !window.confirm(
        'Deactivate this room? Historical meeting references will remain.'
      )
    )
      return
    setBusy(true)
    try {
      const fresh = await roomDetail(room.id)
      await deactivateRoom(room.id, fresh.etag)
      toast.success('Room deactivated')
      await qc.invalidateQueries({ queryKey: ['rooms'] })
    } catch (error) {
      toast.error('Unable to deactivate room', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusy(false)
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!draft.name.trim() || (!selected && !draft.code.trim())) return
    if (
      draft.capacity &&
      (!Number.isInteger(Number(draft.capacity)) || Number(draft.capacity) <= 0)
    ) {
      toast.error('Capacity must be a positive integer')
      return
    }
    mutation.mutate(draft)
  }
  return (
    <>
      <Header fixed>
        <HeaderActions />
      </Header>
      <Main className='space-y-6'>
        <div className='flex flex-wrap items-end justify-between gap-4'>
          <div>
            <p className='text-sm font-medium text-primary'>
              Meeting operations
            </p>
            <h1 className='text-3xl font-bold'>Meeting Rooms</h1>
            <p className='text-muted-foreground'>
              Rooms and their current administrative availability.
            </p>
          </div>
          {canManage && (
            <Button onClick={() => edit(null)}>
              <Plus className='size-4' /> Add room
            </Button>
          )}
        </div>
        {!canManage && (
          <p className='flex items-center gap-2 text-sm text-muted-foreground'>
            <ShieldAlert className='size-4' /> Room changes require
            administrator permission.
          </p>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Room directory</CardTitle>
            <form
              className='flex gap-2'
              onSubmit={(event) => {
                event.preventDefault()
                setPage(0)
                setSearch(q.trim())
              }}
            >
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder='Search room name or code'
                aria-label='Search rooms'
              />
              <Button type='submit' variant='secondary'>
                <Search className='size-4' /> Search
              </Button>
            </form>
          </CardHeader>
          <CardContent className='space-y-4'>
            {query.isPending ? (
              <RequestLoading />
            ) : query.isError ? (
              <RequestError
                error={query.error}
                retry={() => void query.refetch()}
              />
            ) : query.data.items.length === 0 ? (
              <RequestEmpty title='No rooms match this search' />
            ) : (
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Room</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Capacity</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Notes</TableHead>
                      {canManage && <TableHead>Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {query.data.items.map((room) => (
                      <TableRow key={room.id}>
                        <TableCell className='font-mono text-xs'>
                          {room.code}
                        </TableCell>
                        <TableCell className='font-medium'>
                          {room.name}
                        </TableCell>
                        <TableCell>{room.location || '—'}</TableCell>
                        <TableCell>{room.capacity ?? '—'}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              room.status === 'ACTIVE' ? 'secondary' : 'outline'
                            }
                          >
                            {room.status}
                          </Badge>
                        </TableCell>
                        <TableCell className='max-w-60 truncate'>
                          {room.notes ?? '—'}
                        </TableCell>
                        {canManage && (
                          <TableCell>
                            <div className='flex gap-1'>
                              <Button
                                variant='outline'
                                size='sm'
                                onClick={() => edit(room)}
                              >
                                <Pencil className='size-3' /> Edit
                              </Button>
                              {room.status === 'ACTIVE' && (
                                <Button
                                  disabled={busy}
                                  variant='ghost'
                                  size='sm'
                                  onClick={() => void deactivate(room)}
                                >
                                  Deactivate
                                </Button>
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
            {query.data && (
              <div className='flex items-center justify-between text-sm text-muted-foreground'>
                <span>{query.data.page.totalElements} room(s)</span>
                <div className='flex gap-2'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!query.data.page.hasPrevious}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <span className='py-2'>Page {page + 1}</span>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!query.data.page.hasNext}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{selected ? 'Edit room' : 'Add room'}</DialogTitle>
              <DialogDescription>
                Changes are persisted to the Core API. Room codes cannot be
                edited after creation.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className='space-y-4'>
              <div className='space-y-1'>
                <Label htmlFor='room-code'>Room code</Label>
                <Input
                  id='room-code'
                  maxLength={64}
                  required
                  disabled={Boolean(selected)}
                  value={draft.code}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, code: e.target.value }))
                  }
                />
              </div>
              <div className='space-y-1'>
                <Label htmlFor='room-name'>Name</Label>
                <Input
                  id='room-name'
                  maxLength={160}
                  required
                  value={draft.name}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, name: e.target.value }))
                  }
                />
              </div>
              <div className='space-y-1'>
                <Label htmlFor='room-location'>Location</Label>
                <Input
                  id='room-location'
                  maxLength={255}
                  value={draft.location}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, location: e.target.value }))
                  }
                />
              </div>
              <div className='space-y-1'>
                <Label htmlFor='room-capacity'>Capacity</Label>
                <Input
                  id='room-capacity'
                  type='number'
                  min={1}
                  step={1}
                  value={draft.capacity}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, capacity: e.target.value }))
                  }
                />
              </div>
              <div className='space-y-1'>
                <Label htmlFor='room-notes'>Notes</Label>
                <Input
                  id='room-notes'
                  value={draft.notes}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, notes: e.target.value }))
                  }
                />
              </div>
              <DialogFooter>
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button type='submit' disabled={mutation.isPending}>
                  Save room
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </Main>
    </>
  )
}
