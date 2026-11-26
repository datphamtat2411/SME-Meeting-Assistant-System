import { StrictMode, useState } from 'react'
import { createPortal } from 'react-dom'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import {
  usePortalContainer,
  WorkspaceVisibilityBoundary,
} from './workspace-visibility-boundary'

function ProtectedDraft() {
  const host = usePortalContainer()
  const [draft, setDraft] = useState('')

  if (!host) throw new Error('Protected portal host is missing')

  return (
    <>
      <p>Protected workspace</p>
      {createPortal(
        <label>
          Portal draft
          <input value={draft} onChange={(e) => setDraft(e.target.value)} />
        </label>,
        host
      )}
    </>
  )
}

function Harness() {
  const [hidden, setHidden] = useState(false)

  return (
    <>
      <button type='button' onClick={() => setHidden((value) => !value)}>
        Toggle workspace
      </button>
      <WorkspaceVisibilityBoundary hidden={hidden}>
        <ProtectedDraft />
      </WorkspaceVisibilityBoundary>
    </>
  )
}

describe('workspace visibility boundary', () => {
  it('retains one portal host and hides protected DOM across repeated Strict Mode transitions', async () => {
    // Deliberately do not load application CSS: isolation must not rely on
    // utility styles or on Activity hiding the separately mounted portal host.
    const screen = await render(
      <StrictMode>
        <Harness />
      </StrictMode>
    )

    try {
      const input = screen.getByRole('textbox', { name: 'Portal draft' })
      const toggle = screen.getByRole('button', { name: 'Toggle workspace' })
      await expect.element(input).toBeVisible()
      await userEvent.fill(input, 'Unsaved draft')
      const inputElement = input.element()
      const host = inputElement.closest('[data-slot="workspace-portal-host"]')
      const boundary = host?.closest<HTMLDivElement>(
        '[data-slot="workspace-visibility-boundary"]'
      )
      expect(host).not.toBeNull()
      expect(boundary).toBeDefined()

      for (let i = 0; i < 3; i++) {
        await userEvent.click(toggle)
        await expect.poll(() => inputElement.checkVisibility()).toBe(false)
        expect(boundary?.hidden).toBe(true)
        expect(boundary?.inert).toBe(true)
        expect(boundary?.getAttribute('aria-hidden')).toBe('true')
        expect(
          document.querySelector('[data-slot="workspace-portal-host"]')
        ).toBe(host)
        await expect.element(input).not.toBeInTheDocument()
        await expect.element(toggle).toBeEnabled()

        await userEvent.click(toggle)
        await expect.element(input).toBeVisible()
        await expect.element(input).toHaveValue('Unsaved draft')
        expect(
          input.element().closest('[data-slot="workspace-portal-host"]')
        ).toBe(host)
        expect(boundary?.hidden).toBe(false)
        expect(boundary?.inert).toBe(false)
        expect(boundary?.hasAttribute('aria-hidden')).toBe(false)
      }
    } finally {
      await screen.unmount()
    }
  })
})
