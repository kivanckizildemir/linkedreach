/**
 * LinkedReach — Background Service Worker
 */
const DEFAULT_BACKEND = 'https://api-production-5994.up.railway.app'

async function getConfig() {
  const { lr_backend, lr_token } = await chrome.storage.local.get(['lr_backend', 'lr_token'])
  return { backend: (lr_backend || DEFAULT_BACKEND).replace(/\/$/, ''), token: lr_token || null }
}

async function apiFetch(path, opts = {}) {
  const { backend, token } = await getConfig()
  const res = await fetch(backend + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body,
  })
  return res
}

function cookieToPlaywright(c) {
  return {
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    httpOnly: c.httpOnly, secure: c.secure,
    sameSite: c.sameSite === 'no_restriction' ? 'None' : c.sameSite === 'lax' ? 'Lax' : c.sameSite === 'strict' ? 'Strict' : 'None',
    expires: c.expirationDate ?? -1,
  }
}

function mapLead(raw, fallbackUrl) {
  let first = (raw.firstName ?? '').trim()
  let last  = (raw.lastName  ?? '').trim()
  if (!first && !last) {
    const full = (raw.fullName ?? raw.leadName?.text ?? '').trim()
    if (!full) return null
    const p = full.split(' '); first = p[0] ?? ''; last = p.slice(1).join(' ')
  }
  if (!first && !last) return null

  let title = null
  if (typeof raw.title === 'string') title = raw.title || null
  else if (raw.title?.text)          title = raw.title.text || null
  else if (raw.titleText)            title = raw.titleText || null

  const company = raw.currentPositions?.[0]?.companyName ?? raw.companyName ?? raw.company?.name ?? null
  const location = (typeof raw.location === 'object' ? raw.location?.text : null) ?? raw.geoRegion ?? null

  let linkedin_url = raw.publicProfileUrl ?? raw.profileUrl ?? ''
  if (!linkedin_url) {
    const urn = raw.linkedinMemberUrn ?? raw.memberUrn ?? raw.entityUrn ?? raw.objectUrn ?? ''
    const id = urn.split(':').pop()
    if (id) linkedin_url = 'https://www.linkedin.com/in/' + id + '/'
  }
  if (!linkedin_url) linkedin_url = fallbackUrl ?? ''

  return { first_name: first, last_name: last, title, company, location, linkedin_url, connection_degree: raw.degree ?? raw.memberBadges?.degree ?? null }
}

function parseCaptures(captures) {
  const seen = new Set(); const leads = []
  for (const { url, data } of (captures ?? [])) {
    const items = data?.elements ?? data?.results ?? data?.leadResults ?? []
    for (const item of items) {
      const lead = mapLead(item, url)
      if (lead && lead.linkedin_url && !seen.has(lead.linkedin_url)) {
        seen.add(lead.linkedin_url); leads.push(lead)
      }
    }
  }
  return leads
}

function isTokenExpired(token) {
  try {
    const p = JSON.parse(atob(token.split('.')[1]))
    return p.exp && p.exp * 1000 < Date.now()
  } catch (_) { return false }
}

// ── Main message handler ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg, _sender).then(sendResponse).catch(e => sendResponse({ error: e.message }))
  return true
})

