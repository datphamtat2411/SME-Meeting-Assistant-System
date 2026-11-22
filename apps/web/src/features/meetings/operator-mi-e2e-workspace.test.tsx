import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { SearchProvider } from '@/context/search-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { SidebarProvider } from '@/components/ui/sidebar'
import { UserPresentationProvider } from '@/components/layout/data/user-presentation'
import { OperatorMiE2eWorkspace } from './operator-mi-e2e-workspace'

const workflowMocks = vi.hoisted(() => ({
  verifyOperatorSession: vi.fn(),
  createSyntheticMeeting: vi.fn(),
  fetchProcessingJob: vi.fn(),
  fetchFinalizedTranscriptEvidence: vi.fn(),
  applyApprovedTranscriptCorrection: vi.fn(),
}))

vi.mock('./data/operator-mi-e2e-workflow', async () => {
  const actual = await vi.importActual<
    typeof import('./data/operator-mi-e2e-workflow')
  >('./data/operator-mi-e2e-workflow')
  return {
    ...actual,
    verifyOperatorSession: workflowMocks.verifyOperatorSession,
    createSyntheticMeeting: workflowMocks.createSyntheticMeeting,
    fetchProcessingJob: workflowMocks.fetchProcessingJob,
    fetchFinalizedTranscriptEvidence:
      workflowMocks.fetchFinalizedTranscriptEvidence,
    applyApprovedTranscriptCorrection:
      workflowMocks.applyApprovedTranscriptCorrection,
  }
})

const user = {
  userId: '46a30219-3c9f-498d-94fa-d6558f200714',
  email: 'e2e-04@example.invalid',
  displayName: 'E2E-04 Local Test',
  globalRole: 'EMPLOYEE' as const,
  accountStatus: 'ACTIVE' as const,
  primaryOrgUnitId: null,
  directoryManagementScope: { allUnits: false, unitIds: [] },
  session: {
    id: '56b7d0a2-46c2-4f9b-bf2e-2e6f4f2d8f31',
    clientType: 'WEB' as const,
    createdAt: '2026-11-21T00:00:00Z',
    lastSeenAt: '2026-11-21T00:00:00Z',
    absoluteExpiresAt: '2026-11-22T00:00:00Z',
  },
}

const meeting = {
  id: 'meeting-1',
  title: 'Cuộc họp MI tiếng Việt',
  description: 'Synthetic bounded Vietnamese MI meeting.',
  organizerUserId: user.userId,
  roomId: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
  status: 'DRAFT' as const,
  startedAt: null,
  endedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: user.userId,
  createdAt: '2026-11-21T00:00:00Z',
  updatedAt: '2026-11-21T00:00:00Z',
}

const presentationUser = {
  displayName: user.displayName,
  email: user.email,
  initials: 'ET',
}

function createTestRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <ThemeProvider>
        <SearchProvider>
          <UserPresentationProvider user={presentationUser}>
            <SidebarProvider>
              <OperatorMiE2eWorkspace />
            </SidebarProvider>
          </UserPresentationProvider>
        </SearchProvider>
      </ThemeProvider>
    ),
  })
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  })
  return createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
}

