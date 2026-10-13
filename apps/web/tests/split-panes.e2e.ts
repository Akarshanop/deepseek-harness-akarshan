/** Split Conversation panes through the shipped Web composition. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/cordis-tool-round/session.v3.jsonl', import.meta.url))
const IDS = ['split-a', 'split-b', 'split-c', 'split-d', 'split-e']
const ADD = 'Open a session side by side'

describe.skipIf(webSnapshotMode() === 'record')('web e2e: split Conversation panes', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  const composers = () => page.locator('[data-composer-input][contenteditable="true"]')
  const sessionRows = () => page.locator('[data-row-key^="session:"]')
  const emptyComposers = () => page.locator('[data-composer-placeholder]')

  /** Type into one empty composer, expect only its placeholder to go, then empty it again. */
  async function typeInto(index: number, text: string): Promise<void> {
    const total = await composers().count()
    await composers().nth(index).click()
    await expect.poll(() => emptyComposers().count()).toBe(total)
    await page.keyboard.type(text)
    await expect.poll(() => emptyComposers().count()).toBe(total - 1)
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    await expect.poll(() => emptyComposers().count()).toBe(total)
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(FIXTURE, 'utf8')
    for (const [index, id] of IDS.entries()) {
      await seedSession(scaffold, fixture, id, undefined, { createdAt: Date.now() - (index + 1) * 60_000 })
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    // The Ungrouped folder starts collapsed.
    await page.getByRole('treeitem', { name: /Ungrouped/ }).click()
    await sessionRows().nth(IDS.length - 1).waitFor()
    await sessionRows().first().click()
    await composers().first().waitFor()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('adds panes past three, each a third wide, and scrolls them sideways', async () => {
    onTestFailed(() => saveFailureShot(page, 'split-panes-add'))
    for (let expected = 1; expected <= IDS.length - 1; expected++) {
      await page.getByLabel(ADD).click()
      await page.getByRole('button', { name: 'dsh-web-e2e' }).first().click()
      await expect.poll(() => page.locator('[data-split-pane]').count()).toBe(expected)
    }
    await expect.poll(() => composers().count()).toBe(IDS.length)
    const scroller = page.locator('[data-split-pane]').first().locator('xpath=..')
    const metrics = await scroller.evaluate(node => ({
      client: node.clientWidth, scroll: node.scrollWidth,
      widths: [...node.children].map(child => Math.round(child.getBoundingClientRect().width)),
    }))
    expect(metrics.scroll).toBeGreaterThan(metrics.client)
    for (const width of metrics.widths) expect(Math.abs(width - metrics.client / 3)).toBeLessThan(2)
    await page.getByLabel(ADD).waitFor()
    const viewport = page.viewportSize()!
    for (let index = 0; index < IDS.length; index++) {
      await composers().nth(index).scrollIntoViewIfNeeded()
      const box = (await composers().nth(index).boundingBox())!
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    }
  })

  it('clears the placeholder while typing in every pane', async () => {
    onTestFailed(() => saveFailureShot(page, 'split-panes-typing'))
    for (let index = 0; index < IDS.length; index++) await typeInto(index, `hello ${index}`)
  })

  it('gives every Session a color shown in its header and sidebar row, and lets the user change it', async () => {
    onTestFailed(() => saveFailureShot(page, 'split-panes-colors'))
    const bars = page.locator('[data-session-color-bar]')
    await expect.poll(() => bars.count()).toBe(IDS.length)
    const colors = await page.evaluate(ids => ids.map(id => getComputedStyle(document.documentElement)
      .getPropertyValue(`--dsh-session-color-${id.replace(/[^\w-]/gu, '_')}`).trim()), IDS)
    for (const color of colors) expect(color).toMatch(/^#[0-9a-f]{6}$/u)
    expect(new Set(colors).size).toBe(IDS.length)
    // Header bar and sidebar dot paint the same color as the property.
    const painted = await bars.first().evaluate(node => getComputedStyle(node).backgroundColor)
    const rowDot = await sessionRows().first().locator('[class*="colorDot"]').evaluate(node => getComputedStyle(node).backgroundColor)
    expect(rowDot).toBe(painted)
    // Pick another color from the first pane's dot.
    await page.locator('[data-session-color-dot] button').first().click()
    await page.getByRole('button', { name: 'Color #a855f7' }).click()
    await expect.poll(() => bars.first().evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(168, 85, 247)')
    await expect.poll(() => sessionRows().first().locator('[class*="colorDot"]').evaluate(node => getComputedStyle(node).backgroundColor))
      .toBe('rgb(168, 85, 247)')
  })

  it('restores the panes and colors after a reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'split-panes-reload'))
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => page.locator('[data-split-pane]').count()).toBe(IDS.length - 1)
    await expect.poll(() => composers().count()).toBe(IDS.length)
    await expect.poll(() => page.locator('[data-session-color-bar]').first().evaluate(node => getComputedStyle(node).backgroundColor))
      .toBe('rgb(168, 85, 247)')
  })

  it('keeps every pane where it is when the sidebar selects a Session, and shows where it went', async () => {
    onTestFailed(() => saveFailureShot(page, 'split-panes-duplicate'))
    await expect.poll(() => sessionRows().count()).toBe(IDS.length)
    const arrangement = () => page.locator('[data-pane-session]').evaluateAll(
      nodes => nodes.map(node => node.getAttribute('data-pane-session')),
    )
    const before = await arrangement()
    expect(new Set(before).size).toBe(IDS.length)
    for (let row = 0; row < IDS.length; row++) {
      await sessionRows().nth(row).click()
      await expect.poll(() => composers().count()).toBe(IDS.length)
      // One Conversation per Session, in the same order as before the click.
      const shown = await page.locator('[data-conversation-session]').evaluateAll(
        nodes => nodes.map(node => node.getAttribute('data-conversation-session')),
      )
      expect(new Set(shown).size).toBe(shown.length)
      expect(await arrangement()).toEqual(before)
      // The selected Session's pane glows and is scrolled into view.
      const clicked = (await sessionRows().nth(row).getAttribute('data-row-key'))!.slice('session:'.length)
      const glowing = page.locator(`[data-pane-session="${clicked}"] [data-pane-flash]`)
      await glowing.waitFor({ timeout: 3000 })
      await expect.poll(async () => {
        const box = await page.locator(`[data-pane-session="${clicked}"]`).boundingBox()
        const scroller = await page.locator('[data-pane-session]').first().locator('xpath=..').boundingBox()
        return box !== null && scroller !== null && box.x >= scroller.x - 2 && box.x + box.width <= scroller.x + scroller.width + 2
      }).toBe(true)
      // The glow fades by itself.
      await expect.poll(() => page.locator('[data-pane-flash]').count(), { timeout: 5000 }).toBe(0)
      for (let index = 0; index < IDS.length; index++) await typeInto(index, 'x')
    }
    expect(tripwire.pageErrors).toEqual([])
  })
})

