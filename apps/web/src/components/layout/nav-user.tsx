import { currentUserPresentation } from './data/user-presentation'
import { type UserPresentation } from './types'
import { UserMenu } from './user-menu'

type NavUserProps = {
  user?: UserPresentation
}

export function NavUser({ user = currentUserPresentation }: NavUserProps) {
  return <UserMenu user={user} variant='sidebar' />
}
