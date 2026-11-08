import { currentDemoUser } from '@/features/meetings/data'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  user: {
    name: currentDemoUser.name,
    email: currentDemoUser.email,
    avatar: currentDemoUser.avatar ?? '',
  },
}
