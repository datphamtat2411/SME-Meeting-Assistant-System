import { type UserPresentation } from './types'
import { UserMenu } from './user-menu'

type NavUserProps = {
  user: UserPresentation
}

export function NavUser({ user }: NavUserProps) {
  return <UserMenu user={user} variant='sidebar' />
}
