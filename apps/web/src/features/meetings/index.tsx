import { useEffect, useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Link } from '@tanstack/react-router'
import {
  ArrowUpRight,
  CalendarDays,
  Clock3,
  MapPin,
  Plus,
  Radio,
  Search as SearchIcon,
  Users,
} from 'lucide-react'
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
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { Textarea } from '@/components/ui/textarea'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import {
  getMemberById,
  getRoomById,
  meetingRooms,
  meetings,
  members,
  type Meeting,
  type MeetingStatus,
} from './data'

const currentDemoUser =
  members.find((member) => member.id === 'member-nguyen-lan') ?? members[0]

const meetingStatusLabels: Record<MeetingStatus, string> = {
  scheduled: 'Upcoming',
  in_progress: 'Live',
  processing: 'Processing',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

const meetingStatusStyles: Record<MeetingStatus, string> = {
  scheduled:
    'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300',
  in_progress:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  processing:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  completed:
    'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300',
  cancelled:
    'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
}

const meetingStatusOptions: { label: string; value: MeetingStatus | 'all' }[] =
  [
    { label: 'All', value: 'all' },
    { label: 'Upcoming', value: 'scheduled' },
    { label: 'Live', value: 'in_progress' },
    { label: 'Processing', value: 'processing' },
    { label: 'Completed', value: 'completed' },
    { label: 'Cancelled', value: 'cancelled' },
  ]

const timeZone = 'Asia/Ho_Chi_Minh'
const meetingDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone,
})
const meetingTimeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone,
})

const meetingFormSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required.'),
    description: z
      .string()
      .max(500, 'Description must be 500 characters or fewer.'),
    date: z.string().min(1, 'Date is required.'),
    startTime: z.string().min(1, 'Start time is required.'),
    endTime: z.string().min(1, 'End time is required.'),
    roomId: z.string().min(1, 'Meeting room is required.'),
    participantIds: z
      .array(z.string())
      .min(1, 'Select at least one participant.'),
  })
  .refine(
    (values) =>
      !values.startTime || !values.endTime || values.endTime > values.startTime,
    {
      message: 'End time must be after start time.',
      path: ['endTime'],
    }
  )

type MeetingFormValues = z.infer<typeof meetingFormSchema>
type MeetingStatusFilter = MeetingStatus | 'all'

