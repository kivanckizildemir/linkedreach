/**
 * LinkedReach — Background Service Worker
 */
const DEFAULT_BACKEND = 'https://api-production-5994.up.railway.app'

async function getConfig() {
  const { lr_backend, lr_token } = await chrome.storage.local.get(['lr_backend', 'lr_token'])
  return { backend: (lr_backend || DEFAULT_BACKEND).replace(/\/$/, ''), token: lr_token || null }
}

async function apiFetch(path, opts = {}) {
  const { backend, token } = await getConfig()
  const res = await fetch(backend + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body,
  })
  return res
}

function cookieToPlaywright(c) {
  return {
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    httpOnly: c.httpOnly, secure: c.secure,
    sameSite: c.sameSite === 'no_restriction' ? 'None' : c.sameSite === 'lax' ? 'Lax' : c.sameSite === 'strict' ? 'Strict' : 'None',
    expires: c.expirationDate ?? -1,
  }
}

function mapLead(raw, fallbackUrl) {
  let first = (raw.firstName ?? '').trim()
  let last  = (raw.lastName  ?? '').trim()
  if (!first && !last) {
    const full = (raw.fullName ?? raw.leadName?.text ?? '').trim()
    if (!full) return null
    const p = full.split(' '); first = p[0] ?? ''; last = p.slice(1).join(' ')
  }
  if (!first && !last) return null

  let title = null
  if (typeof raw.title === 'string') title = raw.title || null
  else if (raw.title?.text)          title = raw.title.text || null
  else if (raw.titleText)            title = raw.titleText || null

  const company = raw.currentPositions?.[0]?.companyName ?? raw.companyName ?? raw.company?.name ?? null
  const location = (typeof raw.location === 'object' ? raw.location?.text : null) ?? raw.geoRegion ?? null

  let linkedin_url = raw.publicProfileUrl ?? raw.profileUrl ?? ''
  if (!linkedin_url) {
    const urn = raw.linkedinMemberUrn ?? raw.memberUrn ?? raw.entityUrn ?? raw.objectUrn ?? ''
    const id = urn.split(':').pop()
    if (id) linkedin_url = 'https://www.linkedin.com/in/' + id + '/'
  }
  if (!linkedin_url) linkedin_url = fallbackUrl ?? ''

  return { first_name: first, last_name: last, title, company, location, linkedin_url, connection_degree: raw.degree ?? raw.memberBadges?.degree ?? null }
}

function parseCaptures(captures) {
  const seen = new Set(); const leads = []
  for (const { url, data } of (captures ?? [])) {
    const items = data?.elements ?? data?.results ?? data?.leadResults ?? []
    for (const item of items) {
      const lead = mapLead(item, url)
      if (lead && lead.linkedin_url && !seen.has(lead.linkedin_url)) {
        seen.add(lead.linkedin_url); leads.push(lead)
      }
    }
  }
  return leads
}

function isTokenExpired(token) {
  try {
    const p = JSON.parse(atob(token.split('.')[1]))
    return p.exp && p.exp * 1000 < Date.now()
  } catch (_) { return false }
}

// ── Main message handler ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg, _sender).then(sendResponse).catch(e => sendResponse({ error: e.message }))
  return true
})

async function handle(msg, sender) {
  switch (msg.type) {

    case 'LOGIN': {
      const { backend } = await getConfig()
      const res = await fetch(backend + '/api/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: msg.email, password: msg.password }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Login failed (' + res.status + ')')
      }
      const { access_token, user } = await res.json()
      await chrome.storage.local.set({ lr_token: access_token, lr_user: user })
      return { ok: true, user }
    }

    case 'LOGOUT':
      await chrome.storage.local.remove(['lr_token', 'lr_user'])
      return { ok: true }

    case 'GET_AUTH': {
      const { lr_token, lr_user } = await chrome.storage.local.get(['lr_token', 'lr_user'])
      if (!lr_token || isTokenExpired(lr_token)) {
        await chrome.storage.local.remove(['lr_token', 'lr_user'])
        return { ok: false }
      }
      return { ok: true, user: lr_user }
    }

    case 'GET_ACCOUNTS': {
      const res = await apiFetch('/api/accounts')
      if (!res.ok) throw new Error('Failed to load accounts (' + res.status + ')')
      const { data } = await res.json()
      return { accounts: data }
    }

    case 'EXPORT_SESSION': {
      const { accountId, tabId } = msg
      const chromeCookies = await chrome.cookies.getAll({ domain: '.linkedin.com' })
      const cookies = chromeCookies.map(cookieToPlaywright)
      if (!cookies.find(c => c.name === 'li_at')) throw new Error('Not logged into LinkedIn — li_at cookie not found.')

      let origins = []
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'GET_LOCALSTORAGE' })
        if (r?.ok && r.items?.length) origins = [{ origin: 'https://www.linkedin.com', localStorage: r.items }]
      } catch (_) {}

      const storageState = { cookies, origins }
      const res = await apiFetch('/api/accounts/' + accountId, {
        method: 'PATCH',
        body: JSON.stringify({ cookies: JSON.stringify(storageState), status: 'active' }),
      })
      if (!res.ok) throw new Error('Failed to save session (' + res.status + ')')
      return { ok: true, cookieCount: cookies.length, hasLocalStorage: origins.length > 0 }
    }

    case 'SCRAPE_CAPTURES': {
      const { tabId } = msg
      const reply = await chrome.tabs.sendMessage(tabId, { type: 'GET_CAPTURES' })
      if (!reply?.ok) throw new Error(reply?.error ?? 'Could not read captures from page')
      const leads = parseCaptures(reply.captures)
      if (leads.length === 0) throw new Error('No leads captured yet. Make sure the Sales Nav search results are visible in the tab and scroll down to load more.')
      const res = await apiFetch('/api/leads/import', { method: 'POST', body: JSON.stringify({ leads }) })
      if (!res.ok) throw new Error('Failed to import leads (' + res.status + ')')
      const { imported } = await res.json()
      return { ok: true, scraped: leads.length, imported }
    }

    case 'IMPORT_PROFILE': {
      const { tabId } = msg
      const reply = await chrome.tabs.sendMessage(tabId, { type: 'GET_PROFILE' })
      if (!reply?.ok || !reply.profile) throw new Error('Could not read profile data from this page.')
      const res = await apiFetch('/api/leads/import', { method: 'POST', body: JSON.stringify({ leads: [reply.profile] }) })
      if (!res.ok) throw new Error('Failed to import lead (' + res.status + ')')
      const { imported } = await res.json()
      return { ok: true, imported }
    }

    case 'CAPTURE_UPDATE': return { ok: true }

    default: throw new Error('Unknown: ' + msg.type)
  }
}
