/**
 * Extension bridge — communicates with the LinkedReach Chrome extension
 * via window.postMessage ↔ content_webapp.js content script.
 *
 * This avoids needing to know the extension ID (required for
 * chrome.runtime.sendMessage from an external page) and works regardless
 * of how the extension was installed.
 */

let _msgCounter = 0

export interface ExtBridgeResult {
  ok?: boolean
  error?: string
  cookieCount?: number
  hasLocalStorage?: boolean
  user?: { id: string; email?: string }
  [key: string]: unknown
}

/**
 * Send a message to the extension background via the content script bridge.
 * Resolves with the response, or rejects after `timeoutMs` ms.
 */
export function sendToExtension(
  payload: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<ExtBridgeResult> {
  return new Promise((resolve, reject) => {
    const msgId = `lr_${Date.now()}_${++_msgCounter}`

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler)
      reject(new Error('no_response'))
    }, timeoutMs)

    function handler(event: MessageEvent) {
      if (event.source !== window) return
      if (event.data?.type !== '__LR_EXT_RESPONSE__') return
      if (event.data?.msgId !== msgId) return

      clearTimeout(timer)
      window.removeEventListener('message', handler)

      if (event.data.error) {
        reject(new Error(event.data.error as string))
      } else {
        resolve((event.data.response as ExtBridgeResult) ?? {})
      }
    }

    window.addEventListener('message', handler)

    window.postMessage({ __lr_direction: 'to_ext', msgId, payload }, '*')
  })
}

/**
 * Returns true if the content script has signalled it's present.
 * Waits up to `timeoutMs` ms for the __LR_EXT_READY__ message.
 */
export function waitForExtension(timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    // Already ready (content script fires at document_idle — may have already run)
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler)
      resolve(false)
    }, timeoutMs)

    function handler(event: MessageEvent) {
      if (event.source !== window) return
      if (event.data?.type !== '__LR_EXT_READY__') return
      clearTimeout(timer)
      window.removeEventListener('message', handler)
      resolve(true)
    }

    window.addEventListener('message', handler)

    // Ping: ask the content script to re-announce itself in case it already fired
    window.postMessage({ __lr_direction: 'to_ext', msgId: 'ping_ready', payload: { type: '__LR_PING__' } }, '*')
  })
}
