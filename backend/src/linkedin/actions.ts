import type { Page } from 'playwright'
import { SELECTORS } from './selectors'
import { detectAndHandleChallenge, safeNavigate } from './session'
import type { ReactionType } from '../types'

export const SHORT_WAIT = () => delay(800 + Math.random() * 1200)
export const LONG_WAIT  = () => delay(2000 + Math.random() * 2000)
export const READ_WAIT  = () => delay(3000 + Math.random() * 5000)   // 3–8s "reading" pause

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Move the mouse to a random position on screen before clicking a target.
 * Avoids teleporting directly onto buttons which is a detectable bot signal.
 */
export async function humanMouseMove(page: Page): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 }
  // Move to a random intermediate point first, then let the caller click the target
  const x = 100 + Math.random() * (viewport.width - 200)
  const y = 100 + Math.random() * (viewport.height - 200)
  await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 10) })
  await delay(100 + Math.random() * 200)
}

/**
 * Simulate a human reading a page — irregular scroll pattern with occasional
 * back-scrolls and variable dwell times between movements.
 */
export async function humanScroll(page: Page): Promise<void> {
  const scrolls = 3 + Math.floor(Math.random() * 3)  // 3–5 scroll movements
  for (let i = 0; i < scrolls; i++) {
    // Occasionally scroll back up a little (1 in 4 chance after first scroll)
    const goUp = i > 0 && Math.random() < 0.25
    const distance = goUp
      ? -(100 + Math.random() * 200)
      : 200 + Math.random() * 400
    await page.evaluate((d) => window.scrollBy({ top: d, behavior: 'smooth' }), distance)
    await delay(600 + Math.random() * 1400)   // 0.6–2s between scrolls
  }
}

/**
 * Human-like typing with occasional typos and backspace corrections.
 * ~5% chance per character of mistyping an adjacent key then correcting it.
 */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  // Adjacent key map for realistic typo simulation
  const adjacentKeys: Record<string, string[]> = {
    a: ['s','q','w'], b: ['v','g','h','n'], c: ['x','d','f','v'], d: ['s','e','r','f','c'],
    e: ['w','r','d','s'], f: ['d','r','t','g','v'], g: ['f','t','y','h','b'], h: ['g','y','u','j','n'],
    i: ['u','o','k','j'], j: ['h','u','i','k','m'], k: ['j','i','o','l'], l: ['k','o','p'],
    m: ['n','j','k'], n: ['b','h','j','m'], o: ['i','p','l','k'], p: ['o','l'],
    q: ['w','a'], r: ['e','t','f','d'], s: ['a','w','e','d','x'], t: ['r','y','g','f'],
    u: ['y','i','h','j'], v: ['c','f','g','b'], w: ['q','e','s','a'], x: ['z','s','d','c'],
    y: ['t','u','g','h'], z: ['a','s','x'],
  }

  await page.click(selector)
  await delay(200 + Math.random() * 300)

  for (const char of text) {
    const lower = char.toLowerCase()
    const neighbours = adjacentKeys[lower]

    // ~5% chance of typo on letters that have adjacent keys
    if (neighbours && Math.random() < 0.05) {
      const typo = neighbours[Math.floor(Math.random() * neighbours.length)]
      await page.keyboard.type(typo, { delay: 40 + Math.random() * 60 })
      await delay(80 + Math.random() * 120)   // brief pause as if noticing the mistake
      await page.keyboard.press('Backspace')
      await delay(60 + Math.random() * 80)
    }

    await page.keyboard.type(char, { delay: 40 + Math.random() * 80 })

    // Occasional longer pause mid-word (1.5% chance) — thinking/hesitating
    if (Math.random() < 0.015) {
      await delay(400 + Math.random() * 600)
    }
  }
}

// ── Resolve Sales Nav URL → real LinkedIn /in/ URL ───────────────────────────

/**
 * On a Sales Nav profile page, click the three-dot (⋯) "More actions" button,
 * then click "View LinkedIn profile" to capture the real /in/ URL.
 * Returns the resolved URL, or null if it couldn't be found.
 *
 * Why: Sales Nav entity IDs can map to different people depending on the session
 * context, so we use LinkedIn's own "View profile" link to get the authoritative URL.
 */
