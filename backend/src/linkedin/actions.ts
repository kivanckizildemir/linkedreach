import type { Page, Response } from 'playwright'
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

  // "Message" button only appears when already connected.
  // Check by aria-label first (fast), then fall back to text content — some LinkedIn
  // UI versions render the button with an empty aria-label but the text "Message".
  const messageBtn = await page.$(SELECTORS.profile.messageButton)
  if (messageBtn) return 'connected'

  try {
    const msgByText = page.locator('main button').filter({ hasText: /^Message$/i })
    if (await msgByText.count() > 0) {
      console.log('[actions] checkConnectionStatus: Message button found by text — connected')
      return 'connected'
    }
  } catch { /* non-fatal */ }

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

  // Early exit: if a "Message" button is visible, we're already connected — no Connect needed.
  // Check by aria-label first, then fall back to text content (some LinkedIn UIs have no aria-label)
  const msgBtnCheck = await page.$(SELECTORS.profile.messageButton)
  if (msgBtnCheck) {
    console.log('[actions] Message button found (aria) — lead is already connected, skipping connect step')
    throw new Error('ALREADY_CONNECTED')
  }
  // Text-based fallback: button with exact "Message" text
  try {
    const msgByText = page.locator('button').filter({ hasText: /^Message$/i })
    if (await msgByText.count() > 0) {
      console.log('[actions] Message button found (text) — lead is already connected, skipping connect step')
      throw new Error('ALREADY_CONNECTED')
    }
  } catch (e) {
    if ((e as Error).message === 'ALREADY_CONNECTED') throw e
    // locator error — ignore and continue
  }

  // Early exit: if a "Pending" button is visible, connection request already sent.
  const pendingBtn = await page.$('button[aria-label*="Pending"], button[aria-label*="pending"]')
  if (pendingBtn) {
    console.log('[actions] Pending button found — connection request already sent')
    throw new Error('CONNECTION_PENDING')
  }

  // Also check for "Withdraw" which LinkedIn shows after sending a request
  const withdrawBtn = await page.$('button[aria-label*="Withdraw"], button[aria-label*="withdraw"]')
  if (withdrawBtn) {
    console.log('[actions] Withdraw button found — connection request already sent')
    throw new Error('CONNECTION_PENDING')
  }

  // Click Connect button (may be nested under "More actions")
  // Strategy 1: Direct "Connect" button by aria-label
  let connectBtn = await page.$(SELECTORS.profile.connectButton)

  // Strategy 2: "Connect" button by text content (handles aria-label changes)
  if (!connectBtn) {
    try {
      const byText = page.locator('button').filter({ hasText: /^Connect$/i })
      if (await byText.count() > 0) {
        connectBtn = await byText.first().elementHandle()
      }
    } catch { /* ignore */ }
  }

  if (!connectBtn) {
    // Strategy 3: Click the profile-section "More" button → look for Connect in dropdown
    // The profile actions "More" button comes after the primary CTA buttons (Message/Connect/Follow)
    // Use JavaScript to find it based on position in the profile header area
    const moreBtnHandle = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'))
      // Find the "More" button closest to the profile header (within ~600px from top of page)
      const candidates = btns.filter(b => {
        const text = b.getAttribute('aria-label') || b.textContent || ''
        return /more/i.test(text) && b.getBoundingClientRect().top < 600
      })
      // Return the last candidate (profile-section "More" comes after nav "More")
      return candidates.at(-1) ?? null
    }).catch(() => null)

    const moreEl = moreBtnHandle ? (moreBtnHandle as Awaited<ReturnType<typeof page.evaluateHandle>>).asElement() : null

    if (!moreEl) {
      const deg = await page.$eval('.dist-value', e => e.textContent?.trim()).catch(() => 'unknown')
      throw new Error(`Connect button not found — may already be connected or pending (degree: ${deg})`)
    }

    await humanMouseMove(page)
    await moreEl.scrollIntoViewIfNeeded()
    await moreEl.click({ timeout: 5000 })
    await delay(1200)  // give dropdown time to render

    // Collect visible elements after More click (for dropdown analysis)
    const allBtnsAfterMore = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], li'))
        .filter(el => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        })
        .map(el => ({
          tag: el.tagName,
          text: el.textContent?.trim().slice(0, 60) ?? '',
          aria: el.getAttribute('aria-label')?.slice(0, 60) ?? '',
        }))
        .filter(el => el.text || el.aria)
    ).catch(() => [] as { tag: string; text: string; aria: string }[])
    // Log only if no connect option found (to diagnose failures)
    const hasConnectOption = allBtnsAfterMore.some(el =>
      /connect|invite/i.test(el.text) && !/disconnect|remove/i.test(el.text)
    )
    if (!hasConnectOption) {
      console.log('[actions] More dropdown (no connect found):', JSON.stringify(allBtnsAfterMore.slice(0, 15)))
    }

    // Look for "Connect" / "Invite to connect" in the now-visible dropdown
    // Try multiple selector strategies
    const dropdownSelectors = [
      '.artdeco-dropdown__content li',
      '[role="menu"] li',
      '[role="listbox"] li',
      '.pvs-overflow-actions-dropdown__content li',
      'div[data-view-name*="overflow"] li',
      'ul.artdeco-dropdown__content--is-dropdown li',
    ]
    for (const sel of dropdownSelectors) {
      const items = await page.$$(sel)
      for (const item of items) {
        const isVis = await item.isVisible().catch(() => false)
        if (!isVis) continue
        const text = await item.textContent().catch(() => '')
        if (text && /connect|invite/i.test(text) && !/disconnect|remove/i.test(text)) {
          connectBtn = item as unknown as Awaited<ReturnType<typeof page.$>>
          console.log(`[actions] Found Connect option via "${sel}": "${text.trim().slice(0, 50)}"`)
          break
        }
      }
      if (connectBtn) break
    }

    // Fallback: scan ALL visible elements
    if (!connectBtn) {
      const allVisible = await page.$$('li, [role="option"], [role="menuitem"], .artdeco-dropdown__content *')
      for (const item of allVisible) {
        const isVis = await item.isVisible().catch(() => false)
        if (!isVis) continue
        const text = await item.textContent().catch(() => '')
        if (text && /connect|invite/i.test(text) && !/disconnect|remove/i.test(text)) {
          connectBtn = item as unknown as Awaited<ReturnType<typeof page.$>>
          console.log(`[actions] Found Connect option (fallback scan): "${text.trim().slice(0, 50)}"`)
          break
        }
      }
    }

    // Check if this might be a "Follow-only" profile (no Connect available)
    if (!connectBtn) {
      const followOnly = allBtnsAfterMore.some(el =>
        /follow/i.test(el.text) && !allBtnsAfterMore.some(e => /connect|invite/i.test(e.text))
      )
      if (followOnly) {
        console.log('[actions] Profile appears to be Follow-only (no Connect option available) — skipping')
        throw new Error('FOLLOW_ONLY_PROFILE')
      }
    }
  }

  if (!connectBtn) throw new Error('Connect option not found in More actions')

  await humanMouseMove(page)
  await connectBtn.click()
  await SHORT_WAIT()

  // LinkedIn connect dialog handling — selectors vary across UI versions
  // Check what state the dialog is in after clicking Connect

  const addNoteBtn = await page.$(SELECTORS.connect.addNoteButton)

  if (note && note.trim() && addNoteBtn) {
    // Add personalized note
    await humanMouseMove(page)
    await addNoteBtn.click()
    await SHORT_WAIT()
    const textarea = await page.$(SELECTORS.connect.noteTextarea)
    if (textarea) {
      await humanType(page, SELECTORS.connect.noteTextarea, note.slice(0, 300))
      await delay(1000 + Math.random() * 1000)
    }
    // Send with note
    const sendBtn = await page.$('button[aria-label="Send invitation"]') ?? await page.$('button[aria-label="Send"]')
    if (sendBtn) {
      await humanMouseMove(page)
      await sendBtn.click()
    }
  } else {
    // Send without note — try multiple selector variants
    const sendNowBtn =
      await page.$('button[aria-label="Send without a note"]') ??
      await page.$('button[aria-label="Send now"]') ??
      await page.$('button[aria-label="Send invite"]') ??
      await page.$('button[aria-label="Connect"]') ??
      null

    if (sendNowBtn) {
      await humanMouseMove(page)
      await sendNowBtn.click()
    } else {
      // Fallback: look for any button with "Send" text in the modal/dialog
      const sendByText = page.locator('[role="dialog"] button, .artdeco-modal button')
        .filter({ hasText: /^(send|connect)/i })
      if (await sendByText.count() > 0) {
        await sendByText.first().click()
      } else {
        // Last resort: press Enter to submit
        await page.keyboard.press('Enter')
      }
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
  const publicId = targetUrl.replace(/\/$/, '').split('/in/').pop()?.split('/')[0] ?? ''

  // ── Strategy 1: LinkedIn Voyager API (no DOM interaction) ─────────────────
  // Intercept Voyager API responses during profile navigation to capture memberUrn.
  // LinkedIn's SPA makes XHR calls that contain the member URN in their responses.
  let memberUrn: string | null = null
  const URN_PATTERNS = [
    /"objectUrn"\s*:\s*"(urn:li:member:\d+)"/,
    /"memberUrn"\s*:\s*"(urn:li:member:\d+)"/,
    /"entityUrn"\s*:\s*"(urn:li:member:\d+)"/,
    /"memberIdentifier"\s*:\s*(\d+)/,  // bare number → wrap as urn:li:member:
  ]
  // fsd_profile entityUrns from newer LinkedIn GraphQL API
  // The base64-encoded ID embeds the numeric member ID at bytes 4-7 (big-endian uint32)
  const FSD_PATTERN = /"entityUrn"\s*:\s*"(urn:li:fsd_profile:[A-Za-z0-9_-]+)"/

  // Decode numeric member ID from LinkedIn fsd_profile base64 URN
  const decodeFsdProfileId = (fsdUrn: string): string | null => {
    try {
      const b64 = fsdUrn.replace('urn:li:fsd_profile:', '').replace(/-/g, '+').replace(/_/g, '/')
      const buf = Buffer.from(b64, 'base64')
      // LinkedIn encodes member IDs at various offsets; try common ones
      for (const offset of [4, 3, 6, 2]) {
        if (buf.length >= offset + 4) {
          const id = buf.readUInt32BE(offset)
          if (id > 100000) return `urn:li:member:${id}`  // sanity check: real IDs are large
        }
      }
      return null
    } catch { return null }
  }

  const extractUrnFromText = (text: string): string | null => {
    // Prefer numeric member URN (works with legacy messaging API)
    for (const p of URN_PATTERNS) {
      const m = text.match(p)
      if (m) {
        return p.source.includes('memberIdentifier') ? `urn:li:member:${m[1]}` : m[1]
      }
    }
    // Fallback: fsd_profile URN — try to decode numeric ID
    const m2 = text.match(FSD_PATTERN)
    if (m2) {
      const decoded = decodeFsdProfileId(m2[1])
      return decoded ?? m2[1]
    }
    return null
  }

  // Use page.route() to intercept GraphQL requests whose POST BODY contains our publicId.
  // This is more reliable than response interception because LinkedIn's GraphQL POST bodies
  // include the profile slug (vanityName / memberIdentity) while responses may not.
  const routeHandler = async (route: import('playwright').Route) => {
    const req = route.request()
    const postData = req.postData() ?? ''
    const reqUrl   = req.url()

    // Check if this request is about our target profile
    const isProfileCall = postData.includes(publicId) || reqUrl.includes(publicId)

    try {
      const response = await route.fetch()
      if (isProfileCall && !memberUrn) {
        const text = await response.text().catch(() => '')
        const found = extractUrnFromText(text)
        if (found) {
          memberUrn = found
          console.log(`[actions] sendMessage: ✓ captured memberUrn ${memberUrn} from ${reqUrl.split('?')[0].slice(-50)} (via route intercept, publicId in POST body)`)
        }
      }
      await route.fulfill({ response })
    } catch {
      await route.continue().catch(() => {})
    }
  }

  // Install route handler, then navigate
  await page.route('**/voyager/api/graphql**', routeHandler)
  await safeNavigate(page, targetUrl, accountId)
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await page.unroute('**/voyager/api/graphql**', routeHandler)

  if (!memberUrn) {
    // Page HTML fallback: React sometimes pre-renders inline JSON in <code> tags
    memberUrn = await page.evaluate(() => {
      const html = document.documentElement.innerHTML
      const patterns: RegExp[] = [
        /"objectUrn"\s*:\s*"(urn:li:member:\d+)"/,
        /"memberUrn"\s*:\s*"(urn:li:member:\d+)"/,
        /"memberIdentifier"\s*:\s*(\d+)/,
      ]
      for (const p of patterns) {
        const m = html.match(p)
        if (m) {
          return p.source.includes('memberIdentifier') ? `urn:li:member:${m[1]}` : m[1]
        }
      }
      // data-member-id attribute fallback
      const el = document.querySelector('[data-member-id]')
      if (el) return `urn:li:member:${el.getAttribute('data-member-id')}`
      return null
    })
    if (memberUrn) console.log(`[actions] sendMessage: resolved memberUrn from page HTML: ${memberUrn}`)
  }

  // Get CSRF token from cookies
  const cookies = await page.context().cookies('https://www.linkedin.com')
  const jsessionid = cookies.find(c => c.name === 'JSESSIONID')?.value ?? ''
  const csrfToken = jsessionid.replace(/^"|"$/g, '').replace(/^ajax:/, '')

  // Try dash/profiles API if still no URN
  if (!memberUrn && publicId && csrfToken) {
    try {
      const dashResp = await page.context().request.get(
        `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${publicId}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.ProfileTabPositionedSections-26`,
        {
          headers: {
            'Accept': 'application/vnd.linkedin.normalized+json+2.1',
            'Csrf-Token': `ajax:${csrfToken}`,
            'x-restli-protocol-version': '2.0.0',
            'Referer': `https://www.linkedin.com/in/${publicId}/`,
          },
        }
      )
      if (dashResp.ok()) {
        const body = await dashResp.text()
        const m = body.match(/"entityUrn"\s*:\s*"(urn:li:member:\d+)"/)
          ?? body.match(/"objectUrn"\s*:\s*"(urn:li:member:\d+)"/)
        if (m) {
          memberUrn = m[1]
          console.log(`[actions] sendMessage: resolved memberUrn from dash API: ${memberUrn}`)
        }
      } else {
        console.warn(`[actions] sendMessage: dash API returned ${dashResp.status()}`)
      }
    } catch (e) {
      console.warn(`[actions] sendMessage: dash API error — ${(e as Error).message}`)
    }
  }

  if (!memberUrn || !csrfToken) {
    console.warn(`[actions] sendMessage: missing memberUrn=${memberUrn} csrfToken=${!!csrfToken} — falling back to DOM`)
    await sendMessageViaDOM(page, targetUrl, profileUrl, accountId, message)
    return
  }

  console.log(`[actions] sendMessage: sending via Voyager API to ${memberUrn}`)

  // Human pause before sending
  await delay(1000 + Math.random() * 2000)

  // POST to the Voyager messaging API using the browser's authenticated session.
  // Try both the legacy and dash endpoints.
  const apiEndpoints = [
    'https://www.linkedin.com/voyager/api/messaging/conversations?action=create',
  ]

  // Build recipient list — fsd_profile URNs use a different wrapping format
  const isFsd = memberUrn.startsWith('urn:li:fsd_profile:')
  const recipientValue = isFsd
    ? { 'com.linkedin.voyager.messaging.create.RecipientCreate': { profileUrn: memberUrn } }
    : memberUrn  // legacy: plain urn:li:member:XXX string

  for (const endpoint of apiEndpoints) {
    let apiResp
    try {
      // Legacy format (urn:li:member:XXX)
      const legacyPayload = {
        keyVersion: 'LEGACY_INBOX',
        conversationCreate: {
          eventCreate: {
            value: {
              'com.linkedin.voyager.messaging.create.MessageCreate': {
                attributedBody: { text: message, attributes: [] },
                attachments: [],
              },
            },
          },
          recipients: isFsd ? [recipientValue] : [memberUrn],
          subtype: 'MEMBER_TO_MEMBER',
        },
      }

      apiResp = await page.context().request.post(endpoint, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.linkedin.normalized+json+2.1',
          'Csrf-Token': `ajax:${csrfToken}`,
          'x-restli-protocol-version': '2.0.0',
          'x-li-lang': 'en_US',
          'Referer': 'https://www.linkedin.com/messaging/',
          'Origin': 'https://www.linkedin.com',
        },
        data: legacyPayload,
      })
    } catch (err) {
      console.warn(`[actions] sendMessage: API request error — ${(err as Error).message}`)
      continue
    }

    if (apiResp.ok()) {
      console.log(`[actions] sendMessage: ✓ API send succeeded (${apiResp.status()}) via ${endpoint}`)
      await detectAndHandleChallenge(page, accountId)
      return
    }

    const body = await apiResp.text().catch(() => '')
    console.warn(`[actions] sendMessage: API ${endpoint} returned ${apiResp.status()} — ${body.slice(0, 300)}`)
  }

  console.warn('[actions] sendMessage: all API attempts failed — falling back to DOM')
  await sendMessageViaDOM(page, targetUrl, profileUrl, accountId, message)
}

