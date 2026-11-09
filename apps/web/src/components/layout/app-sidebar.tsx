import { useLayout } from '@/context/layout-provider'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar'
import { AppTitle } from './app-title'
import { navigationGroups } from './data/navigation-data'
import { NavGroup } from './nav-group'
import { NavUser } from './nav-user'
import { type UserPresentation } from './types'

export function AppSidebar({ user }: { user?: UserPresentation }) {
  const { collapsible, variant } = useLayout()
  return (
    <Sidebar collapsible={collapsible} variant={variant}>
      <SidebarHeader>
        <AppTitle />
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label='Primary navigation'>
          {navigationGroups.map((props) => (
            <NavGroup key={props.title} {...props} />
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter>
        {user && <NavUser user={user} />}
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
