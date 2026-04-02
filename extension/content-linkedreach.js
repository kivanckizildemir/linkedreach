/**
 * Runs on linkedreach.netlify.app.
 * Reads the Supabase session token from localStorage and stores it
 * in chrome.storage.local so the popup can use it for API calls.
 *
 * Polls on an interval so SPA navigation and token refreshes are picked up.
 */
function captureToken() {
  try {
    const key = Object.keys(localStorage).find(k => k.includes('auth-token') || k.includes('supabase'))
    if (!key) return

    const raw = localStorage.getItem(key)
    if (!raw) return

    const parsed = JSON.parse(raw)
    const token =
      parsed?.access_token ??
      parsed?.currentSession?.access_token ??
      parsed?.session?.access_token

    if (token) {
      chrome.storage.local.set({ lr_auth_token: token })
    }
  } catch {
    // Silent
  }
}

// Run immediately and then every 5 seconds to catch token refreshes and SPA navigation
captureToken()
setInterval(captureToken, 5000)

// Also re-run on any SPA route change
const _pushState = history.pushState.bind(history)
history.pushState = function (...args) {
  _pushState(...args)
  captureToken()
}
window.addEventListener('popstate', captureToken)
