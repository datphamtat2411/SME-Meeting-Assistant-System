import { useEffect, useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Pencil, Plus, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { getDisplayNameInitials } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
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
  members,
  type Member,
  type MemberRole,
  type MemberStatus,
} from '@/features/meetings/data'

const memberRoleLabels: Record<MemberRole, string> = {
  employee: 'Employee',
  manager: 'Manager',
  admin: 'Admin',
}

const memberStatusLabels: Record<MemberStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  invited: 'Invited',
}

const memberStatusStyles: Record<MemberStatus, string> = {
  active:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  inactive:
    'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300',
  invited:
    'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300',
}

const memberFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.'),
  email: z
    .string()
    .trim()
    .min(1, 'Email is required.')
    .email('Enter a valid email.'),
  department: z.string().trim().min(1, 'Department is required.'),
  role: z.enum(['employee', 'manager', 'admin']),
  status: z.enum(['active', 'inactive', 'invited']),
})

type MemberFormValues = z.infer<typeof memberFormSchema>

export function MembersPage() {
  const [memberList, setMemberList] = useState<Member[]>(() => [...members])
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingMember, setEditingMember] = useState<Member | null>(null)

  const openAddDialog = () => {
    setEditingMember(null)
    setIsDialogOpen(true)
  }

  const openEditDialog = (member: Member) => {
    setEditingMember(member)
    setIsDialogOpen(true)
  }

  const saveMember = (member: Member) => {
    const isEditing = memberList.some(
      (currentMember) => currentMember.id === member.id
    )

    setMemberList((currentMembers) => {
      if (isEditing) {
        return currentMembers.map((currentMember) =>
          currentMember.id === member.id ? member : currentMember
        )
      }

      return [...currentMembers, member]
    })
    setIsDialogOpen(false)
    toast.success(isEditing ? 'Member updated' : 'Member added', {
      description: `${member.name} is now in the member directory.`,
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
              Meeting participants
            </p>
            <h1 className='mt-1 text-2xl font-bold tracking-tight sm:text-3xl'>
              Members
            </h1>
            <p className='mt-2 max-w-2xl text-muted-foreground'>
              Keep the people who organize and join meetings in one lightweight
              directory.
            </p>
          </div>
          <Button onClick={openAddDialog}>
            <Plus />
            Add Member
          </Button>
        </div>

        <Card className='overflow-hidden'>
          <CardHeader className='border-b'>
            <CardTitle>Member directory</CardTitle>
            <CardDescription>
              {memberList.length} member
              {memberList.length === 1 ? '' : 's'} in the shared workspace.
            </CardDescription>
          </CardHeader>
          <CardContent className='p-0'>
            {memberList.length ? (
              <div className='overflow-x-auto'>
                <Table className='min-w-[820px]'>
                  <TableHeader>
                    <TableRow>
                      <TableHead className='w-[25%]'>Member</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Department</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className='text-end'>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {memberList.map((member) => (
                      <TableRow key={member.id}>
                        <TableCell className='whitespace-normal'>
                          <div className='flex min-w-48 items-center gap-3'>
                            <MemberAvatar member={member} />
                            <span className='font-medium'>{member.name}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className='whitespace-nowrap'>
                            {member.email}
                          </span>
                        </TableCell>
                        <TableCell>{member.department}</TableCell>
                        <TableCell>
                          <Badge variant='secondary'>
                            {memberRoleLabels[member.role]}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant='outline'
                            className={memberStatusStyles[member.status]}
                          >
                            {memberStatusLabels[member.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className='text-end'>
                          <Button
                            variant='ghost'
                            size='sm'
                            onClick={() => openEditDialog(member)}
                            aria-label={`Edit ${member.name}`}
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

      <MemberDialog
        open={isDialogOpen}
        member={editingMember}
        onOpenChange={setIsDialogOpen}
        onSave={saveMember}
      />
    </>
  )
}

function MemberDialog({
  open,
  member,
  onOpenChange,
  onSave,
}: {
  open: boolean
  member: Member | null
  onOpenChange: (open: boolean) => void
  onSave: (member: Member) => void
}) {
  const form = useForm<MemberFormValues>({
    resolver: zodResolver(memberFormSchema),
    defaultValues: getMemberFormValues(),
  })

  useEffect(() => {
    if (open) {
      form.reset(getMemberFormValues(member))
    }
  }, [form, member, open])

  const onSubmit = (values: MemberFormValues) => {
    onSave({
      id: member?.id ?? createMemberId(values.name),
      name: values.name.trim(),
      email: values.email.trim(),
      department: values.department.trim(),
      role: values.role,
      status: values.status,
      avatar: member?.avatar ?? null,
    })
  }

  const isEditing = Boolean(member)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] overflow-y-auto'>
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Member' : 'Add Member'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Update the participant details shown across meeting workflows.'
              : 'Add a participant to the shared member directory.'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            id='member-form'
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
                    <Input {...field} placeholder='e.g. Nguyễn Lan' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='email'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type='email'
                      placeholder='name@sme.local'
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='department'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Department</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder='e.g. Sản phẩm' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className='grid gap-4 sm:grid-cols-2'>
              <FormField
                control={form.control}
                name='role'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Role</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(memberRoleLabels).map(
                          ([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          )
                        )}
                      </SelectContent>
                    </Select>
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
                        {Object.entries(memberStatusLabels).map(
                          ([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          )
                        )}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </form>
        </Form>

        <DialogFooter>
          <DialogClose asChild>
            <Button type='button' variant='outline'>
              Cancel
            </Button>
          </DialogClose>
          <Button type='submit' form='member-form'>
            {isEditing ? 'Save Changes' : 'Add Member'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MemberAvatar({ member }: { member: Member }) {
  return (
    <Avatar className='size-9'>
      {member.avatar && <AvatarImage src={member.avatar} alt={member.name} />}
      <AvatarFallback className='bg-primary/10 text-xs font-medium text-primary'>
        {getDisplayNameInitials(member.name)}
      </AvatarFallback>
    </Avatar>
  )
}

function EmptyState() {
  return (
    <div className='flex min-h-56 flex-col items-center justify-center gap-1 px-4 text-center'>
      <UserRound className='size-8 text-muted-foreground' />
      <p className='mt-2 font-medium'>No members found.</p>
      <p className='text-sm text-muted-foreground'>
        Add a member to start the directory.
      </p>
    </div>
  )
}

function getMemberFormValues(member?: Member | null): MemberFormValues {
  return {
    name: member?.name ?? '',
    email: member?.email ?? '',
    department: member?.department ?? '',
    role: member?.role ?? 'employee',
    status: member?.status ?? 'active',
  }
}

function createMemberId(name: string) {
  const slug = name
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  return `member-${slug || 'new'}-${Date.now()}`
}