describe.skipIf(webSnapshotMode() === 'record')('web e2e: new session from the split picker', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(FIXTURE, 'utf8')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    for (const id of ['picker-a', 'picker-b']) {
      await seedSession(scaffold, fixture, id)
      await workspace.attachSession(SessionId(id))
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-row-key^="session:"]').first().click()
    await page.locator('[data-composer-input]').first().waitFor()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('creates a blank Session in a new pane without leaving the selected one', async () => {
    onTestFailed(() => saveFailureShot(page, 'split-panes-new-session'))
    const selected = () => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId)
    const before = await selected()
    const known = scaffold.ctx.workspaceRegistry.list()[0]!.sessionIds.length
    await page.getByLabel(ADD).click()
    await page.locator('[data-split-new]').click()
    await expect.poll(() => page.locator('[data-split-pane]').count()).toBe(1)
    await expect.poll(() => scaffold.ctx.workspaceRegistry.list()[0]!.sessionIds.length).toBe(known + 1)
    expect(await selected()).toBe(before)
    await expect.poll(() => page.locator('[data-composer-input][contenteditable="true"]').count()).toBe(2)
    // The picker closed itself after creating.
    expect(await page.locator('[data-split-new]').count()).toBe(0)
  })
})

describe.skipIf(webSnapshotMode() === 'record')('web e2e: open Sessions stay open as tabs', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  const TABS = ['tab-a', 'tab-b', 'tab-c']

  const rows = () => page.locator('[data-row-key^="session:"]')
  const open = () => page.locator('[data-pane-session]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-session')))
  const keyOf = async (index: number) => (await rows().nth(index).getAttribute('data-row-key'))!.slice('session:'.length)
  const composers = () => page.locator('[data-composer-input][contenteditable="true"]')

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(FIXTURE, 'utf8')
    for (const [index, id] of TABS.entries()) {
      await seedSession(scaffold, fixture, id, undefined, { createdAt: Date.now() - (index + 1) * 60_000 })
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('treeitem', { name: /Ungrouped/ }).click()
    await rows().nth(TABS.length - 1).waitFor()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('replaces the selected Session while only one is open, then appends once a split view exists', async () => {
    onTestFailed(() => saveFailureShot(page, 'split-panes-tabs'))
    const keys = [await keyOf(0), await keyOf(1), await keyOf(2)]
    await rows().nth(0).click()
    await expect.poll(() => open()).toEqual([keys[0]])
    await rows().nth(1).click()
    await expect.poll(() => open()).toEqual([keys[1]])
    // Open a second Session next to it; from now on selections are added on the right.
    await page.getByLabel(ADD).click()
    await page.getByRole('button', { name: 'dsh-web-e2e' }).first().click()
    await expect.poll(() => open().then(list => list.length)).toBe(2)
    const second = (await open())[1]!
    const third = keys.find(key => key !== keys[1] && key !== second)!
    await rows().nth(keys.indexOf(third)).click()
    await expect.poll(() => open()).toEqual([keys[1], second, third])
    await page.locator(`[data-pane-session="${third}"] [data-pane-flash]`).waitFor({ timeout: 3000 })
    await expect.poll(() => composers().count()).toBe(TABS.length)
  })

  it('keeps all of them open, in the same order, after a reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'split-panes-tabs-reload'))
    const before = await open()
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => composers().count()).toBe(TABS.length)
    expect(await open()).toEqual(before)
  })

  it('closes only the tab whose close button is pressed', async () => {
    onTestFailed(() => saveFailureShot(page, 'split-panes-tabs-close'))
    const [first, middle, last] = await open()
    await page.locator(`[data-pane-session="${middle}"] button[aria-label="Close this pane"]`).click()
    await expect.poll(() => open()).toEqual([first, last])
    // The selected Session is the last one; closing it selects its neighbor.
    await page.locator(`[data-pane-session="${last}"] button[aria-label="Close this pane"]`).click()
    await expect.poll(() => open()).toEqual([first])
    await expect.poll(() => composers().count()).toBe(1)
    expect(await page.locator('button[aria-label="Close this pane"]').count()).toBe(0)
  })
})