export async function resolveSalesNavUrl(
  page: Page,
  salesNavUrl: string,
  accountId: string
): Promise<string | null> {
  // Navigate to the Sales Nav profile page
  await page.goto(salesNavUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => null)
  await SHORT_WAIT()

  const landed = page.url()
  if (landed.includes('/login') || landed.includes('/checkpoint') || landed.includes('/sales/login')) {
    console.log(`[resolve] Sales Nav session not ready — landed on ${landed.split('?')[0]}`)
    return null
  }

  // Dismiss any overlay popups that might block the UI
  const dismissBtns = await page.$$('button[aria-label*="Dismiss"], button[aria-label*="dismiss"], button[aria-label*="Close"]')
  for (const btn of dismissBtns.slice(0, 3)) {
    await btn.click().catch(() => null)
    await delay(300)
  }

  // ── Strategy 1: any /in/ link directly in the page DOM ───────────────────────
  const allLinks = await page.$$('a[href*="linkedin.com/in/"]')
  for (const link of allLinks) {
    const href = await link.getAttribute('href').catch(() => null)
    if (href && href.includes('/in/') && !href.includes('/in/me')) {
      const url = href.split('?')[0].replace(/\/$/, '')
      console.log(`[resolve] Found direct /in/ link: ${url}`)
      return url
    }
  }

  // ── Strategy 2: three-dot ⋯ → "View LinkedIn profile" ────────────────────────
  // Sales Nav 2024/2025 uses a "More actions" button in the profile topcard area.
  // Scroll to top first so the topcard is visible.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
  await delay(600)

  const moreBtnSelectors = [
    'button[aria-label*="More actions"]',
    'button[aria-label*="more actions"]',
    'button[data-control-name="overflow_actions"]',
    'button[data-control-name*="overflow"]',
    '.profile-topcard__actions button:last-of-type',
    '.profile-topcard__action-btn-container button:last-child',
    '[data-x-context="profile-actions"] button:last-child',
    'button.artdeco-dropdown__trigger[aria-label]',
  ]
  let moreBtn = null
  for (const sel of moreBtnSelectors) {
    moreBtn = await page.$(sel)
    if (moreBtn) { console.log(`[resolve] Found more-btn via: ${sel}`); break }
  }

  if (!moreBtn) {
    // Log all buttons to help diagnose the correct selector
    const btns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b =>
        (b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '').slice(0, 50)
      ).filter(Boolean)
    ).catch(() => [] as string[])
    console.log('[resolve] Three-dot not found. Page buttons:', btns.slice(0, 15).join(' | '))
    return null
  }

  await humanMouseMove(page)
  await moreBtn.click()
  await SHORT_WAIT()

  // Find "View LinkedIn profile" item in the opened dropdown
  let viewLinkedInItem = null
  const menuSelectors = [
    '[data-control-name="view_ql_profile"]',
    'li[data-control-name*="linkedin"]',
    'a[data-control-name*="linkedin"]',
    '.artdeco-dropdown__content a[href*="linkedin.com/in/"]',
    '.artdeco-dropdown__content li:last-child a',
  ]
  for (const sel of menuSelectors) {
    viewLinkedInItem = await page.$(sel)
    if (viewLinkedInItem) break
  }
  if (!viewLinkedInItem) {
    viewLinkedInItem = await page.getByText('View LinkedIn profile', { exact: false }).first().elementHandle().catch(() => null)
  }

  if (!viewLinkedInItem) {
    // Log dropdown items to help diagnose
    const items = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.artdeco-dropdown__content li, .artdeco-dropdown__content a'))
        .map(el => el.textContent?.trim() ?? '').filter(Boolean)
    ).catch(() => [] as string[])
    console.log('[resolve] Dropdown items:', items.join(' | '))
    await page.keyboard.press('Escape')
    return null
  }

  // Click and capture the /in/ URL — may open new tab or same tab
  let resolvedUrl: string | null = null
  try {
    const [newPage] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 8_000 }),
      viewLinkedInItem.click(),
    ])
    await newPage.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => null)
    const newUrl = newPage.url()
    if (newUrl.includes('/in/')) resolvedUrl = newUrl.split('?')[0].replace(/\/$/, '')
    await newPage.close()
  } catch {
    await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => null)
    const currentUrl = page.url()
    if (currentUrl.includes('/in/')) resolvedUrl = currentUrl.split('?')[0].replace(/\/$/, '')
  }

  if (resolvedUrl) {
    console.log(`[resolve] Sales Nav → ${resolvedUrl}`)
  } else {
    console.log('[resolve] Could not extract /in/ URL')
  }

  return resolvedUrl
}

