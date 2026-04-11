/**
 * LinkedReach Chrome Extension — Popup
 *
 * Screens:
 *   screen-loading  → spinner while we check auth / load data
 *   screen-login    → email + password form
 *   screen-main     → account dropdown + context-aware action buttons
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROD_API = 'https://api-production-5994.up.railway.app'

async function apiFetch(path, opts = {}) {
  const { lr_backend, lr_token } = await chrome.storage.local.get(['lr_backend', 'lr_token'])
  const base = (lr_backend || PROD_API).replace(/\/$/, '')
  return fetch(base + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(lr_token ? { Authorization: 'Bearer ' + lr_token } : {}),
      ...(opts.headers || {}),
    },
  })
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'))
  document.getElementById(id).classList.add('active')
}

function bg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
      if (res && res.error) return reject(new Error(res.error))
      resolve(res)
    })
  })
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab || null
}

function setStatus(html, type = 'info') {
  const area = document.getElementById('status-area')
  const cls = type === 'success' ? 'msg-success' : type === 'error' ? 'msg-error' : 'msg-info'
  area.innerHTML = `<div class="msg-box ${cls}">${html}</div>`
}

function clearStatus() {
  document.getElementById('status-area').innerHTML = ''
}

function setButtonLoading(btn, loading, originalText) {
  if (loading) {
    btn.disabled = true
    btn.dataset.originalText = btn.innerHTML
    btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px;"><span class="spinner" style="width:14px;height:14px;border-width:2px;"></span> Working…</span>'
  } else {
    btn.disabled = false
    if (originalText) btn.innerHTML = originalText
    else if (btn.dataset.originalText) btn.innerHTML = btn.dataset.originalText
  }
}

// ── Page detection ────────────────────────────────────────────────────────────

function classifyUrl(url) {
  if (!url) return 'other'
  if (!url.includes('linkedin.com')) return 'not-linkedin'
  const path = new URL(url).pathname
  if (path.startsWith('/sales/search/')) return 'sales-search'
  if (path.startsWith('/sales/')) return 'sales-other'
  if (path.startsWith('/search/results/people')) return 'li-search'
  if (/^\/in\/[^/]/.test(path)) return 'li-profile'
  return 'linkedin-other'
}

function renderPageBadge(type) {
  const badge = document.getElementById('page-badge')
  const text = document.getElementById('page-badge-text')
  badge.className = 'page-badge'

  switch (type) {
    case 'sales-search':
      badge.classList.add('badge-sales')
      text.textContent = 'Sales Navigator Search'
      break
    case 'sales-other':
      badge.classList.add('badge-sales')
      text.textContent = 'Sales Navigator'
      break
    case 'li-profile':
      badge.classList.add('badge-profile')
      text.textContent = 'LinkedIn Profile'
      break
    case 'li-search':
      badge.classList.add('badge-search')
      text.textContent = 'LinkedIn People Search'
      break
    case 'not-linkedin':
      badge.classList.add('badge-other')
      text.textContent = 'Not on LinkedIn'
      break
    default:
      badge.classList.add('badge-other')
      text.textContent = 'LinkedIn'
  }
}

function renderActionButtons(type) {
  const notLinkedIn = document.getElementById('not-linkedin-notice')
  const btnExport = document.getElementById('btn-export-session')
  const btnProfile = document.getElementById('btn-import-profile')

  const isLinkedIn = type !== 'not-linkedin'
  notLinkedIn.style.display = isLinkedIn ? 'none' : ''
  btnExport.style.display = isLinkedIn ? '' : 'none'
  btnProfile.style.display = type === 'li-profile' ? '' : 'none'
}

// ── Account selector ──────────────────────────────────────────────────────────

async function loadAccounts(select) {
  try {
    const { accounts } = await bg({ type: 'GET_ACCOUNTS' })
    select.innerHTML = ''

    if (!accounts || accounts.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = 'No accounts found — add one in LinkedReach'
      select.appendChild(opt)
      return
    }

    for (const acc of accounts) {
      const opt = document.createElement('option')
      opt.value = acc.id
      opt.textContent = acc.linkedin_email + (acc.status !== 'active' ? ` (${acc.status})` : '')
      select.appendChild(opt)
    }

    // Restore last selection
    const { lr_selected_account } = await chrome.storage.local.get('lr_selected_account')
    if (lr_selected_account && [...select.options].some(o => o.value === lr_selected_account)) {
      select.value = lr_selected_account
    }
  } catch (err) {
    const opt = document.createElement('option')
    opt.value = ''
    opt.textContent = 'Failed to load accounts'
    select.innerHTML = ''
    select.appendChild(opt)
    setStatus('Could not load accounts: ' + err.message, 'error')
  }
}


// ── Main init ────────────────────────────────────────────────────────────────

async function init() {
  showScreen('screen-loading')

  // Check auth
  let authResult
  try {
    authResult = await bg({ type: 'GET_AUTH' })
  } catch (_) {
    authResult = { ok: false }
  }

  if (!authResult.ok) {
    showScreen('screen-login')
    return
  }

  // Show user email in header
  if (authResult.user?.email) {
    document.getElementById('header-user-email').textContent = authResult.user.email
  }

  // Detect current tab
  const tab = await getCurrentTab()
  const type = classifyUrl(tab?.url)

  // Show main screen and populate
  showScreen('screen-main')
  renderPageBadge(type)
  renderActionButtons(type)

  // Load accounts
  const select = document.getElementById('account-select')
  await loadAccounts(select)

  // Save account selection on change
  select.addEventListener('change', () => {
    if (select.value) chrome.storage.local.set({ lr_selected_account: select.value })
  })

  // ── Wire up action buttons ────────────────────────────────────────────────

  const btnExport = document.getElementById('btn-export-session')
  btnExport.addEventListener('click', async () => {
    const accountId = select.value
    if (!accountId) { setStatus('Please select an account first.', 'error'); return }
    clearStatus()
    setButtonLoading(btnExport, true)
    try {
      const { cookieCount, hasLocalStorage } = await bg({ type: 'EXPORT_SESSION', accountId, tabId: tab.id })
      setStatus(
        `Session exported. ${cookieCount} cookies captured${hasLocalStorage ? ' + localStorage' : ''}. Account is now active.`,
        'success'
      )
    } catch (err) {
      setStatus(err.message, 'error')
    } finally {
      setButtonLoading(btnExport, false)
    }
  })

  const btnProfile = document.getElementById('btn-import-profile')
  btnProfile.addEventListener('click', async () => {
    const accountId = select.value
    if (!accountId) { setStatus('Please select an account first.', 'error'); return }
    clearStatus()
    setButtonLoading(btnProfile, true)
    try {
      const { imported } = await bg({ type: 'IMPORT_PROFILE', tabId: tab.id })
      setStatus(imported > 0 ? 'Profile imported successfully.' : 'Profile already exists in LinkedReach.', 'success')
    } catch (err) {
      setStatus(err.message, 'error')
    } finally {
      setButtonLoading(btnProfile, false)
    }
  })

  // ── Logout ────────────────────────────────────────────────────────────────
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await bg({ type: 'LOGOUT' })
    showScreen('screen-login')
    document.getElementById('header-user-email').textContent = ''
  })
}


// ── Login screen ──────────────────────────────────────────────────────────────

const WEB_APP_URL = 'https://linkedreach.pages.dev'

// "Open LinkedReach" button — opens the web app so the user can click "Link Extension"
document.getElementById('btn-open-webapp').addEventListener('click', () => {
  chrome.tabs.create({ url: WEB_APP_URL })
})

// Toggle the manual email/password form
document.getElementById('btn-manual-toggle').addEventListener('click', () => {
  const form = document.getElementById('manual-login-form')
  const btn  = document.getElementById('btn-manual-toggle')
  const visible = form.classList.toggle('visible')
  btn.textContent = visible ? 'Hide manual sign in' : 'Sign in with email & password instead'
})

// Manual login form submit
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = document.getElementById('login-email').value.trim()
  const password = document.getElementById('login-password').value
  const errEl = document.getElementById('login-error')
  const btn = document.getElementById('login-btn')

  errEl.style.display = 'none'
  btn.disabled = true
  btn.textContent = 'Signing in…'

  try {
    const { user } = await bg({ type: 'LOGIN', email, password })
    document.getElementById('header-user-email').textContent = user?.email || ''
    // Re-run main init to load accounts etc.
    await init()
  } catch (err) {
    errEl.textContent = err.message
    errEl.style.display = 'block'
    btn.disabled = false
    btn.textContent = 'Sign In'
  }
})

// ── Settings panel ────────────────────────────────────────────────────────────

const PROD_BACKEND = PROD_API  // alias for settings panel
const LOCAL_BACKEND = 'http://localhost:3001'

async function initSettings() {
  const btnGear     = document.getElementById('btn-settings')
  const panel       = document.getElementById('settings-panel')
  const inputBe     = document.getElementById('settings-backend')
  const btnSave     = document.getElementById('btn-save-backend')
  const btnLocal    = document.getElementById('btn-use-local')
  const btnProd     = document.getElementById('btn-use-prod')
  const settingSt   = document.getElementById('settings-status')
  const wsDot       = document.getElementById('ws-dot')

  // Load current backend
  const { lr_backend } = await chrome.storage.local.get('lr_backend')
  inputBe.value = lr_backend || PROD_BACKEND

  // Toggle panel
  btnGear.addEventListener('click', () => panel.classList.toggle('open'))

  async function saveBackend(url) {
    await bg({ type: 'SET_BACKEND', url })
    inputBe.value = url
    settingSt.textContent = 'Saved — reconnecting…'
    setTimeout(() => { settingSt.textContent = '' }, 3000)
  }

  btnSave.addEventListener('click', () => saveBackend(inputBe.value.trim() || PROD_BACKEND))
  btnLocal.addEventListener('click', () => saveBackend(LOCAL_BACKEND))
  btnProd.addEventListener('click',  () => saveBackend(PROD_BACKEND))

  // Poll WS status every 2s
  async function updateWsDot() {
    try {
      const { online } = await bg({ type: 'EXTENSION_STATUS' })
      wsDot.className = 'ws-dot ' + (online ? 'connected' : 'disconnected')
      wsDot.title = online ? 'Hub connected ✓' : 'Hub disconnected'
    } catch {
      wsDot.className = 'ws-dot disconnected'
    }
  }
  updateWsDot()
  setInterval(updateWsDot, 2000)
}

// ── Boot ──────────────────────────────────────────────────────────────────────
initSettings()
init()
