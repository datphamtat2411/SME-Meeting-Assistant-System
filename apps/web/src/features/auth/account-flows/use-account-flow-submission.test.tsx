import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { CoreApiError } from '@/lib/core-api'
import { useAccountFlowSubmission } from './use-account-flow-submission'

function SubmissionHarness({ action }: { action: () => Promise<void> }) {
  const submission = useAccountFlowSubmission('setup')
  return (
    <button
      type='button'
      disabled={submission.blocked}
      onClick={() => void submission.run(action)}
    >
      Submit
    </button>
  )
}

describe('account-flow submission cleanup', () => {
  it('disposes the Retry-After timer when the workflow unmounts', async () => {
    const action = vi.fn<() => Promise<void>>().mockRejectedValue(
      new CoreApiError({
        kind: 'http',
        status: 429,
        message: 'throttled',
        retryAfter: '60',
      })
    )
    const screen = await render(<SubmissionHarness action={action} />)
    const button = screen.getByRole('button', { name: 'Submit' }).element()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })

    try {
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(button).toBeDisabled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(vi.getTimerCount()).toBe(1)

      await screen.unmount()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(action).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
