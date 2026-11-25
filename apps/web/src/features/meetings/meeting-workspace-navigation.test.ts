import { describe, expect, it } from 'vitest'
import {
  activeMeetingWorkspaceSection,
  isMeetingWorkspaceSectionAllowed,
  meetingWorkspaceSections,
  normalizeMeetingWorkspaceSearch,
  resolveMeetingWorkspaceSection,
  updateMeetingWorkspaceSearch,
  type MeetingWorkspaceSection,
} from './meeting-workspace-navigation'

const fullyAuthorized = {
  canReadMeetingContent: true,
  canReadIntelligence: true,
  canReadActionItems: true,
}

describe('meeting workspace navigation state', () => {
  it('defines only the five primary workspace sections', () => {
    expect(meetingWorkspaceSections).toEqual([
      'overview',
      'recording',
      'transcript',
      'intelligence',
      'action-items',
    ])
  })

  it('uses overview as the default and validates direct-link search values', () => {
    expect(normalizeMeetingWorkspaceSearch({})).toEqual({
      section: undefined,
      evidenceTranscriptId: undefined,
      evidenceSegmentId: undefined,
      evidenceReferenceIssue: undefined,
    })
    expect(
      activeMeetingWorkspaceSection(
        normalizeMeetingWorkspaceSearch({ section: 'transcript' })
      )
    ).toBe('transcript')
    expect(
      activeMeetingWorkspaceSection(
        normalizeMeetingWorkspaceSearch({ section: 'processing' })
      )
    ).toBe('overview')
  })

  it('validates paired evidence identifiers and reports malformed direct links', () => {
    const transcriptId = '11111111-1111-4111-8111-111111111111'
    const segmentId = '22222222-2222-4222-8222-222222222222'

    expect(
      normalizeMeetingWorkspaceSearch({
        section: 'overview',
        evidenceTranscriptId: transcriptId,
        evidenceSegmentId: segmentId,
      })
    ).toMatchObject({
      section: 'overview',
      evidenceTranscriptId: transcriptId,
      evidenceSegmentId: segmentId,
      evidenceReferenceIssue: undefined,
    })
    expect(
      normalizeMeetingWorkspaceSearch({
        evidenceTranscriptId: transcriptId,
      }).evidenceReferenceIssue
    ).toBe('incomplete')
    expect(
      normalizeMeetingWorkspaceSearch({
        evidenceTranscriptId: 'not-an-id',
        evidenceSegmentId: segmentId,
      })
    ).toMatchObject({
      evidenceTranscriptId: undefined,
      evidenceSegmentId: segmentId,
      evidenceReferenceIssue: 'malformed',
    })
  })

  it('preserves unrelated router search state while changing the workspace section', () => {
    expect(
      updateMeetingWorkspaceSearch(
        {
          section: 'transcript',
          source: 'calendar',
          evidenceTranscriptId: '11111111-1111-4111-8111-111111111111',
          evidenceSegmentId: '22222222-2222-4222-8222-222222222222',
        },
        'intelligence'
      )
    ).toEqual({ section: 'intelligence', source: 'calendar' })
    expect(
      updateMeetingWorkspaceSearch(
        { section: 'recording', source: 'calendar' },
        'overview'
      )
    ).toEqual({ source: 'calendar', section: undefined })
  })

  it('resolves unauthorized direct selections to overview without exposing protected panels', () => {
    const denied = {
      canReadMeetingContent: false,
      canReadIntelligence: false,
      canReadActionItems: false,
    }
    expect(isMeetingWorkspaceSectionAllowed('overview', denied)).toBe(true)
    expect(isMeetingWorkspaceSectionAllowed('recording', denied)).toBe(false)
    expect(isMeetingWorkspaceSectionAllowed('transcript', denied)).toBe(false)
    expect(isMeetingWorkspaceSectionAllowed('intelligence', denied)).toBe(false)
    expect(resolveMeetingWorkspaceSection('transcript', denied)).toBe(
      'overview'
    )
    expect(
      resolveMeetingWorkspaceSection('action-items', {
        ...denied,
        canReadActionItems: true,
      })
    ).toBe('action-items')
  })

  it('preserves an unresolved direct link until authorization is definitive', () => {
    expect(
      resolveMeetingWorkspaceSection('transcript', {
        canReadMeetingContent: false,
        canReadIntelligence: false,
        canReadActionItems: false,
        authorizationResolution: 'unresolved',
      })
    ).toBe('transcript')
  })

  it('accepts each authorized section directly', () => {
    for (const section of meetingWorkspaceSections as readonly MeetingWorkspaceSection[]) {
      expect(isMeetingWorkspaceSectionAllowed(section, fullyAuthorized)).toBe(
        true
      )
      expect(resolveMeetingWorkspaceSection(section, fullyAuthorized)).toBe(
        section
      )
    }
  })
})