export function MeetingsPage() {
  const [meetingList, setMeetingList] = useState<Meeting[]>(() => [...meetings])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<MeetingStatusFilter>('all')
  const [isCreateOpen, setIsCreateOpen] = useState(false)

  const normalizedSearch = search.trim().toLocaleLowerCase()
  const filteredMeetings = meetingList.filter((meeting) => {
    const matchesSearch = meeting.title
      .toLocaleLowerCase()
      .includes(normalizedSearch)
    const matchesStatus =
      statusFilter === 'all' || meeting.status === statusFilter

    return matchesSearch && matchesStatus
  })

  const handleCreateMeeting = (meeting: Meeting) => {
    setMeetingList((currentMeetings) => [meeting, ...currentMeetings])
    setIsCreateOpen(false)
    toast.success('Meeting created', {
      description: `${meeting.title} is scheduled.`,
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
              Meeting management
            </p>
            <h1 className='mt-1 text-2xl font-bold tracking-tight sm:text-3xl'>
              Meetings
            </h1>
            <p className='mt-2 max-w-2xl text-muted-foreground'>
              Find a meeting, review its schedule, or create the next one for
              your team.
            </p>
          </div>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus />
                New Meeting
              </Button>
            </DialogTrigger>
            <NewMeetingDialogContent
              open={isCreateOpen}
              onCreate={handleCreateMeeting}
            />
          </Dialog>
        </div>

        <Card className='overflow-hidden'>
          <CardHeader className='border-b'>
            <div className='flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between'>
              <div>
                <CardTitle>All meetings</CardTitle>
                <CardDescription>
                  {meetingList.length} meeting
                  {meetingList.length === 1 ? '' : 's'} in the shared workspace.
                </CardDescription>
              </div>
              <p className='text-sm text-muted-foreground'>
                Showing {filteredMeetings.length} of {meetingList.length}
              </p>
            </div>
          </CardHeader>
          <CardContent className='p-0'>
            <div className='flex flex-col gap-3 border-b p-4 sm:flex-row'>
              <div className='relative flex-1'>
                <SearchIcon className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder='Search meeting titles...'
                  aria-label='Search meeting titles'
                  className='pl-9'
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(value) =>
                  setStatusFilter(value as MeetingStatusFilter)
                }
              >
                <SelectTrigger
                  className='w-full sm:w-44'
                  aria-label='Filter meetings by status'
                >
                  <SelectValue placeholder='Filter by status' />
                </SelectTrigger>
                <SelectContent>
                  {meetingStatusOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <MeetingsTable
              meetings={filteredMeetings}
              totalMeetings={meetingList.length}
            />
          </CardContent>
        </Card>
      </Main>
    </>
  )
}

function MeetingsTable({
  meetings: meetingRows,
  totalMeetings,
}: {
  meetings: Meeting[]
  totalMeetings: number
}) {
  if (!totalMeetings) {
    return (
      <EmptyState
        title='No meetings yet.'
        description='Create your first meeting.'
      />
    )
  }

  if (!meetingRows.length) {
    return (
      <EmptyState
        title='No meetings found.'
        description='Try adjusting your search or status filter.'
      />
    )
  }

  return (
    <Table className='min-w-[760px]'>
      <TableHeader>
        <TableRow>
          <TableHead className='w-[30%]'>Meeting</TableHead>
          <TableHead>Schedule</TableHead>
          <TableHead>Room</TableHead>
          <TableHead>Participants</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className='text-end'>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {meetingRows.map((meeting) => (
          <MeetingRow key={meeting.id} meeting={meeting} />
        ))}
      </TableBody>
    </Table>
  )
}

function MeetingRow({ meeting }: { meeting: Meeting }) {
  const organizer = getMemberById(meeting.organizerId)
  const room = getRoomById(meeting.roomId)

  return (
    <TableRow>
      <TableCell className='whitespace-normal'>
        <div className='min-w-48 space-y-1'>
          <Link
            to='/meetings/$meetingId'
            params={{ meetingId: meeting.id }}
            className='font-medium hover:underline'
          >
            {meeting.title}
          </Link>
          <p className='text-xs text-muted-foreground'>
            Organized by {organizer?.name ?? 'Unknown organizer'}
          </p>
        </div>
      </TableCell>
      <TableCell>
        <div className='flex items-start gap-2'>
          <CalendarDays className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
          <span>{formatMeetingSchedule(meeting)}</span>
        </div>
      </TableCell>
      <TableCell>
        <div className='flex items-start gap-2'>
          <MapPin className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
          <span>{room?.name ?? 'Room TBD'}</span>
        </div>
      </TableCell>
      <TableCell className='max-w-56 whitespace-normal'>
        <div className='flex items-start gap-2'>
          <Users className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
          <span>{formatParticipantNames(meeting)}</span>
        </div>
      </TableCell>
      <TableCell>
        <MeetingStatusBadge status={meeting.status} />
      </TableCell>
      <TableCell className='text-end'>
        <div className='flex justify-end gap-1'>
          {meeting.status === 'in_progress' && (
            <Button asChild variant='outline' size='sm'>
              <Link
                to='/meetings/$meetingId/live'
                params={{ meetingId: meeting.id }}
              >
                <Radio />
                Live
              </Link>
            </Button>
          )}
          <Button asChild variant='ghost' size='sm'>
            <Link
              to='/meetings/$meetingId'
              params={{ meetingId: meeting.id }}
              aria-label={`View ${meeting.title}`}
            >
              View
              <ArrowUpRight />
            </Link>
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

function MeetingStatusBadge({ status }: { status: MeetingStatus }) {
  return (
    <Badge variant='outline' className={meetingStatusStyles[status]}>
      {meetingStatusLabels[status]}
    </Badge>
  )
}

function EmptyState({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className='flex min-h-56 flex-col items-center justify-center gap-1 px-4 text-center'>
      <p className='font-medium'>{title}</p>
      <p className='text-sm text-muted-foreground'>{description}</p>
    </div>
  )
}

type NewMeetingDialogContentProps = {
  open: boolean
  onCreate: (meeting: Meeting) => void
}

function NewMeetingDialogContent({
  open,
  onCreate,
}: NewMeetingDialogContentProps) {
  const form = useForm<MeetingFormValues>({
    resolver: zodResolver(meetingFormSchema),
    defaultValues: getDefaultMeetingFormValues(),
  })

  useEffect(() => {
    if (!open) {
      form.reset(getDefaultMeetingFormValues())
    }
  }, [form, open])

  const onSubmit = (values: MeetingFormValues) => {
    const newMeeting: Meeting = {
      id: createMeetingId(values),
      title: values.title,
      description: values.description.trim(),
      status: 'scheduled',
      startsAt: `${values.date}T${values.startTime}:00+07:00`,
      endsAt: `${values.date}T${values.endTime}:00+07:00`,
      organizerId: currentDemoUser.id,
      participantIds: values.participantIds,
      roomId: values.roomId,
    }

    onCreate(newMeeting)
    form.reset(getDefaultMeetingFormValues())
  }

  return (
    <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
      <DialogHeader>
        <DialogTitle>New Meeting</DialogTitle>
        <DialogDescription>
          Schedule a meeting with your team using the shared members and rooms.
        </DialogDescription>
      </DialogHeader>

      <Form {...form}>
        <form
          id='new-meeting-form'
          onSubmit={form.handleSubmit(onSubmit)}
          className='space-y-4'
        >
          <FormField
            control={form.control}
            name='title'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Title</FormLabel>
                <FormControl>
                  <Input {...field} placeholder='e.g. Weekly product sync' />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name='description'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    placeholder='What should the team accomplish?'
                    rows={3}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className='grid gap-4 sm:grid-cols-3'>
            <FormField
              control={form.control}
              name='date'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Date</FormLabel>
                  <FormControl>
                    <Input {...field} type='date' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='startTime'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Start time</FormLabel>
                  <FormControl>
                    <Input {...field} type='time' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='endTime'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>End time</FormLabel>
                  <FormControl>
                    <Input {...field} type='time' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name='roomId'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Meeting room</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder='Select a meeting room' />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {meetingRooms.map((room) => (
                      <SelectItem key={room.id} value={room.id}>
                        {room.name} · {room.location}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name='participantIds'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Participants</FormLabel>
                <FormControl>
                  <div
                    role='group'
                    aria-label='Participants'
                    className='grid max-h-48 gap-2 overflow-y-auto rounded-md border p-3 sm:grid-cols-2'
                  >
                    {members.map((member) => {
                      const checked = field.value.includes(member.id)

                      return (
                        <label
                          key={member.id}
                          className='flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted/60'
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(value) => {
                              const participantIds =
                                value === true
                                  ? Array.from(
                                      new Set([...field.value, member.id])
                                    )
                                  : field.value.filter((id) => id !== member.id)
                              field.onChange(participantIds)
                            }}
                          />
                          <span className='min-w-0'>
                            <span className='block text-sm font-medium'>
                              {member.name}
                            </span>
                            <span className='block truncate text-xs text-muted-foreground'>
                              {member.department}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <p className='flex items-center gap-2 text-sm text-muted-foreground'>
            <Clock3 className='size-4' />
            Organizer:{' '}
            <span className='font-medium text-foreground'>
              {currentDemoUser.name}
            </span>
          </p>
        </form>
      </Form>

      <DialogFooter>
        <DialogClose asChild>
          <Button type='button' variant='outline'>
            Cancel
          </Button>
        </DialogClose>
        <Button type='submit' form='new-meeting-form'>
          Create Meeting
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function getDefaultMeetingFormValues(): MeetingFormValues {
  const defaultRoom =
    meetingRooms.find((room) => room.status === 'available') ?? meetingRooms[0]

  return {
    title: '',
    description: '',
    date: '',
    startTime: '',
    endTime: '',
    roomId: defaultRoom.id,
    participantIds: [currentDemoUser.id],
  }
}

function createMeetingId(values: MeetingFormValues) {
  const titleSlug = values.title
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  return `meeting-${values.date}-${values.startTime.replace(':', '')}-${titleSlug || 'new'}`
}

function formatMeetingSchedule(meeting: Meeting) {
  const startsAt = new Date(meeting.startsAt)
  const endsAt = new Date(meeting.endsAt)

  return `${meetingDateFormatter.format(startsAt)} · ${meetingTimeFormatter.format(startsAt)} - ${meetingTimeFormatter.format(endsAt)}`
}

function formatParticipantNames(meeting: Meeting) {
  const names = meeting.participantIds
    .map((memberId) => getMemberById(memberId)?.name)
    .filter((name): name is string => Boolean(name))

  if (!names.length) {
    return 'No participants listed'
  }

  const visibleNames = names.slice(0, 2).join(', ')
  return names.length > 2
    ? `${visibleNames} +${names.length - 2} more`
    : visibleNames
}