async function handle(msg, sender) {
  switch (msg.type) {

    case 'LOGIN': {
      // Always use DEFAULT_BACKEND for auth — lr_backend is only for API calls
      // after login, so a stale localhost setting never breaks login.
      const res = await fetch(DEFAULT_BACKEND + '/api/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: msg.email, password: msg.password }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Login failed (' + res.status + ')')
      }
      const { access_token, user } = await res.json()
      await chrome.storage.local.set({ lr_token: access_token, lr_user: user })
      return { ok: true, user }
    }

    // Called from the web app via chrome.runtime.sendMessage(extId, ...) to push
    // the user's session token directly — no manual login in the popup needed.
    case 'RECEIVE_AUTH_TOKEN': {
      const { token, user } = msg
      if (!token) throw new Error('No token provided')
      await chrome.storage.local.set({ lr_token: token, lr_user: user })
      // Reconnect WebSocket with the new token
      if (ws) { ws.close(); ws = null }
      clearTimeout(wsReconnectTimer)
      setTimeout(connectWs, 500)
      return { ok: true, user }
    }

    case 'LOGOUT':
      await chrome.storage.local.remove(['lr_token', 'lr_user'])
      return { ok: true }

    case 'GET_AUTH': {
      const { lr_token, lr_user } = await chrome.storage.local.get(['lr_token', 'lr_user'])
      if (!lr_token || isTokenExpired(lr_token)) {
        await chrome.storage.local.remove(['lr_token', 'lr_user'])
        return { ok: false }
      }
      return { ok: true, user: lr_user }
    }

    case 'GET_ACCOUNTS': {
      const res = await apiFetch('/api/accounts')
      if (!res.ok) throw new Error('Failed to load accounts (' + res.status + ')')
      const { data } = await res.json()
      return { accounts: data }
    }

    case 'EXPORT_SESSION': {
      const { accountId, tabId } = msg
      const chromeCookies = await chrome.cookies.getAll({ domain: '.linkedin.com' })
      const cookies = chromeCookies.map(cookieToPlaywright)
      if (!cookies.find(c => c.name === 'li_at')) throw new Error('Not logged into LinkedIn — li_at cookie not found.')

      let origins = []
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'GET_LOCALSTORAGE' })
        if (r?.ok && r.items?.length) origins = [{ origin: 'https://www.linkedin.com', localStorage: r.items }]
      } catch (_) {}

      const storageState = { cookies, origins }
      const res = await apiFetch('/api/accounts/' + accountId, {
        method: 'PATCH',
        body: JSON.stringify({ cookies: JSON.stringify(storageState), status: 'active' }),
      })
      if (!res.ok) throw new Error('Failed to save session (' + res.status + ')')
      return { ok: true, cookieCount: cookies.length, hasLocalStorage: origins.length > 0 }
    }

    case 'IMPORT_PROFILE': {
      const { tabId } = msg
      const reply = await chrome.tabs.sendMessage(tabId, { type: 'GET_PROFILE' })
      if (!reply?.ok || !reply.profile) throw new Error('Could not read profile data from this page.')
      const res = await apiFetch('/api/leads/import', { method: 'POST', body: JSON.stringify({ leads: [reply.profile] }) })
      if (!res.ok) throw new Error('Failed to import lead (' + res.status + ')')
      const { imported } = await res.json()
      return { ok: true, imported }
    }

    case 'CAPTURE_UPDATE': return { ok: true }

    case 'EXTENSION_STATUS': return { online: ws?.readyState === WS_OPEN }

    case 'GET_BACKEND': {
      const { backend } = await getConfig()
      return { backend }
    }

    case 'SET_BACKEND': {
      if (!msg.url) throw new Error('url required')
      await chrome.storage.local.set({ lr_backend: msg.url.replace(/\/$/, '') })
      // Reconnect with new backend
      if (ws) { ws.close(); ws = null }
      clearTimeout(wsReconnectTimer)
      setTimeout(connectWs, 500)
      return { ok: true, backend: msg.url }
    }

    default: throw new Error('Unknown: ' + msg.type)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET AUTOMATION ENGINE
// Connects to the backend hub, receives LinkedIn action jobs, executes them
// in a hidden background window, and reports results back.
// ══════════════════════════════════════════════════════════════════════════════

const WS_OPEN = 1  // WebSocket.OPEN (not available as a global in service workers)
let ws = null
let wsReconnectTimer = null
let bgWindowId = null   // the hidden automation window

// ── WebSocket lifecycle ───────────────────────────────────────────────────────

