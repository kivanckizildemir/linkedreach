'use strict'
// ── Inject page-world script ─────────────────────────────────────────────────
;(function () {
  const s = document.createElement('script')
  s.src = chrome.runtime.getURL('injected.js')
  s.onload = () => s.remove()
  ;(document.head || document.documentElement).prepend(s)
})()

// ── Pending async request map ─────────────────────────────────────────────────
const _pending = new Map()
let _seq = 0

function askPage(type, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const reqId = ++_seq
    _pending.set(reqId, resolve)
    window.postMessage({ __lrFrom: 'ext', type, reqId }, '*')
    setTimeout(() => {
      if (_pending.has(reqId)) { _pending.delete(reqId); reject(new Error('Timeout: ' + type)) }
    }, timeoutMs)
  })
}

// ── Page → ext message relay ──────────────────────────────────────────────────
window.addEventListener('message', (ev) => {
  if (!ev.data || ev.data.__lrFrom !== 'page') return
  const { type, reqId } = ev.data

  // Resolve pending promise
  if (reqId && _pending.has(reqId)) {
    _pending.get(reqId)(ev.data)
    _pending.delete(reqId)
    return
  }

  // Forward capture updates so popup badge can update
  if (type === 'CAPTURE_UPDATE') {
    chrome.runtime.sendMessage({ type: 'CAPTURE_UPDATE', count: ev.data.count }).catch(() => {})
  }
})

// ── Page type detection ───────────────────────────────────────────────────────
function pageType() {
  const p = location.pathname
  if (p.startsWith('/sales/search/people') || p.startsWith('/sales/search/')) return 'sales-search'
  if (p.startsWith('/sales/')) return 'sales-other'
  if (p.startsWith('/search/results/people')) return 'li-search'
  if (/^\/in\/[^/]/.test(p)) return 'li-profile'
  return 'other'
}

// ── DOM profile scraper ───────────────────────────────────────────────────────
function scrapeProfile() {
  try {
    const nameEl = document.querySelector('h1.text-heading-xlarge') ?? document.querySelector('h1')
    const name = (nameEl?.textContent ?? '').trim()
    if (!name) return null
    const parts = name.split(/\s+/)
    const firstName = parts[0] ?? ''
    const lastName  = parts.slice(1).join(' ') || ''

    const titleEl = document.querySelector('.text-body-medium.break-words')
      ?? document.querySelector('.pv-text-details__left-panel .text-body-medium')
    const title = titleEl?.textContent?.trim() || null

    const companyEl = document.querySelector('.pv-text-details__right-panel .hoverable-link-text')
    const company = companyEl?.textContent?.trim() || null

    const locEl = document.querySelector('.pv-text-details__left-panel .text-body-small.inline.t-black--light')
    const loc = locEl?.textContent?.trim() || null

    const profileUrl = 'https://www.linkedin.com' + location.pathname.replace(/\/$/, '')
    return { first_name: firstName, last_name: lastName, title, company, location: loc, linkedin_url: profileUrl }
  } catch (_) { return null }
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  switch (msg.type) {
    case 'GET_PAGE_INFO':
      reply({ pageType: pageType(), url: location.href, title: document.title })
      return false

    case 'GET_LOCALSTORAGE':
      askPage('GET_LOCALSTORAGE')
        .then(r => reply({ ok: true, items: r.items, origin: r.origin }))
        .catch(e => reply({ ok: false, error: e.message }))
      return true

    case 'GET_CAPTURES':
      askPage('GET_CAPTURES')
        .then(r => reply({ ok: true, captures: r.captures }))
        .catch(e => reply({ ok: false, error: e.message }))
      return true

    case 'GET_PROFILE':
      reply({ ok: true, profile: scrapeProfile() })
      return false

    default: return false
  }
})
