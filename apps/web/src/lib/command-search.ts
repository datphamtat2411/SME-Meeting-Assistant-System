function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Rank navigation by explicit route, then by label or label fragments.
 * Unlike fuzzy matching across concatenated aliases, every query token must
 * match, and route tokens must match the canonical route, never a label.
 */
export function commandSearchScore(
  value: string,
  search: string,
  keywords: string[] = []
): number {
  const query = normalize(search)
  if (!query) return 1

  const canonical = normalize(value)
  const route = canonical.split(' ').find((part) => part.startsWith('/'))
  const tokens = query.split(' ')
  const routeTokens = tokens.filter((token) => token.startsWith('/'))

  if (routeTokens.some((token) => !route?.startsWith(token))) return 0

  const candidates = [canonical, ...keywords.map(normalize)]
  if (route) candidates.push(route)

  if (candidates.includes(query)) return 1
  if (candidates.some((candidate) => candidate.startsWith(query))) return 0.9
  if (candidates.some((candidate) => candidate.includes(query))) return 0.8

  const allTokensMatch = tokens.every((token) =>
    token.startsWith('/')
      ? route?.startsWith(token)
      : candidates.some((candidate) => candidate.includes(token))
  )

  return allTokensMatch ? 0.5 : 0
}
