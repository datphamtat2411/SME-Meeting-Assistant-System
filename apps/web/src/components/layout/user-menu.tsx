import { Link } from '@tanstack/react-router'
import {
  BadgeCheck,
  Bell,
  ChevronsUpDown,
  LogOut,
  UserRound,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import useDialogState from '@/hooks/use-dialog-state'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { SignOutDialog } from '@/components/sign-out-dialog'
import { useUserPresentation } from './data/user-presentation'
import { type UserPresentation } from './types'

type UserMenuProps = {
  user?: UserPresentation
  variant?: 'header' | 'sidebar'
}

export function UserMenu({
  user,
  variant = 'header',
}: UserMenuProps) {
  const contextUser = useUserPresentation()
  const resolvedUser = user ?? contextUser

  if (!resolvedUser) return null

  if (variant === 'sidebar') {
    return <SidebarUserMenu user={resolvedUser} />
  }

  return <HeaderUserMenu user={resolvedUser} />
}

function HeaderUserMenu({ user }: { user: UserPresentation }) {
  const [open, setOpen] = useDialogState()

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant='ghost'
            size='icon'
            className='relative size-8 rounded-full'
            aria-label='Open user menu'
          >
            <UserAvatar user={user} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className='w-56' align='end' forceMount>
          <UserMenuContent user={user} onSignOut={() => setOpen(true)} />
        </DropdownMenuContent>
      </DropdownMenu>

      <SignOutDialog open={!!open} onOpenChange={setOpen} />
    </>
  )
}

function SidebarUserMenu({ user }: { user: UserPresentation }) {
  const { isMobile } = useSidebar()
  const [open, setOpen] = useDialogState()

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size='lg'
                aria-label='Open user menu'
                className='data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground'
              >
                <UserAvatar user={user} rounded />
                <UserIdentity user={user} />
                <ChevronsUpDown className='ms-auto size-4' />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className='w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg'
              side={isMobile ? 'bottom' : 'right'}
              align='end'
              sideOffset={4}
            >
              <UserMenuContent user={user} onSignOut={() => setOpen(true)} />
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <SignOutDialog open={!!open} onOpenChange={setOpen} />
    </>
  )
}

function UserMenuContent({
  user,
  onSignOut,
}: {
  user: UserPresentation
  onSignOut: () => void
}) {
  return (
    <>
      <DropdownMenuLabel className='p-0 font-normal'>
        <div className='flex items-center gap-2 px-1 py-1.5 text-start text-sm'>
          <UserAvatar user={user} rounded />
          <UserIdentity user={user} />
        </div>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem asChild>
          <Link to='/settings'>
            <UserRound />
            Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to='/settings/account'>
            <BadgeCheck />
            Account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to='/settings/notifications'>
            <Bell />
            Notifications
          </Link>
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant='destructive' onClick={onSignOut}>
        <LogOut />
        Sign out
      </DropdownMenuItem>
    </>
  )
}

function UserAvatar({
  user,
  className,
  rounded = false,
}: {
  user: UserPresentation
  className?: string
  rounded?: boolean
}) {
  return (
    <Avatar className={cn(className, rounded && 'rounded-lg')}>
      {user.avatarUrl && (
        <AvatarImage src={user.avatarUrl} alt={user.displayName} />
      )}
      <AvatarFallback className={rounded ? 'rounded-lg' : undefined}>
        {user.initials}
      </AvatarFallback>
    </Avatar>
  )
}

function UserIdentity({ user }: { user: UserPresentation }) {
  return (
    <div className='grid min-w-0 flex-1 text-start text-sm leading-tight'>
      <span className='truncate font-semibold'>{user.displayName}</span>
      {user.email && (
        <span className='truncate text-xs text-muted-foreground'>
          {user.email}
        </span>
      )}
    </div>
  )
}
