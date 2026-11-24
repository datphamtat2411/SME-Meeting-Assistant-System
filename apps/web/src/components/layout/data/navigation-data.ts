import {
  BadgeCheck,
  Bell,
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
import type { AuthContext } from '@/features/auth/session/current-user'
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
          {
            title: 'Notifications',
            url: '/settings/notifications',
            icon: Bell,
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

export function getNavigationGroups(identity?: AuthContext | null): NavGroup[] {
  if (!identity) return navigationGroups

  const canAccessMembers =
    identity.accountStatus === 'ACTIVE' &&
    (identity.globalRole === 'ADMINISTRATOR' ||
      identity.globalRole === 'DEPARTMENT_MANAGER')

  return navigationGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (!('url' in item) || item.url !== '/members') return true
      return canAccessMembers
    }),
  }))
}
