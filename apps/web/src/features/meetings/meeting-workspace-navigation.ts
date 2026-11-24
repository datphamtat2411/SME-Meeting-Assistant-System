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

export interface MeetingWorkspaceSearch extends Record<string, unknown> {
  section?: MeetingWorkspaceSection
}

const sectionSearchSchema = z
  .object({
    section: meetingWorkspaceSectionSchema.optional().catch(undefined),
  })
  .passthrough()

export function normalizeMeetingWorkspaceSearch(
  search: Record<string, unknown>
): MeetingWorkspaceSearch {
  return sectionSearchSchema.parse(search) as MeetingWorkspaceSearch
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
  return {
    ...previous,
    section: section === 'overview' ? undefined : section,
  }
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
    'canReadMeetingContent' | 'canReadIntelligence' | 'canReadActionItems'
  >
): MeetingWorkspaceSection {
  return isMeetingWorkspaceSectionAllowed(requested, capabilities)
    ? requested
    : 'overview'
}
