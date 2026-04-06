/**
 * LinkedReach Chrome Extension — Popup
 *
 * Screens:
 *   screen-loading  → spinner while we check auth / load data
 *   screen-login    → email + password form
 *   screen-main     → account dropdown + context-aware action buttons
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function renderActionButtons(type, tabId) {
  const notLinkedIn = document.getElementById('not-linkedin-notice')
  const btnExport = document.getElementById('btn-export-session')
  const btnProfile = document.getElementById('btn-import-profile')
  const btnSales = document.getElementById('btn-scrape-sales')

  const isLinkedIn = type !== 'not-linkedin'
  notLinkedIn.style.display = isLinkedIn ? 'none' : ''
  btnExport.style.display = isLinkedIn ? '' : 'none'
  btnProfile.style.display = type === 'li-profile' ? '' : 'none'
  btnSales.style.display = type === 'sales-search' ? '' : 'none'
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

// ── Update Sales Nav capture count badge ──────────────────────────────────────

async function updateCaptureCount(tabId) {
  const badge = document.getElementById('capture-count-badge')
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'GET_CAPTURES' })
    if (reply?.ok && reply.captures?.length > 0) {
      badge.textContent = '(' + reply.captures.length + ' batches)'
    } else {
      badge.textContent = ''
    }
  } catch (_) {
    badge.textContent = ''
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
  renderActionButtons(type, tab?.id)

  // Load accounts
  const select = document.getElementById('account-select')
  await loadAccounts(select)

  // Save account selection on change
  select.addEventListener('change', () => {
    if (select.value) chrome.storage.local.set({ lr_selected_account: select.value })
  })

  // Update capture count for Sales Nav
  if (type === 'sales-search' && tab?.id) {
    await updateCaptureCount(tab.id)
  }

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

  const btnSales = document.getElementById('btn-scrape-sales')
  btnSales.addEventListener('click', async () => {
    clearStatus()
    setButtonLoading(btnSales, true)
    try {
      const { scraped, imported } = await bg({ type: 'SCRAPE_CAPTURES', tabId: tab.id })
      setStatus(`Scraped ${scraped} leads — ${imported} imported (${scraped - imported} already existed).`, 'success')
      await updateCaptureCount(tab.id)
    } catch (err) {
      setStatus(err.message, 'error')
    } finally {
      setButtonLoading(btnSales, false)
    }
  })

  // ── Logout ────────────────────────────────────────────────────────────────
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await bg({ type: 'LOGOUT' })
    showScreen('screen-login')
    document.getElementById('header-user-email').textContent = ''
  })
}

// ── Login form ────────────────────────────────────────────────────────────────

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

// ── Boot ──────────────────────────────────────────────────────────────────────
init()
