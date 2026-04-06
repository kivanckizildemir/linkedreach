(function () {
  'use strict'
  if (window.__lrInjected) return
  window.__lrInjected = true

  // All captured Sales Nav API responses (preserved across SPA navigations)
  window.__lrCaptures = window.__lrCaptures || []

  const SALES_PATTERNS = ['salesApiLeadSearch', 'salesApiSearch', '/sales/api/']

  function isSales(url) {
    return typeof url === 'string' && SALES_PATTERNS.some(p => url.includes(p))
  }

  function emit(data) { window.postMessage({ __lrFrom: 'page', ...data }, '*') }

  function onCapture(url, data) {
    const items = data?.elements ?? data?.results ?? data?.leadResults ?? []
    if (items.length === 0) return
    window.__lrCaptures.push({ url, data, ts: Date.now() })
    emit({ type: 'CAPTURE_UPDATE', count: window.__lrCaptures.length })
  }

  // Hook fetch
  const _fetch = window.fetch
  window.fetch = async function (...args) {
    const req = args[0]
    const url = req instanceof Request ? req.url : String(req)
    const res = await _fetch.apply(this, args)
    if (isSales(url) && res.ok) res.clone().json().then(d => onCapture(url, d)).catch(() => {})
    return res
  }

  // Hook XHR
  const _open = XMLHttpRequest.prototype.open
  const _send = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (m, url, ...rest) {
    this.__lrUrl = String(url)
    return _open.call(this, m, url, ...rest)
  }
  XMLHttpRequest.prototype.send = function (...args) {
    if (isSales(this.__lrUrl)) {
      this.addEventListener('load', function () {
        if (this.status === 200) {
          try { onCapture(this.__lrUrl, JSON.parse(this.responseText)) } catch (_) {}
        }
      })
    }
    return _send.apply(this, args)
  }

  // Respond to content-script requests
  window.addEventListener('message', (ev) => {
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
  })
})()
