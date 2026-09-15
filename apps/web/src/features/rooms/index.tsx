import { useEffect, useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { DoorOpen, MapPin, Pencil, Plus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
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
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import {
  meetingRooms,
  type MeetingRoom,
  type MeetingRoomStatus,
} from '@/features/meetings/data'

const roomStatusLabels: Record<MeetingRoomStatus, string> = {
  available: 'Available',
  occupied: 'Occupied',
  maintenance: 'Maintenance',
}

const roomStatusStyles: Record<MeetingRoomStatus, string> = {
  available:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  occupied:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  maintenance:
    'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300',
}

const roomStatusOptions: { label: string; value: MeetingRoomStatus }[] = [
  { label: 'Available', value: 'available' },
  { label: 'Occupied', value: 'occupied' },
  { label: 'Maintenance', value: 'maintenance' },
]

const roomFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.'),
  location: z.string().trim().min(1, 'Location is required.'),
  capacity: z
    .string()
    .trim()
    .min(1, 'Capacity is required.')
    .regex(/^\d+$/, 'Capacity must be a whole number.')
    .refine(
      (value) => Number(value) > 0,
      'Capacity must be greater than zero.'
    ),
  status: z.enum(['available', 'occupied', 'maintenance']),
  equipment: z.string().max(300, 'Equipment must be 300 characters or fewer.'),
})

type RoomFormValues = z.infer<typeof roomFormSchema>

export function RoomsPage() {
  const [roomList, setRoomList] = useState<MeetingRoom[]>(() => [
    ...meetingRooms,
  ])
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingRoom, setEditingRoom] = useState<MeetingRoom | null>(null)

  const openAddDialog = () => {
    setEditingRoom(null)
    setIsDialogOpen(true)
  }

  const openEditDialog = (room: MeetingRoom) => {
    setEditingRoom(room)
    setIsDialogOpen(true)
  }

  const saveRoom = (room: MeetingRoom) => {
    const isEditing = roomList.some((currentRoom) => currentRoom.id === room.id)

    setRoomList((currentRooms) => {
      if (isEditing) {
        return currentRooms.map((currentRoom) =>
          currentRoom.id === room.id ? room : currentRoom
        )
      }

      return [...currentRooms, room]
    })
    setIsDialogOpen(false)
    toast.success(isEditing ? 'Room updated' : 'Room added', {
      description: `${room.name} is ready in the room list.`,
    })
  }

  return (
    <>
      <Header fixed>
        <Search className='me-auto' />
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
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
              Keep the shared spaces used by your meetings easy to find.
            </p>
          </div>
          <Button onClick={openAddDialog}>
            <Plus />
            Add Room
          </Button>
        </div>

        <Card className='overflow-hidden'>
          <CardHeader className='border-b'>
            <CardTitle>Room directory</CardTitle>
            <CardDescription>
              {roomList.length} meeting room
              {roomList.length === 1 ? '' : 's'} in the shared workspace.
            </CardDescription>
          </CardHeader>
          <CardContent className='p-0'>
            {roomList.length ? (
              <div className='overflow-x-auto'>
                <Table className='min-w-[820px]'>
                  <TableHeader>
                    <TableRow>
                      <TableHead className='w-[25%]'>Name</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Capacity</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className='w-[28%]'>Equipment</TableHead>
                      <TableHead className='text-end'>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {roomList.map((room) => (
                      <TableRow key={room.id}>
                        <TableCell className='whitespace-normal'>
                          <div className='flex min-w-44 items-center gap-3'>
                            <div className='flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary'>
                              <DoorOpen className='size-4' />
                            </div>
                            <span className='font-medium'>{room.name}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className='flex items-start gap-2 whitespace-normal'>
                            <MapPin className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
                            <span>{room.location}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className='flex items-center gap-2 whitespace-nowrap'>
                            <Users className='size-4 text-muted-foreground' />
                            {room.capacity} people
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant='outline'
                            className={roomStatusStyles[room.status]}
                          >
                            {roomStatusLabels[room.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className='whitespace-normal'>
                          {room.equipment.length ? (
                            <div className='flex max-w-64 flex-wrap gap-1.5'>
                              {room.equipment.map((item) => (
                                <Badge key={item} variant='secondary'>
                                  {item}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className='text-sm text-muted-foreground'>
                              No equipment listed
                            </span>
                          )}
                        </TableCell>
                        <TableCell className='text-end'>
                          <Button
                            variant='ghost'
                            size='sm'
                            onClick={() => openEditDialog(room)}
                            aria-label={`Edit ${room.name}`}
                          >
                            <Pencil />
                            Edit
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyState />
            )}
          </CardContent>
        </Card>
      </Main>

      <RoomDialog
        open={isDialogOpen}
        room={editingRoom}
        onOpenChange={setIsDialogOpen}
        onSave={saveRoom}
      />
    </>
  )
}

function RoomDialog({
  open,
  room,
  onOpenChange,
  onSave,
}: {
  open: boolean
  room: MeetingRoom | null
  onOpenChange: (open: boolean) => void
  onSave: (room: MeetingRoom) => void
}) {
  const form = useForm<RoomFormValues>({
    resolver: zodResolver(roomFormSchema),
    defaultValues: getRoomFormValues(),
  })

  useEffect(() => {
    if (open) {
      form.reset(getRoomFormValues(room))
    }
  }, [form, open, room])

  const onSubmit = (values: RoomFormValues) => {
    onSave({
      id: room?.id ?? createRoomId(values.name),
      name: values.name.trim(),
      location: values.location.trim(),
      capacity: Number(values.capacity),
      status: values.status,
      equipment: values.equipment
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    })
  }

  const isEditing = Boolean(room)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] overflow-y-auto'>
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Room' : 'Add Room'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Update the room details used by your meeting schedule.'
              : 'Add a shared meeting space to the room directory.'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            id='room-form'
            onSubmit={form.handleSubmit(onSubmit)}
            className='space-y-4'
          >
            <FormField
              control={form.control}
              name='name'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder='e.g. Phòng Hoa Sen' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='location'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Location</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder='e.g. Tầng 4, Tòa nhà A' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className='grid gap-4 sm:grid-cols-2'>
              <FormField
                control={form.control}
                name='capacity'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Capacity</FormLabel>
                    <FormControl>
                      <Input {...field} type='number' min='1' />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='status'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {roomStatusOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name='equipment'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Equipment</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder='Separate items with commas'
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>

        <DialogFooter>
          <DialogClose asChild>
            <Button type='button' variant='outline'>
              Cancel
            </Button>
          </DialogClose>
          <Button type='submit' form='room-form'>
            {isEditing ? 'Save Changes' : 'Add Room'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EmptyState() {
  return (
    <div className='flex min-h-56 flex-col items-center justify-center gap-1 px-4 text-center'>
      <DoorOpen className='size-8 text-muted-foreground' />
      <p className='mt-2 font-medium'>No meeting rooms found.</p>
      <p className='text-sm text-muted-foreground'>
        Add a room to start the directory.
      </p>
    </div>
  )
}

function getRoomFormValues(room?: MeetingRoom | null): RoomFormValues {
  return {
    name: room?.name ?? '',
    location: room?.location ?? '',
    capacity: String(room?.capacity ?? 8),
    status: room?.status ?? 'available',
    equipment: room?.equipment.join(', ') ?? '',
  }
}

function createRoomId(name: string) {
  const slug = name
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  return `room-${slug || 'new'}-${Date.now()}`
}
