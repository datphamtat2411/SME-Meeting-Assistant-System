import { UserMenu } from './user-menu'
import { currentUserPresentation } from './data/user-presentation'
import { type UserPresentation } from './types'

type NavUserProps = {
  user?: UserPresentation
}

export function NavUser({ user = currentUserPresentation }: NavUserProps) {
  return <UserMenu user={user} variant='sidebar' />
}
