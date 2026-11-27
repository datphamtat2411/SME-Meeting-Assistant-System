import '@/styles/index.css'
import { expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { i18n, setUiLanguage, useUiTranslation } from '@/lib/i18n'
import { Button } from './button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from './dialog'

function ConflictDialog() {
  const { t } = useUiTranslation()
  return (
    <Dialog defaultOpen>
      <DialogContent>
        <DialogTitle>{t('members:reviewRetained')}</DialogTitle>
        <DialogDescription>{t('members:reviewRetainedHelp')}</DialogDescription>
        <DialogFooter>
          <Button variant='outline'>{t('members:discardEdits')}</Button>
          <Button>{t('members:resolveConflicts')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

it('keeps localized conflict actions visible and focused on a narrow screen', async () => {
  await page.viewport(360, 640)
  try {
    const screen = await render(<ConflictDialog />)
    const action = screen.getByRole('button', {
      name: i18n.getFixedT('en')('members:resolveConflicts'),
    })
    await userEvent.click(action)
    const focused = action.element()
    await setUiLanguage('vi')
    await expect
      .element(
        screen.getByRole('button', { name: i18n.t('members:resolveConflicts') })
      )
      .toBeVisible()
    expect(document.activeElement).toBe(focused)
    const footer = focused.closest<HTMLElement>('[data-slot="dialog-footer"]')!
    await expect
      .poll(() => footer.scrollWidth <= footer.clientWidth + 1)
      .toBe(true)
    for (const button of footer.querySelectorAll('button')) {
      expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1)
    }
  } finally {
    await setUiLanguage('en')
    await page.viewport(1280, 800)
  }
})
