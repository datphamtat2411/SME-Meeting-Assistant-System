/** Match scoped query identities even when a request has no successful data. */
export function isMeetingContentQuery(
  key: readonly unknown[],
  meetingId: string,
  data?: unknown
): boolean {
  const [family, scope, expectedMeetingId] = key
  if (
    family === 'meeting-media' ||
    family === 'processing-jobs' ||
    family === 'meeting-intelligence' ||
    family === 'transcript' ||
    family === 'minutes'
  ) {
    return scope === meetingId
  }
  if (family === 'export' || family === 'processing-job') {
    if (typeof expectedMeetingId === 'string')
      return expectedMeetingId === meetingId
    return hasMeetingId(data, meetingId)
  }
  return false
}

function hasMeetingId(value: unknown, meetingId: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'meetingId' in value &&
    value.meetingId === meetingId
  )
}

export function isMeetingActionQuery(
  key: readonly unknown[],
  meetingId: string,
  data?: unknown
): boolean {
  const [family, kind, filter, scope] = key
  if (family !== 'action-items') return false
  if (kind === 'management-capability') return filter === meetingId
  if (kind === 'list' || kind === 'detail') {
    if (typeof scope === 'string') return scope === meetingId
    if (kind === 'list') return hasMeetingId(filter, meetingId)
    return (
      typeof data === 'object' &&
      data !== null &&
      'item' in data &&
      hasMeetingId(data.item, meetingId)
    )
  }
  return kind === 'assignee-candidates' && hasMeetingId(filter, meetingId)
}

export function isMeetingScopedQuery(
  key: readonly unknown[],
  meetingId: string,
  data?: unknown
): boolean {
  return (
    (key[0] === 'meetings' &&
      (key[1] === 'detail' || key[1] === 'participants') &&
      key[2] === meetingId) ||
    isMeetingContentQuery(key, meetingId, data) ||
    isMeetingActionQuery(key, meetingId, data)
  )
}
