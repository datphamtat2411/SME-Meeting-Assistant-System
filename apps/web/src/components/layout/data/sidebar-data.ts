import {
  Bot,
  CalendarDays,
  Construction,
  DoorOpen,
  LayoutDashboard,
  Monitor,
  Bug,
  FileX,
  HelpCircle,
  Lock,
  Bell,
  ListChecks,
  Palette,
  ServerOff,
  Settings,
  Video,
  Wrench,
  UserCog,
  UserX,
  Users,
  ShieldCheck,
  Command,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  user: {
    name: 'Nguyen Minh Anh',
    email: 'minh.anh@sme.local',
    avatar: '/avatars/shadcn.jpg',
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
      title: 'Pages',
      items: [
        {
          title: 'Auth',
          icon: ShieldCheck,
          items: [
            {
              title: 'Sign In',
              url: '/sign-in',
            },
            {
              title: 'Sign In (2 Col)',
              url: '/sign-in-2',
            },
            {
              title: 'Sign Up',
              url: '/sign-up',
            },
            {
              title: 'Forgot Password',
              url: '/forgot-password',
            },
            {
              title: 'OTP',
              url: '/otp',
            },
          ],
        },
        {
          title: 'Errors',
          icon: Bug,
          items: [
            {
              title: 'Unauthorized',
              url: '/errors/unauthorized',
              icon: Lock,
            },
            {
              title: 'Forbidden',
              url: '/errors/forbidden',
              icon: UserX,
            },
            {
              title: 'Not Found',
              url: '/errors/not-found',
              icon: FileX,
            },
            {
              title: 'Internal Server Error',
              url: '/errors/internal-server-error',
              icon: ServerOff,
            },
            {
              title: 'Maintenance Error',
              url: '/errors/maintenance-error',
              icon: Construction,
            },
          ],
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
              title: 'Account',
              url: '/settings/account',
              icon: Wrench,
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
            {
              title: 'Display',
              url: '/settings/display',
              icon: Monitor,
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
