import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'
import { preview } from 'vite'
import { chromium } from 'playwright'

const storageKey = 'sme-ui-language'
const labels = {
  vi: {
    submit: 'Đăng nhập',
    password: 'Mật khẩu',
    language: 'Ngôn ngữ giao diện',
  },
  en: {
    submit: 'Sign in',
    password: 'Password',
    language: 'Interface language',
  },
}

async function checkSignIn(page, language) {
  const label = labels[language]
  const submit = page.getByRole('button', { name: label.submit, exact: true })
  await submit.waitFor({ state: 'visible' })
  assert.equal(await page.locator('html').getAttribute('lang'), language)
  const email = page.getByLabel('Email', { exact: true })
  const password = page.getByLabel(label.password, { exact: true })
  for (const control of [email, password, submit]) {
    const bounds = await control.boundingBox()
    assert.ok(bounds, 'Expected a visible sign-in control')
    assert.ok(bounds.x >= -1, 'Control clips past the left edge')
    assert.ok(
      bounds.x + bounds.width <= page.viewportSize().width + 1,
      'Control clips past the right edge'
    )
  }
  assert.ok(
    await submit.evaluate((element) => {
      return element.scrollWidth <= element.clientWidth + 1
    }),
    'Submit label overflows'
  )
  return email
}

async function changeLanguage(page, from, to) {
  await page.getByRole('button', { name: labels[from].language }).click()
  await page
    .getByRole('menuitemradio', { name: to === 'en' ? 'English' : 'Tiếng Việt' })
    .click()
  await checkSignIn(page, to)
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), storageKey),
    to
  )
}

test('production localization startup and responsive sign-in', async (t) => {
  // Serve the real production bundle, not a React fixture or Vitest iframe.
  const server = await preview({
    configFile: false,
    preview: { host: '127.0.0.1', port: 0, strictPort: true },
  })
  t.after(() => {
    return new Promise((resolve, reject) => {
      server.httpServer.close((error) => (error ? reject(error) : resolve()))
    })
  })
  const address = server.httpServer.address()
  assert.ok(address && typeof address !== 'string')
  const origin = 'http://127.0.0.1:' + address.port
  const browser = await chromium.launch()
  t.after(() => browser.close())
  await mkdir('test-results/localization', { recursive: true })

  async function withPage(options, run) {
    const context = await browser.newContext({
      locale: 'en-US',
      ...options,
    })
    const unexpected = []
    const pageErrors = []
    try {
      // Use an anonymous Core API fixture and prohibit unexpected operations.
      // External fonts are deliberately excluded from this deterministic gate;
      // the screenshots exercise the configured font stack and its fallback.
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.origin !== origin) return route.abort()
        if (!url.pathname.startsWith('/api/')) return route.continue()
        if (
          url.pathname === '/api/v1/auth/me' &&
          route.request().method() === 'GET'
        ) {
          return route.fulfill({
            status: 401,
            json: {
              success: false,
              code: 'AUTH_SESSION_EXPIRED',
              message: 'Authentication required.',
              data: null,
              meta: {
                requestId: 'startup-fixture',
                timestamp: '2026-01-01T00:00:00Z',
              },
            },
          })
        }
        unexpected.push(route.request().method() + ' ' + url.pathname)
        return route.abort()
      })
      const page = await context.newPage()
      page.on('pageerror', (error) => pageErrors.push(error.message))
      await page.goto(origin + '/sign-in')
      await run(page)
      assert.deepEqual(unexpected, [], 'Unexpected Core API operations')
      assert.deepEqual(pageErrors, [], 'Uncaught browser errors')
    } finally {
      await context.close()
    }
  }

  for (const [width, height] of [
    [360, 640],
    [768, 900],
    [1440, 900],
  ]) {
    await t.test(
      `clean browser and language persistence at ${width}px`,
      async () => {
        await withPage({ viewport: { width, height } }, async (page) => {
          const email = await checkSignIn(page, 'vi')
          assert.equal(
            await page.evaluate((key) => localStorage.getItem(key), storageKey),
            null
          )
          await email.fill('employee@example.test')
          await changeLanguage(page, 'vi', 'en')
          assert.equal(await email.inputValue(), 'employee@example.test')
          await page.reload()
          await checkSignIn(page, 'en')
          await page.screenshot({
            path: `test-results/localization/sign-in-en-${width}.png`,
            fullPage: true,
          })
          await changeLanguage(page, 'en', 'vi')
          await page.reload()
          await checkSignIn(page, 'vi')
          await page.screenshot({
            path: `test-results/localization/sign-in-vi-${width}.png`,
            fullPage: true,
          })
        })
      }
    )
  }

  await t.test('invalid persisted language starts in Vietnamese', async () => {
    await withPage(
      {
        storageState: {
          cookies: [],
          origins: [
            {
              origin,
              localStorage: [{ name: storageKey, value: 'vi-VN' }],
            },
          ],
        },
      },
      (page) => checkSignIn(page, 'vi')
    )
  })
})
