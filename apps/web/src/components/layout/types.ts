import { type LinkProps } from '@tanstack/react-router'

type UserPresentation = {
  displayName: string
  email?: string
  avatarUrl?: string
  initials: string
}

type BaseNavItem = {
  title: string
  badge?: string
  icon?: React.ElementType
}

type NavLink = BaseNavItem & {
  url: LinkProps['to']
  items?: never
}

type NavSubItem = BaseNavItem & {
  url: LinkProps['to']
}

type NavCollapsible = BaseNavItem & {
  items: NavSubItem[]
  url?: never
}

type NavItem = NavCollapsible | NavLink

type NavGroup = {
  title: string
  items: NavItem[]
}

export type {
  UserPresentation,
  NavGroup,
  NavItem,
  NavCollapsible,
  NavLink,
  NavSubItem,
}