describe('OperatorMiE2eWorkspace', () => {
  beforeEach(() => {
    workflowMocks.verifyOperatorSession.mockReset()
    workflowMocks.createSyntheticMeeting.mockReset()
    workflowMocks.fetchProcessingJob.mockReset()
    workflowMocks.fetchFinalizedTranscriptEvidence.mockReset()
    workflowMocks.applyApprovedTranscriptCorrection.mockReset()
  })

  it('requires session verification and an explicit creation approval before one meeting request', async () => {
    workflowMocks.verifyOperatorSession.mockResolvedValue({ user })
    workflowMocks.createSyntheticMeeting.mockResolvedValue({
      session: { user },
      meeting: { meeting, etag: '"meeting-1-1' },
      detail: { meeting, etag: '"meeting-1-1' },
      organizerVerified: true,
    })

    const screen = await render(<RouterProvider router={createTestRouter()} />)

    await userEvent.click(
      screen.getByRole('button', { name: 'Verify Web session' })
    )
    await expect
      .element(screen.getByText('E2E-04 Local Test'))
      .toBeInTheDocument()
    expect(workflowMocks.verifyOperatorSession).toHaveBeenCalledWith(
      '46a30219-3c9f-498d-94fa-d6558f200714'
    )

    await userEvent.click(
      screen.getByRole('button', {
        name: 'Create exactly one synthetic meeting',
      })
    )
    expect(workflowMocks.createSyntheticMeeting).not.toHaveBeenCalled()
    await expect
      .element(
        screen.getByRole('alertdialog', { name: 'Approve meeting creation' })
      )
      .toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'I approve meeting creation' })
    )
    await expect
      .element(screen.getByText('Organizer verified'))
      .toBeInTheDocument()
    expect(workflowMocks.createSyntheticMeeting).toHaveBeenCalledTimes(1)
  })

  it('opens a saved run and pages the assigned speaker labels without acknowledging', async () => {
    workflowMocks.verifyOperatorSession.mockResolvedValue({ user })
    workflowMocks.fetchProcessingJob.mockResolvedValue({
      id: 'job-for-review',
      status: 'WAITING_FOR_REVIEW',
      meetingId: meeting.id,
      requestedByUserId: user.userId,
      sourceMediaId: 'media-1',
      stageRuns: [],
    })
    workflowMocks.fetchFinalizedTranscriptEvidence.mockResolvedValue({
      digest: 'a'.repeat(64),
      etag: '"t-transcript-1-1"',
      coverage: [],
      transcript: {
        id: 'transcript-1',
        meetingId: meeting.id,
        processingJobId: 'job-for-review',
        sourceMediaId: 'media-1',
        contentRevision: 1,
        languageCode: 'vi',
        status: 'READY',
        segments: Array.from({ length: 30 }, (_, ordinal) => ({
          id: `segment-${ordinal}`,
          ordinal,
          startMs: ordinal * 1000,
          endMs: (ordinal + 1) * 1000,
          text: `nội dung ${ordinal}`,
          version: 0,
          qualityStatus: 'ACCEPTED',
          speakerClusterId: 'speaker-1',
          speakerLabel: ordinal === 29 ? 'SPEAKER_02' : 'SPEAKER_01',
        })),
      },
    })
    const screen = await render(<RouterProvider router={createTestRouter()} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Verify Web session' })
    )
    await userEvent.fill(
      screen.getByLabelText('Existing processing job ID'),
      'job-for-review'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Open existing run' })
    )
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Review finalized Vietnamese transcript',
      })
    )
    await expect
      .element(screen.getByLabelText('Correction for segment 1', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByLabelText('Correction for segment 30', { exact: true }))
      .not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Next transcript page' })
    )
    await expect.element(screen.getByText('SPEAKER_02')).toBeInTheDocument()
    await expect
      .element(
        screen.getByRole('button', { name: 'Acknowledge reviewed transcript' })
      )
      .toBeDisabled()
  })

  it('enables an unresolved-segment correction only after editing, then saves explicit approval', async () => {
    const originalText =
      'Quang sẽ phụ trách hoàn thiện tích hợp mô đun thanh toán và gửi bản biêu thử nghiệm.'
    const correctedText =
      'Quang sẽ phụ trách hoàn thiện tích hợp mô đun thanh toán và gửi bản build thử nghiệm.'
    const segments = Array.from({ length: 6 }, (_, ordinal) => ({
      id: `segment-${ordinal}`,
      ordinal,
      startMs: ordinal * 6000,
      endMs: (ordinal + 1) * 6000,
      text: ordinal === 3 ? originalText : `nội dung ${ordinal}`,
      version: 0,
      qualityStatus: 'UNRESOLVED',
      speakerClusterId: null,
      speakerLabel: null,
    }))
    const evidence = {
      digest: 'a'.repeat(64),
      etag: '"t-transcript-1-0"',
      coverage: [],
      transcript: {
        id: 'transcript-1',
        meetingId: meeting.id,
        processingJobId: 'job-for-review',
        sourceMediaId: 'media-1',
        contentRevision: 0,
        languageCode: 'vi',
        status: 'READY_WITH_WARNINGS',
        segments,
      },
    }
    const correctedEvidence = {
      ...evidence,
      etag: '"t-transcript-1-1"',
      transcript: {
        ...evidence.transcript,
        contentRevision: 1,
        segments: segments.map((segment) =>
          segment.ordinal === 3
            ? {
                ...segment,
                text: correctedText,
                version: 1,
                qualityStatus: 'ACCEPTED',
              }
            : segment
        ),
      },
    }
    workflowMocks.verifyOperatorSession.mockResolvedValue({ user })
    workflowMocks.fetchProcessingJob.mockResolvedValue({
      id: 'job-for-review',
      status: 'WAITING_FOR_REVIEW',
      meetingId: meeting.id,
      requestedByUserId: user.userId,
      sourceMediaId: 'media-1',
      stageRuns: [],
    })
    workflowMocks.fetchFinalizedTranscriptEvidence
      .mockResolvedValueOnce(evidence)
      .mockResolvedValueOnce(correctedEvidence)
    workflowMocks.applyApprovedTranscriptCorrection.mockResolvedValue({
      correction: {
        id: 'segment-3',
        text: correctedText,
        qualityStatus: 'ACCEPTED',
        version: 1,
        correctedByUserId: user.userId,
        correctedAt: '2026-11-21T00:01:00Z',
      },
      etag: '"s-segment-3-1"',
    })

    const screen = await render(<RouterProvider router={createTestRouter()} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Verify Web session' })
    )
    await userEvent.fill(
      screen.getByLabelText('Existing processing job ID'),
      'job-for-review'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Open existing run' })
    )
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Review finalized Vietnamese transcript',
      })
    )

    const correction = screen.getByLabelText('Correction for segment 4', {
      exact: true,
    })
    const approval = screen.getByRole('checkbox').nth(4)
    await expect
      .element(
        screen.getByText(
          'Edit the transcript text above before approving this correction.',
          { exact: true }
        )
          .nth(3)
      )
      .toBeInTheDocument()
    await expect.element(approval).toBeDisabled()

    await userEvent.fill(correction, correctedText)
    await expect.element(approval).not.toBeDisabled()
    await userEvent.click(approval)
    await expect.element(approval).toBeChecked()
    await userEvent.click(
      screen
        .getByRole('button', {
          name: 'Approve and save this correction',
        })
        .nth(3)
    )

    await expect
      .element(
        screen.getByText(
          'The approved correction was saved and the finalized transcript was read back.',
          { exact: true }
        )
      )
      .toBeInTheDocument()
    expect(
      workflowMocks.applyApprovedTranscriptCorrection
    ).toHaveBeenCalledWith(
      meeting.id,
      'segment-3',
      '"s-segment-3-0"',
      {
        text: correctedText,
        reason: null,
        operatorApproved: true,
      }
    )
  })
})
