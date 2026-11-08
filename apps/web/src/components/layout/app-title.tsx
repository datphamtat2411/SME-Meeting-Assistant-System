import { Link } from '@tanstack/react-router'
import { Menu, Video, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Button } from '../ui/button'

export function AppTitle() {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className='flex min-w-0 items-center gap-0'>
          <Link
            to='/'
            aria-label='SME Meeting Assistant home'
            onClick={() => setOpenMobile(false)}
            className='flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-start text-sm outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring'
          >
            <span className='flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground group-data-[collapsible=icon]:size-4'>
              <Video className='size-4 group-data-[collapsible=icon]:size-3' />
            </span>
            <span className='grid min-w-0 text-sm leading-tight group-data-[collapsible=icon]:hidden'>
              <span className='truncate font-bold'>SME Meeting Assistant</span>
              <span className='truncate text-xs'>AI Meeting Workspace</span>
            </span>
          </Link>
          <ToggleSidebar />
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function ToggleSidebar({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()

  return (
    <Button
      data-sidebar='trigger'
      data-slot='sidebar-trigger'
      variant='ghost'
      size='icon'
      className={cn(
        'aspect-square size-8 max-md:scale-125 group-data-[collapsible=icon]:size-4',
        className
      )}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <X className='md:hidden' />
      <Menu className='max-md:hidden' />
      <span className='sr-only'>Toggle Sidebar</span>
    </Button>
  )
}
