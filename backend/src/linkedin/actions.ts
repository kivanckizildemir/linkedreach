import type { Page } from 'playwright'
import { SELECTORS } from './selectors'
import { detectAndHandleChallenge, safeNavigate } from './session'
import type { ReactionType } from '../types'

const SHORT_WAIT = () => delay(800 + Math.random() * 1200)
const LONG_WAIT  = () => delay(2000 + Math.random() * 2000)

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Human-like typing: type one character at a time with random pauses. */
async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector)
  for (const char of text) {
    await page.keyboard.type(char, { delay: 40 + Math.random() * 80 })
  }
}

// ── View profile ──────────────────────────────────────────────────────────────

export async function viewProfile(
  page: Page,
  profileUrl: string,
  accountId: string
): Promise<void> {
  await safeNavigate(page, profileUrl, accountId)
  await LONG_WAIT()

  // Scroll a bit to simulate reading the profile
  await page.evaluate(() => window.scrollBy(0, 400 + Math.random() * 300))
  await SHORT_WAIT()
  await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 200))
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

  // Click Connect button (may be nested under "More actions")
  let connectBtn = await page.$(SELECTORS.profile.connectButton)

  if (!connectBtn) {
    // Try More actions menu
    const moreBtn = await page.$(SELECTORS.profile.moreActionsButton)
    if (!moreBtn) throw new Error('Connect button not found — may already be connected or pending')
    await moreBtn.click()
    await SHORT_WAIT()
    connectBtn = await page.$('div[aria-label*="Connect"]')
  }

  if (!connectBtn) throw new Error('Connect option not found in More actions')

  await connectBtn.click()
  await SHORT_WAIT()

  if (note && note.trim()) {
    const addNoteBtn = await page.$(SELECTORS.connect.addNoteButton)
    if (addNoteBtn) {
      await addNoteBtn.click()
      await SHORT_WAIT()
      await humanType(page, SELECTORS.connect.noteTextarea, note.slice(0, 300))
      await SHORT_WAIT()
      await page.click(SELECTORS.connect.sendButton)
    } else {
      await page.click(SELECTORS.connect.sendWithoutNote)
    }
  } else {
    const sendBtn = await page.$(SELECTORS.connect.sendWithoutNote)
    if (sendBtn) {
      await sendBtn.click()
    } else {
      // Some flows go straight to send
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
  message: string
): Promise<void> {
  await safeNavigate(page, profileUrl, accountId)
  await LONG_WAIT()

  const msgBtn = await page.$(SELECTORS.profile.messageButton)
  if (!msgBtn) throw new Error('Message button not found — lead may not be connected')

  await msgBtn.click()
  await LONG_WAIT()

  await humanType(page, SELECTORS.message.composerTextarea, message)
  await SHORT_WAIT()

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
  await SHORT_WAIT()

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
  await LONG_WAIT()

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
