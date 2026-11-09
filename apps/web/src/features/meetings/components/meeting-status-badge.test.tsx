import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { MeetingStatusBadge } from './meeting-status-badge'

describe('MeetingStatusBadge', () => {
  it('renders canonical lifecycle statuses without treating AI processing as lifecycle', async () => {
    const screen = await render(
      <>
        <MeetingStatusBadge status='DRAFT' />
        <MeetingStatusBadge status='SCHEDULED' />
        <MeetingStatusBadge status='IN_PROGRESS' />
        <MeetingStatusBadge status='ENDED' />
        <MeetingStatusBadge status='CANCELLED' />
      </>
    )

    await expect.element(screen.getByText('Draft')).toBeInTheDocument()
    await expect.element(screen.getByText('Upcoming')).toBeInTheDocument()
    await expect.element(screen.getByText('Live')).toBeInTheDocument()
    await expect.element(screen.getByText('Completed')).toBeInTheDocument()
    await expect.element(screen.getByText('Cancelled')).toBeInTheDocument()
  })

  it('keeps the legacy processing badge available to mock-only consumers', async () => {
    const screen = await render(<MeetingStatusBadge status='processing' />)

    await expect.element(screen.getByText('Processing')).toBeInTheDocument()
  })
})
