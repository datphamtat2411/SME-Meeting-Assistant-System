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

export const intelligenceViewSchema = z.enum(['summary', 'decisions', 'minutes'])
export type IntelligenceView = z.infer<typeof intelligenceViewSchema>

const evidenceReturnSchema = z.enum(['decisions', 'action-items'])
export type EvidenceReturn = z.infer<typeof evidenceReturnSchema>

export type EvidenceReferenceIssue = 'malformed' | 'incomplete'

export interface MeetingWorkspaceSearch extends Record<string, unknown> {
  section?: MeetingWorkspaceSection
  intelligenceView?: IntelligenceView
  evidenceReturn?: EvidenceReturn
  evidenceTranscriptId?: string
  evidenceSegmentId?: string
  evidenceContentRevision?: number
  evidenceReferenceIssue?: EvidenceReferenceIssue
}

const evidenceIdentifierSchema = z.string().uuid().optional().catch(undefined)
const sectionSearchSchema = z
  .object({
    section: meetingWorkspaceSectionSchema.optional().catch(undefined),
    intelligenceView: intelligenceViewSchema.optional().catch(undefined),
    evidenceReturn: evidenceReturnSchema.optional().catch(undefined),
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

  const normalized = { ...parsed, evidenceReferenceIssue }
  if (parsed.section !== 'intelligence') delete normalized.intelligenceView
  if (!hasTranscript && !hasSegment) delete normalized.evidenceReturn
  if (!normalized.intelligenceView) delete normalized.intelligenceView
  if (!normalized.evidenceReturn) delete normalized.evidenceReturn
  return normalized
}

export function activeMeetingWorkspaceSection(
  search: Pick<MeetingWorkspaceSearch, 'section'>
): MeetingWorkspaceSection {
  return search.section ?? 'overview'
}

export function activeIntelligenceView(
  search: Pick<MeetingWorkspaceSearch, 'section' | 'intelligenceView'>
): IntelligenceView {
  return search.section === 'intelligence'
    ? (search.intelligenceView ?? 'summary')
    : 'summary'
}

/** Drafts belong to the feature view, not the parent Intelligence section. */
export function remainsInIntelligenceReview(
  current: MeetingWorkspaceSearch,
  next: MeetingWorkspaceSearch
): boolean {
  if (next.evidenceTranscriptId || next.evidenceSegmentId || next.evidenceReferenceIssue)
    return false
  if (current.section === 'action-items') return next.section === 'action-items'
  return (
    current.section === 'intelligence' &&
    next.section === 'intelligence' &&
    activeIntelligenceView(current) === activeIntelligenceView(next)
  )
}

export function updateMeetingWorkspaceSearch(
  previous: MeetingWorkspaceSearch,
  section: MeetingWorkspaceSection,
  view?: IntelligenceView
): MeetingWorkspaceSearch {
  const next: MeetingWorkspaceSearch = {
    ...previous,
    section: section === 'overview' ? undefined : section,
  }
  if (section === 'intelligence' && view) {
    next.intelligenceView = view
  } else if (section !== 'intelligence' || previous.section !== 'intelligence') {
    delete next.intelligenceView
  }
  if (section !== 'transcript') {
    delete next.evidenceReturn
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
