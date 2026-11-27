import { useLayout } from '@/context/layout-provider'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar'
import type { AuthContext } from '@/features/auth/session/current-user'
import { AppTitle } from './app-title'
import { getNavigationGroups } from './data/navigation-data'
import { NavGroup } from './nav-group'
import { NavUser } from './nav-user'
import { type UserPresentation } from './types'

export function AppSidebar({
  user,
  identity,
}: {
  user?: UserPresentation
  identity?: AuthContext | null
}) {
  const { collapsible, variant } = useLayout()
  const groups = getNavigationGroups(identity)
  return (
    <Sidebar collapsible={collapsible} variant={variant}>
      <SidebarHeader>
        <AppTitle />
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label='Primary navigation'>
          {groups.map((props) => (
            <NavGroup key={props.title} {...props} activeGroups={groups} />
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter>{user && <NavUser user={user} />}</SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
