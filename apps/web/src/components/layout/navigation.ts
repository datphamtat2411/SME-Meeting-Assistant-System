import { type LinkProps } from '@tanstack/react-router'
import { type NavGroup } from './types'

function normalizePathname(pathname: string) {
  const path = pathname.split(/[?#]/, 1)[0] || '/'
  return path.replace(/\/+$/, '') || '/'
}

export function isNavigationPathActive(
  pathname: string,
  target: LinkProps['to']
) {
  const currentPath = normalizePathname(pathname)
  const targetPath = normalizePathname(String(target))

  return (
    currentPath === targetPath ||
    (targetPath !== '/' && currentPath.startsWith(`${targetPath}/`))
  )
}

export function getActiveNavigationUrl(
  pathname: string,
  groups: readonly NavGroup[]
): LinkProps['to'] | undefined {
  let activeUrl: LinkProps['to'] | undefined
  let activePathLength = -1

  const consider = (url: LinkProps['to']) => {
    if (!isNavigationPathActive(pathname, url)) return

    const targetPath = normalizePathname(String(url))
    if (targetPath.length > activePathLength) {
      activeUrl = url
      activePathLength = targetPath.length
    }
  }

  for (const group of groups) {
    for (const item of group.items) {
      if (item.items) item.items.forEach((subItem) => consider(subItem.url))
      else consider(item.url)
    }
  }

  return activeUrl
}
