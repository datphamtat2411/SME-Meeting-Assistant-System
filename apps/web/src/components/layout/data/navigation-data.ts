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
import { canEnterMemberDirectory } from '@/features/members/member-access-policy'
import { type NavGroup } from '../types'

export const navigationGroups = [
  {
    title: 'General',
    titleKey: 'navigation:general',
    items: [
      {
        title: 'Dashboard',
        titleKey: 'navigation:dashboard',
        url: '/',
        icon: LayoutDashboard,
      },
      {
        title: 'Meetings',
        titleKey: 'navigation:meetings',
        url: '/meetings',
        icon: Video,
      },
      {
        title: 'Calendar',
        titleKey: 'navigation:calendar',
        url: '/calendar',
        icon: CalendarDays,
      },
      {
        title: 'Action Items',
        titleKey: 'navigation:actionItems',
        url: '/action-items',
        icon: ListChecks,
      },
      {
        title: 'AI Assistant',
        titleKey: 'navigation:assistant',
        url: '/assistant',
        icon: Bot,
      },
      {
        title: 'Meeting Rooms',
        titleKey: 'navigation:rooms',
        url: '/rooms',
        icon: DoorOpen,
      },
      {
        title: 'Members',
        titleKey: 'navigation:members',
        url: '/members',
        icon: Users,
      },
    ],
  },
  {
    title: 'Other',
    titleKey: 'navigation:other',
    items: [
      {
        title: 'Settings',
        titleKey: 'navigation:settings',
        icon: Settings,
        items: [
          {
            title: 'Account',
            titleKey: 'navigation:account',
            url: '/settings/account',
            icon: BadgeCheck,
          },
          {
            title: 'Profile',
            titleKey: 'navigation:profile',
            url: '/settings',
            icon: UserCog,
          },
          {
            title: 'Appearance',
            titleKey: 'navigation:appearance',
            url: '/settings/appearance',
            icon: Palette,
          },
          {
            title: 'Notifications',
            titleKey: 'navigation:notifications',
            url: '/settings/notifications',
            icon: Bell,
          },
        ],
      },
      {
        title: 'Help Center',
        titleKey: 'navigation:helpCenter',
        url: '/help-center',
        icon: HelpCircle,
      },
    ],
  },
] satisfies NavGroup[]

export function getNavigationGroups(identity?: AuthContext | null): NavGroup[] {
  const canAccessMembers = canEnterMemberDirectory(identity)

  return navigationGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (!('url' in item) || item.url !== '/members') return true
      return canAccessMembers
    }),
  }))
}