/**
 * Fallback: send a message by navigating to the compose URL and interacting with the DOM.
 * Used when the API approach fails (e.g. rate limit, different API version).
 */
async function sendMessageViaDOM(
  page: Page,
  targetUrl: string,
  profileUrl: string,
  accountId: string,
  message: string
): Promise<void> {
  const publicId = targetUrl.replace(/\/$/, '').split('/in/').pop()?.split('/')[0] ?? ''
  const composeUrl = publicId
    ? `https://www.linkedin.com/messaging/compose/?recipient=${encodeURIComponent(publicId)}`
    : null

  let composerFound = false

  if (composeUrl) {
    console.log(`[actions] sendMessageViaDOM: navigating to compose URL for ${publicId}`)
    await safeNavigate(page, composeUrl, accountId)
    await LONG_WAIT()
    const composerEl = await page.waitForSelector('.msg-form__contenteditable', { timeout: 20_000 }).catch(() => null)
    if (composerEl) composerFound = true
  }

  if (!composerFound) {
    // Navigate to profile and click the Message button to open the overlay
    console.warn('[actions] sendMessageViaDOM: falling back to profile page + Message button')
    await safeNavigate(page, targetUrl, accountId)
    await LONG_WAIT()

    let msgBtn =
      await page.$('button[aria-label*="essage"]') ??
      await page.$('a[href*="/messaging/thread/new"]')
    if (!msgBtn) {
      try {
        const byText = page.locator('main button').filter({ hasText: /^Message$/i })
        if (await byText.count() > 0) msgBtn = await byText.first().elementHandle()
      } catch { /* non-fatal */ }
    }
    if (!msgBtn) throw new Error('Message button not found for DOM fallback')
    await msgBtn.click()
    await LONG_WAIT()
    await page.waitForSelector('.msg-form__contenteditable', { timeout: 15_000 }).catch(() => null)
  }

  await delay(500)

  // Diagnostic: log what we see before attempting to type
  const diagInfo = await page.evaluate(() => {
    const sels = ['.msg-form__contenteditable', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]']
    const results: { sel: string; count: number; visible: boolean; inFrame: boolean; rect: string }[] = []
    for (const sel of sels) {
      const els = document.querySelectorAll(sel)
      for (const el of els) {
        const rect = el.getBoundingClientRect()
        results.push({
          sel,
          count: els.length,
          visible: rect.width > 0 && rect.height > 0,
          inFrame: false,  // can't detect cross-origin, but inline frames show up here
          rect: `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}x${Math.round(rect.height)}`,
        })
        break  // just first match per selector
      }
    }
    return { url: location.href, composerCount: results, frameCount: window.frames.length }
  })
  console.log(`[actions] sendMessageViaDOM: page=${diagInfo.url} frames=${diagInfo.frameCount} composers=${JSON.stringify(diagInfo.composerCount)}`)

  // Try to type into the ProseMirror contenteditable
  let typedOk = false
  const COMPOSER_SEL = '.msg-form__contenteditable'

  // Helper: check if text is present in the composer
  const getComposerText = () => page.evaluate((s: string) =>
    (document.querySelector<HTMLElement>(s)?.textContent ?? '').trim(), COMPOSER_SEL
  )

  // ── Strategy A: Physical mouse click + pressSequentially ──────────────────
  // Use actual pixel coordinates to click, then pressSequentially (fires CDP input events).
  // This is the most reliable approach because CDP input events are trusted (isTrusted=true).
  try {
    const loc = page.locator(COMPOSER_SEL).first()
    if (await loc.count() > 0) {
      // Get the actual bounding rect so we can click at the physical center
      const bbox = await loc.boundingBox()
      if (bbox) {
        const cx = bbox.x + bbox.width / 2
        const cy = bbox.y + bbox.height / 2
        console.log(`[actions] sendMessageViaDOM: clicking at physical coords (${Math.round(cx)}, ${Math.round(cy)})`)
        // Expand viewport to ensure the element is visible first
        const vp = page.viewportSize()
        if (vp && cy + bbox.height / 2 > vp.height) {
          await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, Math.ceil(cy + bbox.height + 20)) })
          await delay(200)
        }
        // Physical mouse click at center of element
        await page.mouse.click(cx, cy)
        await delay(400)
        // pressSequentially fires trusted key events via Chrome DevTools Protocol
        await loc.pressSequentially(message, { delay: 40 + Math.random() * 30 })
        await delay(500)
        const textA = await getComposerText()
        if (textA) {
          console.log(`[actions] sendMessageViaDOM: ✓ ${textA.length} chars via physical click + pressSequentially`)
          typedOk = true
        } else {
          console.warn(`[actions] sendMessageViaDOM: physical click strategy left composer empty (bbox=${JSON.stringify(bbox)})`)
        }
      } else {
        console.warn('[actions] sendMessageViaDOM: composerEl has no bounding box')
      }
    }
  } catch (e) {
    console.warn(`[actions] sendMessageViaDOM: Strategy A error — ${(e as Error).message}`)
  }

  // ── Strategy B: execCommand('insertText') with cursor positioned ─────────────
  // Focus + set cursor at end of editor, then execCommand. The key is that
  // ProseMirror checks window.getSelection() before accepting execCommand.
  if (!typedOk) {
    try {
      const inserted = await page.evaluate((msg: string) => {
        const el = document.querySelector<HTMLElement>('.msg-form__contenteditable')
        if (!el) return 'no-element'
        el.focus()
        el.click()
        // Position cursor inside the element so execCommand has a valid selection
        const range = document.createRange()
        const sel = window.getSelection()
        if (sel) {
          range.selectNodeContents(el)
          range.collapse(false)  // collapse to end
          sel.removeAllRanges()
          sel.addRange(range)
        }
        const ok = document.execCommand('insertText', false, msg)
        return ok ? 'ok' : 'execCommand-returned-false'
      }, message)
      await delay(500)
      const textB = await getComposerText()
      if (textB) {
        console.log(`[actions] sendMessageViaDOM: ✓ ${textB.length} chars via execCommand insertText`)
        typedOk = true
      } else {
        console.warn(`[actions] sendMessageViaDOM: execCommand result=${inserted} but composer empty`)
      }
    } catch (e) {
      console.warn(`[actions] sendMessageViaDOM: Strategy B error — ${(e as Error).message}`)
    }
  }

  // ── Strategy C: Playwright fill() on contenteditable ──────────────────────
  // locator.fill() uses CDP's Input.insertText which directly inserts text and
  // fires 'input' events. Works differently from keyboard simulation.
  if (!typedOk) {
    try {
      const loc = page.locator(COMPOSER_SEL).first()
      if (await loc.count() > 0) {
        await loc.focus()
        await delay(200)
        // fill() on contenteditable clears and sets content via CDP insertText
        await loc.fill(message)
        await delay(500)
        const textC = await getComposerText()
        if (textC) {
          console.log(`[actions] sendMessageViaDOM: ✓ ${textC.length} chars via locator.fill()`)
          typedOk = true
        } else {
          // Log DOM state for debugging
          const domState = await page.evaluate(() => {
            const el = document.querySelector<HTMLElement>('.msg-form__contenteditable')
            return {
              textContent: el?.textContent?.length,
              innerHTML: el?.innerHTML?.slice(0, 100),
              activeEl: `${document.activeElement?.tagName}.${document.activeElement?.className?.slice(0,30)}`,
            }
          })
          console.warn(`[actions] sendMessageViaDOM: fill() left composer empty — dom=${JSON.stringify(domState)}`)
        }
      }
    } catch (e) {
      console.warn(`[actions] sendMessageViaDOM: Strategy C error — ${(e as Error).message}`)
    }
  }

  // ── Strategy D: check iframe frames ───────────────────────────────────────
  console.log(`[actions] sendMessageViaDOM: typedOk=${typedOk} — entering Strategy D (frames=${page.frames().length})`)
  if (!typedOk) {
    for (const frame of page.frames()) {
      try {
        const frameUrl = frame.url()
        const loc = frame.locator('.msg-form__contenteditable').first()
        if (await loc.count() === 0) continue
        console.log(`[actions] sendMessageViaDOM: trying frame ${frameUrl.slice(0, 60)}`)
        const bbox = await loc.boundingBox()
        if (bbox) await page.mouse.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2)
        await delay(400)
        await loc.pressSequentially(message, { delay: 40 })
        await delay(500)
        const textD = await frame.evaluate(() =>
          (document.querySelector<HTMLElement>('.msg-form__contenteditable')?.textContent ?? '').trim()
        )
        if (textD) {
          console.log(`[actions] sendMessageViaDOM: ✓ ${textD.length} chars via frame "${frameUrl.slice(0, 40)}"`)
          typedOk = true
          break
        }
      } catch { /* non-fatal */ }
    }
  }

  // ── Strategy E: Clipboard paste via Ctrl+V ───────────────────────────────────
  console.log(`[actions] sendMessageViaDOM: typedOk=${typedOk} — entering Strategy E`)
  // Grant clipboard permissions, write the message to clipboard, focus the
  // composer, then press Ctrl+V. This fires a *real* trusted ClipboardEvent
  // that ProseMirror handles reliably — same path as a user pasting manually.
  if (!typedOk) {
    try {
      const loc = page.locator(COMPOSER_SEL).first()
      if (await loc.count() > 0) {
        // Grant clipboard-write permission so navigator.clipboard.writeText works on LinkedIn (HTTPS)
        try { await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.linkedin.com' }) } catch {}

        // Strategy E1: navigator.clipboard.writeText (requires secure context + permission)
        let clipOk = false
        try {
          await page.evaluate(async (msg: string) => {
            await navigator.clipboard.writeText(msg)
          }, message)
          clipOk = true
        } catch {}

        // Strategy E2 fallback: copy from a hidden textarea via execCommand
        if (!clipOk) {
          await page.evaluate((msg: string) => {
            const ta = document.createElement('textarea')
            ta.value = msg
            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0.01;z-index:99999;width:100px;height:50px'
            document.body.appendChild(ta)
            ta.focus()
            ta.select()
            document.execCommand('copy')
            document.body.removeChild(ta)
          }, message)
        }

        await delay(200)
        // Focus the composer then paste
        await loc.focus()
        await delay(300)
        await page.keyboard.press('Control+v')  // fires trusted ClipboardEvent with clipboard data
        await delay(600)
        const textE = await getComposerText()
        if (textE) {
          console.log(`[actions] sendMessageViaDOM: ✓ ${textE.length} chars via clipboard paste (Ctrl+V)`)
          typedOk = true
        } else {
          console.warn(`[actions] sendMessageViaDOM: clipboard paste left composer empty`)
        }
      }
    } catch (e) {
      console.warn(`[actions] sendMessageViaDOM: Strategy E error — ${(e as Error).message}`)
    }
  }

  if (!typedOk) {
    throw new Error('Message composer empty after all typing strategies — aborting to avoid blank message')
  }

  const composerText = await getComposerText()
  console.log(`[actions] sendMessageViaDOM: ${composerText.length} chars confirmed — sending`)

  await delay(1000 + Math.random() * 2000)

  // Click send button
  const sent = await page.evaluate(() => {
    const selectors = ['button.msg-form__send-button', 'button[aria-label="Send"]', 'button[data-control-name="send"]']
    for (const s of selectors) {
      const btn = document.querySelector<HTMLButtonElement>(s)
      if (btn && !btn.disabled) { btn.click(); return s }
    }
    return null
  })
  if (!sent) {
    await page.evaluate(() => document.querySelector<HTMLElement>('.msg-form__contenteditable')?.focus())
    await page.keyboard.press('Control+Enter')
  }
  console.log(`[actions] sendMessageViaDOM: sent${sent ? ` via "${sent}"` : ' via keyboard shortcut'}`)

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
