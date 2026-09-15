import {
  Bot,
  CalendarDays,
  DoorOpen,
  LayoutDashboard,
  HelpCircle,
  ListChecks,
  Palette,
  Settings,
  Video,
  UserCog,
  Users,
  Command,
} from 'lucide-react'
import { currentDemoUser } from '@/features/meetings/data'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  user: {
    name: currentDemoUser.name,
    email: currentDemoUser.email,
    avatar: currentDemoUser.avatar ?? '',
  },
  teams: [
    {
      name: 'SME Meeting Assistant',
      logo: Command,
      plan: 'AI Meeting Workspace',
    },
  ],
  navGroups: [
    {
      title: 'General',
      items: [
        {
          title: 'Dashboard',
          url: '/',
          icon: LayoutDashboard,
        },
        {
          title: 'Meetings',
          url: '/meetings',
          icon: Video,
        },
        {
          title: 'Calendar',
          url: '/calendar',
          icon: CalendarDays,
        },
        {
          title: 'Action Items',
          url: '/action-items',
          icon: ListChecks,
        },
        {
          title: 'AI Assistant',
          url: '/assistant',
          icon: Bot,
        },
        {
          title: 'Meeting Rooms',
          url: '/rooms',
          icon: DoorOpen,
        },
        {
          title: 'Members',
          url: '/members',
          icon: Users,
        },
      ],
    },
    {
      title: 'Other',
      items: [
        {
          title: 'Settings',
          icon: Settings,
          items: [
            {
              title: 'Profile',
              url: '/settings',
              icon: UserCog,
            },
            {
              title: 'Appearance',
              url: '/settings/appearance',
              icon: Palette,
            },
          ],
        },
        {
          title: 'Help Center',
          url: '/help-center',
          icon: HelpCircle,
        },
      ],
    },
  ],
}
