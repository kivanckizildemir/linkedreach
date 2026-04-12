/**
 * LinkedReach — Web App Content Script
 *
 * Runs on linkedreach.pages.dev (and localhost dev builds).
 * Bridges window.postMessage from the web page to the background service worker
 * via chrome.runtime.sendMessage, and relays the response back.
 *
 * This sidesteps the need to know the extension ID from the web page and avoids
 * the externally_connectable / onMessageExternal path entirely.
 */

// Tell the page the extension is present (picked up by useExtensionBridge hook)
window.postMessage({ type: '__LR_EXT_READY__', version: chrome.runtime.getManifest().version }, '*')

window.addEventListener('message', (event) => {
  // Only handle messages from this page
  if (event.source !== window) return

  const data = event.data
  if (!data || data.__lr_direction !== 'to_ext') return

  const { msgId, payload } = data

  // Handle ping — re-announce presence so waitForExtension() always resolves
  if (payload?.type === '__LR_PING__') {
    window.postMessage({ type: '__LR_EXT_READY__', version: chrome.runtime.getManifest().version }, '*')
    return
  }

  chrome.runtime.sendMessage(payload, (response) => {
    const err = chrome.runtime.lastError
    window.postMessage({
      type:          '__LR_EXT_RESPONSE__',
      msgId,
      response:      err ? null : response,
      error:         err ? err.message : null,
    }, '*')
  })
})
