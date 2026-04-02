/**
 * Background service worker.
 * Handles API calls on behalf of the popup.
 */

const API_BASE = 'https://linkedreach.netlify.app'

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FETCH_ACCOUNTS') {
    handleFetchAccounts(message.token).then(sendResponse).catch(err => sendResponse({ error: err.message }))
    return true // keep channel open for async
  }

  if (message.type === 'SYNC_COOKIES') {
    handleSyncCookies(message.token, message.accountId, message.cookies)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }))
    return true
  }
})

async function handleFetchAccounts(token) {
  const res = await fetch(`${API_BASE}/api/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to fetch accounts (${res.status})`)
  const { data } = await res.json()
  return { accounts: data }
}

async function handleSyncCookies(token, accountId, cookies) {
  const res = await fetch(`${API_BASE}/api/accounts/${accountId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cookies: JSON.stringify(cookies), status: 'active' }),
  })
  if (!res.ok) throw new Error(`Failed to save cookies (${res.status})`)
  return { ok: true }
}
