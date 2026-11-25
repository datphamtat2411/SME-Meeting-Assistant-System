import { z } from 'zod'
import type { MeetingWorkspaceCapabilities } from './meeting-workspace-capabilities'

export const meetingWorkspaceSections = [
  'overview',
  'recording',
  'transcript',
  'intelligence',
  'action-items',
] as const

export const meetingWorkspaceSectionSchema = z.enum(meetingWorkspaceSections)

export type MeetingWorkspaceSection = (typeof meetingWorkspaceSections)[number]

export type EvidenceReferenceIssue = 'malformed' | 'incomplete'

export interface MeetingWorkspaceSearch extends Record<string, unknown> {
  section?: MeetingWorkspaceSection
  evidenceTranscriptId?: string
  evidenceSegmentId?: string
  evidenceContentRevision?: number
  evidenceReferenceIssue?: EvidenceReferenceIssue
}

const evidenceIdentifierSchema = z.string().uuid().optional().catch(undefined)
const sectionSearchSchema = z
  .object({
    section: meetingWorkspaceSectionSchema.optional().catch(undefined),
    evidenceTranscriptId: evidenceIdentifierSchema,
    evidenceSegmentId: evidenceIdentifierSchema,
    evidenceContentRevision: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .catch(undefined),
  })
  .passthrough()

function hasSearchValue(search: Record<string, unknown>, key: string): boolean {
  const value = search[key]
  return value !== undefined && value !== null && value !== ''
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  )
}

export function normalizeMeetingWorkspaceSearch(
  search: Record<string, unknown>
): MeetingWorkspaceSearch {
  const parsed = sectionSearchSchema.parse(search) as MeetingWorkspaceSearch
  const hasTranscript = hasSearchValue(search, 'evidenceTranscriptId')
  const hasSegment = hasSearchValue(search, 'evidenceSegmentId')
  const hasRevision = hasSearchValue(search, 'evidenceContentRevision')
  const evidenceReferenceIssue: EvidenceReferenceIssue | undefined =
    hasTranscript !== hasSegment || (hasRevision && !hasTranscript)
      ? 'incomplete'
      : (hasTranscript &&
            (!isUuid(search.evidenceTranscriptId) ||
              !isUuid(search.evidenceSegmentId))) ||
          (hasRevision && parsed.evidenceContentRevision === undefined)
        ? 'malformed'
        : undefined

  return {
    ...parsed,
    evidenceReferenceIssue,
  }
}

export function activeMeetingWorkspaceSection(
  search: Pick<MeetingWorkspaceSearch, 'section'>
): MeetingWorkspaceSection {
  return search.section ?? 'overview'
}

export function updateMeetingWorkspaceSearch(
  previous: MeetingWorkspaceSearch,
  section: MeetingWorkspaceSection
): MeetingWorkspaceSearch {
  const next: MeetingWorkspaceSearch = {
    ...previous,
    section: section === 'overview' ? undefined : section,
  }
  if (section !== 'transcript') {
    delete next.evidenceTranscriptId
    delete next.evidenceSegmentId
    delete next.evidenceContentRevision
    delete next.evidenceReferenceIssue
  }
  return next
}

export function isMeetingWorkspaceSectionAllowed(
  section: MeetingWorkspaceSection,
  capabilities: Pick<
    MeetingWorkspaceCapabilities,
    'canReadMeetingContent' | 'canReadIntelligence' | 'canReadActionItems'
  >
): boolean {
  switch (section) {
    case 'overview':
      return true
    case 'recording':
    case 'transcript':
      return capabilities.canReadMeetingContent
    case 'intelligence':
      return capabilities.canReadIntelligence
    case 'action-items':
      return capabilities.canReadActionItems
  }
}

export function resolveMeetingWorkspaceSection(
  requested: MeetingWorkspaceSection,
  capabilities: Pick<
    MeetingWorkspaceCapabilities,
    | 'canReadMeetingContent'
    | 'canReadIntelligence'
    | 'canReadActionItems'
    | 'authorizationResolution'
  >
): MeetingWorkspaceSection {
  if (isMeetingWorkspaceSectionAllowed(requested, capabilities))
    return requested
  return capabilities.authorizationResolution === 'unresolved'
    ? requested
    : 'overview'
}