// ── View profile ──────────────────────────────────────────────────────────────

export async function viewProfile(
  page: Page,
  profileUrl: string,
  accountId: string
): Promise<void> {
  await safeNavigate(page, profileUrl, accountId)

  // Initial dwell — simulate landing on page and starting to read (3–8s)
  await READ_WAIT()

  // Irregular scroll pattern simulating a human reading through the profile
  await humanScroll(page)

  // Extra pause at the end as if finishing reading before moving on
  await SHORT_WAIT()
}

// ── Check connection status ───────────────────────────────────────────────────

export async function checkConnectionStatus(
  page: Page,
  profileUrl: string,
  accountId: string
): Promise<'connected' | 'pending' | 'not_connected'> {
  await safeNavigate(page, profileUrl, accountId)
  await SHORT_WAIT()

  // "Message" button only appears when already connected
  const messageBtn = await page.$(SELECTORS.profile.messageButton)
  if (messageBtn) return 'connected'

  // Check if invitation already sent
  const pendingEl = await page.$('button[aria-label*="Pending"]')
  if (pendingEl) return 'pending'

  return 'not_connected'
}

// ── Send connection request ───────────────────────────────────────────────────

export async function sendConnectionRequest(
  page: Page,
  profileUrl: string,
  accountId: string,
  note?: string | null
): Promise<void> {
  await safeNavigate(page, profileUrl, accountId)
  await LONG_WAIT()

  // Brief pause after landing — like a human scanning the profile before acting
  await delay(500 + Math.random() * 1000)

  // Click Connect button (may be nested under "More actions")
  let connectBtn = await page.$(SELECTORS.profile.connectButton)

  if (!connectBtn) {
    // Try More actions menu
    const moreBtn = await page.$(SELECTORS.profile.moreActionsButton)
    if (!moreBtn) throw new Error('Connect button not found — may already be connected or pending')
    await humanMouseMove(page)
    await moreBtn.click()
    await SHORT_WAIT()
    connectBtn = await page.$('div[aria-label*="Connect"]')
  }

  if (!connectBtn) throw new Error('Connect option not found in More actions')

  await humanMouseMove(page)
  await connectBtn.click()
  await SHORT_WAIT()

  if (note && note.trim()) {
    const addNoteBtn = await page.$(SELECTORS.connect.addNoteButton)
    if (addNoteBtn) {
      await humanMouseMove(page)
      await addNoteBtn.click()
      await SHORT_WAIT()
      await humanType(page, SELECTORS.connect.noteTextarea, note.slice(0, 300))
      // Re-read note before sending (1–2s)
      await delay(1000 + Math.random() * 1000)
      await humanMouseMove(page)
      await page.click(SELECTORS.connect.sendButton)
    } else {
      await humanMouseMove(page)
      await page.click(SELECTORS.connect.sendWithoutNote)
    }
  } else {
    const sendBtn = await page.$(SELECTORS.connect.sendWithoutNote)
    if (sendBtn) {
      await humanMouseMove(page)
      await sendBtn.click()
    } else {
      await humanMouseMove(page)
      await page.click(SELECTORS.connect.sendButton)
    }
  }

  await SHORT_WAIT()
  await detectAndHandleChallenge(page, accountId)
}

// ── Send message ──────────────────────────────────────────────────────────────

export async function sendMessage(
  page: Page,
  profileUrl: string,
  accountId: string,
  message: string,
  resolvedLinkedInUrl?: string   // pre-resolved /in/ URL (from Sales Nav three-dot flow)
): Promise<void> {
  const targetUrl = resolvedLinkedInUrl ?? profileUrl

  await safeNavigate(page, targetUrl, accountId)
  await LONG_WAIT()

  // Try several selectors — LinkedIn periodically renames aria-labels
  const msgBtn =
    await page.$('button[aria-label*="essage"]') ??
    await page.$('a[href*="/messaging/thread/new"]') ??
    await page.$('[data-control-name="message"]')

  if (!msgBtn) {
    // Check actual connection status so we can log the right reason
    const status = await checkConnectionStatus(page, profileUrl, accountId)
    if (status !== 'connected') {
      throw new Error(`Message button not found — lead status on LinkedIn: ${status}`)
    }
    throw new Error('Message button not found — lead is connected but button selector may be stale')
  }

  await msgBtn.click()
  await LONG_WAIT()

  await humanType(page, SELECTORS.message.composerTextarea, message)

  // Re-read pause before sending — simulate reviewing what was typed (1–3s)
  await delay(1000 + Math.random() * 2000)

  await page.click(SELECTORS.message.sendButton)
  await SHORT_WAIT()
  await detectAndHandleChallenge(page, accountId)
}