async function connectWs() {
  const { token } = await getConfig()
  if (!token || isTokenExpired(token)) return  // not logged in

  // Always connect WebSocket to production backend — the extension hub lives on
  // Railway. lr_backend is only used for REST API calls (developer convenience).
  const wsUrl = DEFAULT_BACKEND
    .replace(/^https:\/\//i, 'wss://')
    .replace(/^http:\/\//i,  'ws://')
    + '/ws/extension?token=' + encodeURIComponent(token)

  try {
    ws = new WebSocket(wsUrl)
  } catch (e) {
    console.warn('[LR-WS] Failed to create WebSocket:', e.message)
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    console.log('[LR-WS] Connected to backend hub')
    clearTimeout(wsReconnectTimer)
  }

  ws.onmessage = (event) => {
    let msg
    try { msg = JSON.parse(event.data) } catch { return }

    if (msg.type === 'job')   void executeJob(msg.job)
    if (msg.type === 'pong')  { /* heartbeat ok */ }
    if (msg.type === 'connected') console.log('[LR-WS] Hub acknowledged connection')
  }

  ws.onclose = () => {
    console.log('[LR-WS] Disconnected — will reconnect in 30s')
    scheduleReconnect()
  }

  ws.onerror = (e) => {
    console.warn('[LR-WS] Error:', e.type)
  }
}

function scheduleReconnect() {
  clearTimeout(wsReconnectTimer)
  wsReconnectTimer = setTimeout(connectWs, 30_000)
}

function wsSend(data) {
  if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(data))
}

// ── Background window management ─────────────────────────────────────────────
// All LinkedIn automation runs in a hidden 1×1 popup off-screen.
// The user never sees it — their main Chrome window is unaffected.

async function getOrCreateBgWindow() {
  if (bgWindowId != null) {
    try {
      await chrome.windows.get(bgWindowId)
      return bgWindowId
    } catch {
      bgWindowId = null
    }
  }
  const win = await chrome.windows.create({
    url:     'about:blank',
    type:    'popup',
    width:   1024,
    height:  768,
    focused: false,
  })
  bgWindowId = win.id
  return bgWindowId
}

async function openTab(windowId, url) {
  const tab = await chrome.tabs.create({ windowId, url, active: false })
  // Wait for the tab to finish loading
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Tab load timeout')), 30_000)
    function onUpdated(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        clearTimeout(timeout)
        chrome.tabs.onUpdated.removeListener(onUpdated)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
  })
  return tab.id
}

async function closeTab(tabId) {
  try { await chrome.tabs.remove(tabId) } catch { /* already closed */ }
}

// ── Action executor ───────────────────────────────────────────────────────────

async function executeJob(job) {
  const { jobId, action, profileUrl, note, message, reaction } = job
  console.log(`[LR-Ext] Executing ${action} → ${profileUrl}`)

  try {
    const windowId = await getOrCreateBgWindow()
    let result

    switch (action) {
      case 'view_profile':
        result = await actionViewProfile(windowId, profileUrl)
        break
      case 'follow':
        result = await actionFollow(windowId, profileUrl)
        break
      case 'connect':
        result = await actionConnect(windowId, profileUrl, note)
        break
      case 'message':
        result = await actionMessage(windowId, profileUrl, message)
        break
      case 'react_post':
        result = await actionReactPost(windowId, profileUrl, reaction || 'like')
        break

      case 'export_session': {
        // Export the current LinkedIn session cookies directly to the account
        const { accountId } = job
        const chromeCookies = await chrome.cookies.getAll({ domain: '.linkedin.com' })
        const cookies = chromeCookies.map(cookieToPlaywright)
        if (!cookies.find(c => c.name === 'li_at')) throw new Error('No LinkedIn session found. Please log in to linkedin.com first.')

        let origins = []
        try {
          const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' })
          if (tabs.length > 0) {
            const r = await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_LOCALSTORAGE' })
            if (r?.ok && r.items?.length) origins = [{ origin: 'https://www.linkedin.com', localStorage: r.items }]
          }
        } catch (_) { /* localStorage is optional */ }

        const storageState = { cookies, origins }
        const saveRes = await apiFetch('/api/accounts/' + accountId, {
          method: 'PATCH',
          body: JSON.stringify({ cookies: JSON.stringify(storageState), status: 'active' }),
        })
        if (!saveRes.ok) throw new Error('Failed to save session (' + saveRes.status + ')')
        result = { ok: true, cookieCount: cookies.length, hasLocalStorage: origins.length > 0 }
        break
      }

      default:
        throw new Error('Unknown action: ' + action)
    }

    wsSend({ type: 'result', jobId, success: true, data: result })
  } catch (err) {
    console.error(`[LR-Ext] ${action} failed:`, err.message)
    wsSend({ type: 'result', jobId, success: false, error: err.message })
  }
}

// ── LinkedIn DOM helpers (injected via chrome.scripting.executeScript) ────────

