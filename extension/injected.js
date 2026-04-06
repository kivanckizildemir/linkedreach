(function () {
  'use strict'
  if (window.__lrInjected) return
  window.__lrInjected = true

  window.__lrCaptures = window.__lrCaptures || []

  const SALES_PATTERNS = ['salesApiLeadSearch', 'salesApiSearch', '/sales/api/']

  function isSales(url) {
    try { return typeof url === 'string' && SALES_PATTERNS.some(p => url.includes(p)) }
    catch (_) { return false }
  }

  function emit(data) {
    try { window.postMessage({ __lrFrom: 'page', ...data }, '*') } catch (_) {}
  }

  function onCapture(url, data) {
    try {
      const items = data?.elements ?? data?.results ?? data?.leadResults ?? []
      if (!items.length) return
      window.__lrCaptures.push({ url, data, ts: Date.now() })
      emit({ type: 'CAPTURE_UPDATE', count: window.__lrCaptures.length })
    } catch (_) {}
  }

  // ── Fetch hook ────────────────────────────────────────────────────────────
  // IMPORTANT: return the ORIGINAL promise unmodified.
  // Using `async function` or chaining `.then()` on the returned value would
  // wrap the promise in a new one, breaking AbortController signals and any
  // LinkedIn code that expects reference equality. We intercept via a
  // fire-and-forget side-chain that never affects the caller's promise.
  const _fetch = window.fetch
  if (typeof _fetch === 'function') {
    window.fetch = function (...args) {
      // Always call original first and capture its promise
      const originalPromise = Function.prototype.apply.call(_fetch, this, args)

      try {
        let url = ''
        try {
          const req = args[0]
          url = req instanceof Request ? req.url : String(req ?? '')
        } catch (_) {}

        if (isSales(url)) {
          // Fire-and-forget: don't chain onto originalPromise
          originalPromise.then(function (res) {
            try {
              if (res && res.ok) {
                res.clone().json()
                  .then(function (d) { onCapture(url, d) })
                  .catch(function () {})
              }
            } catch (_) {}
          }).catch(function () {})
        }
      } catch (_) {}

      // Always return the untouched original promise
      return originalPromise
    }
  }

  // ── XHR hook ──────────────────────────────────────────────────────────────
  try {
    const _open = XMLHttpRequest.prototype.open
    const _send = XMLHttpRequest.prototype.send

    XMLHttpRequest.prototype.open = function (m, url) {
      try { this.__lrUrl = String(url ?? '') } catch (_) {}
      // Use apply to forward all arguments exactly as-is
      return Function.prototype.apply.call(_open, this, arguments)
    }

    XMLHttpRequest.prototype.send = function () {
      try {
        if (isSales(this.__lrUrl)) {
          const captureUrl = this.__lrUrl
          this.addEventListener('load', function () {
            try {
              if (this.status === 200) {
                onCapture(captureUrl, JSON.parse(this.responseText))
              }
            } catch (_) {}
          })
        }
      } catch (_) {}
      return Function.prototype.apply.call(_send, this, arguments)
    }
  } catch (_) {}

  // ── Message handler ───────────────────────────────────────────────────────
  window.addEventListener('message', function (ev) {
    try {
      if (!ev.data || ev.data.__lrFrom !== 'ext') return
      const { type, reqId } = ev.data

      if (type === 'GET_LOCALSTORAGE') {
        const items = []
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i)
            if (k) items.push({ name: k, value: localStorage.getItem(k) ?? '' })
          }
        } catch (_) {}
        emit({ type: 'LS_REPLY', items, origin: location.origin, reqId })
      }

      if (type === 'GET_CAPTURES') {
        emit({ type: 'CAPTURES_REPLY', captures: window.__lrCaptures, reqId })
      }
    } catch (_) {}
  })
})()
