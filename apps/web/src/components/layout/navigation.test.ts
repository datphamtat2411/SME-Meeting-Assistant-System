import { type LinkProps } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { navigationGroups } from './data/navigation-data'
import { getActiveNavigationUrl, isNavigationPathActive } from './navigation'

const pathMatchCases: Array<[string, LinkProps['to'], boolean]> = [
  ['/', '/', true],
  ['/meetings', '/meetings', true],
  ['/meetings/meeting-42', '/meetings', true],
  ['/meetings/meeting-42/live', '/meetings', true],
  ['/calendar?view=week#today', '/calendar', true],
  ['/settings/account?tab=security#keys', '/settings/account', true],
  ['/settings/appearance/', '/settings/appearance', true],
  ['/settings/account', '/settings', true],
  ['/meetings?view=upcoming#list', '/meetings', true],
  ['/meetings-archive', '/meetings', false],
  ['/settings/accounting', '/settings/account', false],
  ['/calendar-extra', '/calendar', false],
  ['/meetings', '/', false],
]

describe('isNavigationPathActive', () => {
  it.each(pathMatchCases)(
    'matches %s against %s as %s',
    (pathname, target, expected) => {
      expect(isNavigationPathActive(pathname, target)).toBe(expected)
    }
  )
})

describe('getActiveNavigationUrl', () => {
  it('selects the most specific configured route for nested settings pages', () => {
    expect(getActiveNavigationUrl('/settings/account', navigationGroups)).toBe(
      '/settings/account'
    )
    expect(
      getActiveNavigationUrl(
        '/settings/account?tab=security#keys',
        navigationGroups
      )
    ).toBe('/settings/account')
  })

  it('keeps the Meetings destination active for nested meeting routes', () => {
    expect(
      getActiveNavigationUrl('/meetings/meeting-42/live', navigationGroups)
    ).toBe('/meetings')
  })

  it('does not select a route for a similarly prefixed path', () => {
    expect(
      getActiveNavigationUrl('/meetings-archive', navigationGroups)
    ).toBeUndefined()
  })
})
