/**
 * LinkedReach Chrome Extension — Popup
 *
 * Flow:
 *   1. Check chrome.storage for auth token (set by content-linkedreach.js)
 *   2. Check current tab is linkedin.com
 *   3. Fetch the user's LinkedReach accounts
 *   4. Let user pick which account to sync
 *   5. Read all linkedin.com cookies and POST them to the API
 */

const STATUS_LABELS = {
  active:     'Active',
  warming_up: 'Warming Up',
  paused:     'Paused',
  banned:     'Banned',
}

const STATUS_CLASSES = {
  active:     'status-active',
  warming_up: 'status-warming_up',
  paused:     'status-paused',
  banned:     'status-banned',
}

function showState(id) {
  document.querySelectorAll('.state').forEach(el => el.classList.remove('active'))
  document.getElementById(id).classList.add('active')
}

function showError(msg) {
  const el = document.getElementById('error-msg')
  el.textContent = msg
  el.style.display = 'block'
}

function hideError() {
  document.getElementById('error-msg').style.display = 'none'
}

async function getCurrentTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0]))
  })
}

async function getLinkedInCookies() {
  return new Promise(resolve => {
    chrome.cookies.getAll({ domain: '.linkedin.com' }, cookies => resolve(cookies))
  })
}

async function init() {
  showState('state-loading')

  // 1. Get auth token — always read fresh from storage
  const { lr_auth_token: token } = await chrome.storage.local.get('lr_auth_token')
  if (!token) {
    // Token not found — show helper with link that will trigger the content script
    showState('state-no-auth')
    return
  }

  // Validate token is still a non-expired JWT (basic check)
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      await chrome.storage.local.remove('lr_auth_token')
      showState('state-no-auth')
      return
    }
  } catch { /* non-JWT token, proceed */ }

  // 2. Check current tab
  const tab = await getCurrentTab()
  const isLinkedIn = tab?.url?.includes('linkedin.com')
  if (!isLinkedIn) {
    showState('state-not-linkedin')
    return
  }

  // 3. Fetch accounts
  let accounts
  try {
    const result = await chrome.runtime.sendMessage({ type: 'FETCH_ACCOUNTS', token })
    if (result.error) throw new Error(result.error)
    accounts = result.accounts
  } catch (err) {
    showState('state-no-auth') // token likely expired
    return
  }

  if (!accounts || accounts.length === 0) {
    showState('state-no-accounts')
    return
  }

  // 4. Render account list
  const list = document.getElementById('account-list')
  list.innerHTML = ''

  for (const account of accounts) {
    const item = document.createElement('div')
    item.className = 'account-item'

    const statusClass = STATUS_CLASSES[account.status] ?? ''
    const statusLabel = STATUS_LABELS[account.status] ?? account.status

    item.innerHTML = `
      <div class="account-info">
        <div class="account-email" title="${account.linkedin_email}">${account.linkedin_email}</div>
        <div class="account-status ${statusClass}">${statusLabel}</div>
      </div>
      <button class="btn btn-primary sync-btn" data-id="${account.id}">Sync</button>
    `
    list.appendChild(item)
  }

  showState('state-accounts')

  // 5. Handle sync clicks
  list.addEventListener('click', async e => {
    const btn = e.target.closest('.sync-btn')
    if (!btn) return

    hideError()
    const accountId = btn.dataset.id
    btn.disabled = true
    btn.textContent = 'Syncing…'

    try {
      // Read all LinkedIn cookies
      const rawCookies = await getLinkedInCookies()

      const liAt = rawCookies.find(c => c.name === 'li_at')
      if (!liAt) {
        throw new Error('Not logged into LinkedIn. Please log in first and try again.')
      }

      // Convert to Playwright cookie format
      const cookies = rawCookies.map(c => ({
        name:     c.name,
        value:    c.value,
        domain:   c.domain,
        path:     c.path,
        httpOnly: c.httpOnly,
        secure:   c.secure,
        sameSite: c.sameSite === 'no_restriction' ? 'None'
                : c.sameSite === 'lax'            ? 'Lax'
                : c.sameSite === 'strict'          ? 'Strict'
                : 'None',
        expires: c.expirationDate ?? -1,
      }))

      const result = await chrome.runtime.sendMessage({
        type: 'SYNC_COOKIES',
        token,
        accountId,
        cookies,
      })

      if (result.error) throw new Error(result.error)

      showState('state-success')
    } catch (err) {
      btn.disabled = false
      btn.textContent = 'Sync'
      showError(err.message)
    }
  })
}

init()