async function injectScript(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  })
  return results?.[0]?.result
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Individual actions ────────────────────────────────────────────────────────

async function actionViewProfile(windowId, profileUrl) {
  const tabId = await openTab(windowId, profileUrl)
  await sleep(2000 + Math.random() * 2000)  // human-like pause

  // Check for warnings/captchas
  const warning = await injectScript(tabId, () => {
    return !!(
      document.querySelector('.captcha-internal') ||
      document.querySelector('[data-test-id="checkpoint"]') ||
      document.title.toLowerCase().includes('checkpoint')
    )
  })

  await closeTab(tabId)
  if (warning) return { warning: true }
  return { success: true }
}

async function actionFollow(windowId, profileUrl) {
  const tabId = await openTab(windowId, profileUrl)
  await sleep(1500 + Math.random() * 1500)

  const result = await injectScript(tabId, () => {
    // Find Follow button (not "Following" or "Connect")
    const buttons = Array.from(document.querySelectorAll('button'))
    const followBtn = buttons.find(b => {
      const txt = b.textContent?.trim()
      return txt === 'Follow' || txt?.startsWith('Follow ')
    })
    if (!followBtn) return { skipped: true, reason: 'follow_button_not_found' }
    followBtn.click()
    return { success: true }
  })

  await sleep(1000)
  await closeTab(tabId)
  return result
}

async function actionConnect(windowId, profileUrl, note) {
  const tabId = await openTab(windowId, profileUrl)
  await sleep(2000 + Math.random() * 2000)

  const result = await injectScript(tabId, (noteText) => {
    // Find Connect button
    const buttons = Array.from(document.querySelectorAll('button'))
    const connectBtn = buttons.find(b => b.textContent?.trim() === 'Connect')
    if (!connectBtn) {
      // May be inside "More" dropdown
      const moreBtn = buttons.find(b => b.textContent?.trim() === 'More')
      if (moreBtn) {
        moreBtn.click()
        return { needsMore: true }
      }
      return { skipped: true, reason: 'connect_button_not_found' }
    }
    connectBtn.click()
    return { clicked: true, noteText }
  }, [note || ''])

  if (result?.needsMore) {
    // Re-inject after "More" menu opens
    await sleep(800)
    const result2 = await injectScript(tabId, () => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
      const connectItem = items.find(el => el.textContent?.trim() === 'Connect')
      if (!connectItem) return { skipped: true, reason: 'connect_not_in_menu' }
      connectItem.click()
      return { clicked: true }
    })
    if (!result2?.clicked) { await closeTab(tabId); return result2 }
  }

  if (result?.skipped) { await closeTab(tabId); return result }

  // Handle the connection dialog
  await sleep(1200)
  const dialogResult = await injectScript(tabId, (noteText) => {
    // If "Add a note" modal appeared
    const addNoteBtn = document.querySelector('button[aria-label="Add a note"]')
    if (addNoteBtn && noteText) {
      addNoteBtn.click()
      return { addingNote: true }
    }
    // Send without note
    const sendBtn = document.querySelector('button[aria-label="Send without a note"]')
      || Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Send without a note')
    if (sendBtn) { sendBtn.click(); return { sent: true } }
    return { sent: false }
  }, [note || ''])

  if (dialogResult?.addingNote && note) {
    await sleep(600)
    await injectScript(tabId, (noteText) => {
      const textarea = document.querySelector('textarea[name="message"]')
        || document.querySelector('#custom-message')
      if (textarea) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        nativeSetter?.call(textarea, noteText)
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }, [note])
    await sleep(400)
    await injectScript(tabId, () => {
      const sendBtn = document.querySelector('button[aria-label="Send invitation"]')
        || Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Send')
      sendBtn?.click()
      return { sent: true }
    })
  }

  await sleep(1500)
  await closeTab(tabId)
  return { success: true }
}