// ── Send InMail ───────────────────────────────────────────────────────────────

export async function sendInMail(
  page: Page,
  profileUrl: string,
  accountId: string,
  subject: string,
  message: string
): Promise<void> {
  // Navigate directly to InMail compose URL
  const profileId = profileUrl.replace(/\/$/, '').split('/').pop()
  await safeNavigate(
    page,
    `https://www.linkedin.com/talent/profile/${profileId}/inmail`,
    accountId
  )
  await LONG_WAIT()

  await humanType(page, SELECTORS.message.subjectInput, subject)
  await SHORT_WAIT()
  await humanType(page, SELECTORS.message.composerTextarea, message)

  // Re-read pause before sending (1–3s)
  await delay(1000 + Math.random() * 2000)

  await page.click(SELECTORS.message.sendButton)
  await SHORT_WAIT()
  await detectAndHandleChallenge(page, accountId)
}

// ── React to post ─────────────────────────────────────────────────────────────

export async function reactToPost(
  page: Page,
  profileUrl: string,
  accountId: string,
  reaction: ReactionType
): Promise<void> {
  await safeNavigate(page, profileUrl, accountId)

  // Land on profile — read it before scrolling to posts (3–8s)
  await READ_WAIT()
  await humanScroll(page)
  await SHORT_WAIT()

  // Scroll to the activity/posts section
  await page.evaluate(() => {
    const sections = document.querySelectorAll('section')
    for (const s of sections) {
      if (s.textContent?.includes('Activity')) {
        s.scrollIntoView({ behavior: 'smooth' })
        break
      }
    }
  })
  await LONG_WAIT()

  // Hover over the Like button to reveal reactions panel
  const likeBtn = await page.$(SELECTORS.post.reactionTrigger)
  if (!likeBtn) throw new Error('No post found to react to')

  await likeBtn.hover()
  await delay(1200)  // Wait for reaction panel to appear

  const reactionSelector = SELECTORS.post.reactionOptions[reaction as keyof typeof SELECTORS.post.reactionOptions]
  const reactionBtn = await page.$(reactionSelector)
  if (!reactionBtn) throw new Error(`Reaction button "${reaction}" not found`)

  await reactionBtn.click()
  await SHORT_WAIT()
  await detectAndHandleChallenge(page, accountId)
}

// ── Follow profile ────────────────────────────────────────────────────────────

export async function followProfile(
  page: Page,
  profileUrl: string,
  accountId: string
): Promise<void> {
  await safeNavigate(page, profileUrl, accountId)
  await LONG_WAIT()

  const followBtn = await page.$(SELECTORS.profile.followButton)
  if (!followBtn) throw new Error('Follow button not found — may already be following')

  await followBtn.click()
  await SHORT_WAIT()
  await detectAndHandleChallenge(page, accountId)
}

// ── Personalise message template ─────────────────────────────────────────────

export function personaliseTemplate(
  template: string,
  vars: { first_name?: string; last_name?: string; company?: string; title?: string; ai_opening?: string; sender_name?: string }
): string {
  return template
    .replace(/\{\{first_name\}\}/g,   vars.first_name   ?? '')
    .replace(/\{\{last_name\}\}/g,    vars.last_name    ?? '')
    .replace(/\{\{company\}\}/g,      vars.company      ?? '')
    .replace(/\{\{title\}\}/g,        vars.title        ?? '')
    .replace(/\{\{ai_opening\}\}/g,   vars.ai_opening   ?? '')
    .replace(/\{\{sender_name\}\}/g,   vars.sender_name  ?? '')
    .replace(/\{\{opening_line\}\}/g,  vars.ai_opening   ?? '')
}
