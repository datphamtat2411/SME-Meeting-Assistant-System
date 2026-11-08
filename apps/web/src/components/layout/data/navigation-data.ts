import {
  BadgeCheck,
  Bot,
  CalendarDays,
  DoorOpen,
  HelpCircle,
  LayoutDashboard,
  ListChecks,
  Palette,
  Settings,
  UserCog,
  Users,
  Video,
} from 'lucide-react'
import { type NavGroup } from '../types'

export const navigationGroups = [
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
            title: 'Account',
            url: '/settings/account',
            icon: BadgeCheck,
          },
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
] satisfies NavGroup[]