async function actionMessage(windowId, profileUrl, messageText) {
  if (!messageText) throw new Error('No message content provided')

  const tabId = await openTab(windowId, profileUrl)
  await sleep(2000 + Math.random() * 1500)

  const result = await injectScript(tabId, (text) => {
    // Find the Message button on the profile
    const buttons = Array.from(document.querySelectorAll('button'))
    const msgBtn  = buttons.find(b => b.textContent?.trim() === 'Message')
    if (!msgBtn) return { skipped: true, reason: 'message_button_not_found' }
    msgBtn.click()
    return { clicked: true }
  }, [messageText])

  if (result?.skipped) { await closeTab(tabId); return result }

  await sleep(1500)

  // Type and send the message
  const sendResult = await injectScript(tabId, (text) => {
    const editor = document.querySelector('.msg-form__contenteditable[contenteditable="true"]')
      || document.querySelector('[data-placeholder="Write a message…"]')
    if (!editor) return { error: 'message_editor_not_found' }

    editor.focus()
    document.execCommand('insertText', false, text)
    editor.dispatchEvent(new Event('input', { bubbles: true }))

    // Small delay then click Send
    return { typed: true }
  }, [messageText])

  if (sendResult?.error) { await closeTab(tabId); throw new Error(sendResult.error) }

  await sleep(600)
  await injectScript(tabId, () => {
    const sendBtn = document.querySelector('button.msg-form__send-button')
      || document.querySelector('[data-control-name="send-message-from-thread"]')
      || Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Send')
    sendBtn?.click()
    return { sent: true }
  })

  await sleep(1000)
  await closeTab(tabId)
  return { success: true }
}

async function actionReactPost(windowId, profileUrl, reaction) {
  const tabId = await openTab(windowId, profileUrl)
  await sleep(2500 + Math.random() * 1500)

  const result = await injectScript(tabId, (reactionType) => {
    // Find the first "Like" reaction button on the most recent post
    const likeBtn = document.querySelector('button[aria-label*="Like"]')
      || document.querySelector('.react-button__trigger')
    if (!likeBtn) return { skipped: true, reason: 'no_post_found' }

    // Hover to open reaction picker (if not just 'like')
    if (reactionType !== 'like') {
      likeBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      return { hovered: true, reactionType }
    }

    likeBtn.click()
    return { reacted: true, reaction: 'like' }
  }, [reaction])

  if (result?.hovered) {
    await sleep(1000)  // wait for reaction picker to appear
    await injectScript(tabId, (reactionType) => {
      const btn = document.querySelector(`button[aria-label="${reactionType}"]`)
        || document.querySelector(`[data-reaction-type="${reactionType}"]`)
      btn?.click()
      return { reacted: true, reaction: reactionType }
    }, [reaction])
  }

  await sleep(1000)
  await closeTab(tabId)
  return { success: true }
}

// ── Auto-connect WebSocket on startup + after auth ────────────────────────────

// Clear stale lr_backend=localhost on startup — regular users don't need it and
// it causes "Failed to fetch" / WS connection errors when no local server runs.
async function clearStaleLocalBackend() {
  const { lr_backend } = await chrome.storage.local.get('lr_backend')
  if (lr_backend && /localhost|127\.0\.0\.1/.test(lr_backend)) {
    await chrome.storage.local.remove('lr_backend')
    console.log('[LR] Cleared stale lr_backend (was pointing to localhost)')
  }
}

chrome.runtime.onStartup.addListener(() => {
  clearStaleLocalBackend().then(() => setTimeout(connectWs, 2000))
})

chrome.runtime.onInstalled.addListener(() => {
  clearStaleLocalBackend().then(() => setTimeout(connectWs, 2000))
})

// Also connect whenever the token changes (user logs in/out)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.lr_token) {
    if (ws) { ws.close(); ws = null }
    if (changes.lr_token.newValue) {
      setTimeout(connectWs, 500)
    }
  }
})

// ── MV3 service worker keepalive via alarms ───────────────────────────────────
// setInterval() is unreliable in MV3 service workers — use alarms instead.
// The alarm fires every 25s to send the WS ping and keep the SW alive.
chrome.alarms.create('lr-keepalive', { periodInMinutes: 0.4 })  // ~25s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'lr-keepalive') return
  // If WS is open, ping to keep alive. If not, reconnect.
  if (ws && ws.readyState === WS_OPEN) {
    wsSend({ type: 'ping' })
  } else {
    void connectWs()
  }
})

// Initial connection attempt
setTimeout(connectWs, 1000)
