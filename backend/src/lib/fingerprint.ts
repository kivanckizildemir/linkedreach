/**
 * Stable per-account browser fingerprint generator.
 *
 * Generates a realistic, internally consistent set of browser signals once per
 * LinkedIn account and stores them in linkedin_accounts.fingerprint (JSONB).
 * Every subsequent Playwright session injects this fingerprint via addInitScript()
 * so LinkedIn always sees the same "device" for the same account.
 *
 * Covers the key signals checked by LinkedIn's Spectroscopy bot-detection script:
 *   - WebGL vendor + renderer (replaces SwiftShader — the #1 headless tell)
 *   - Canvas fingerprint noise (unique per account, stable across sessions)
 *   - Screen resolution + colour depth
 *   - Platform / OS string
 *   - User-Agent (consistent with platform)
 *   - Hardware concurrency + device memory
 *   - Timezone (matched to proxy country)
 *   - Locale / language (matched to proxy country)
 */

import * as crypto from 'crypto'

// ── Realistic GPU profiles ────────────────────────────────────────────────────
// Sourced from real device stats (StatCounter GlobalStats, Steam Hardware Survey)

const GPU_PROFILES = [
  // Intel — most common on laptops
  { vendor: 'Intel Inc.',        renderer: 'Intel Iris Xe Graphics' },
  { vendor: 'Intel Inc.',        renderer: 'Intel UHD Graphics 620' },
  { vendor: 'Intel Inc.',        renderer: 'Intel HD Graphics 620' },
  { vendor: 'Intel Inc.',        renderer: 'Intel Iris Plus Graphics 640' },
  { vendor: 'Intel Inc.',        renderer: 'Mesa Intel(R) UHD Graphics 750 (RKL GT1)' },
  // NVIDIA — discrete GPUs
  { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA GeForce GTX 1650/PCIe/SSE2' },
  { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA GeForce RTX 2060/PCIe/SSE2' },
  { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA GeForce MX450/PCIe/SSE2' },
  { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA Quadro P2000/PCIe/SSE2' },
  // AMD
  { vendor: 'ATI Technologies Inc.', renderer: 'AMD Radeon RX 580 Series' },
  { vendor: 'ATI Technologies Inc.', renderer: 'AMD Radeon(TM) RX Vega 10 Graphics' },
  { vendor: 'Google Inc. (ATI Technologies Inc.)', renderer: 'ANGLE (ATI Technologies Inc., AMD Radeon RX 5500 XT Direct3D11 vs_5_0 ps_5_0, D3D11-27.20.1034.6)' },
  // Apple Silicon (for macOS accounts)
  { vendor: 'Apple',             renderer: 'Apple M1' },
  { vendor: 'Apple',             renderer: 'Apple M2' },
]

// ── Screen resolutions (weighted by real usage stats) ────────────────────────
const SCREEN_PROFILES = [
  // 1920x1080 is the most common — 25%
  { width: 1920, height: 1080 },
  { width: 1920, height: 1080 },
  { width: 1920, height: 1080 },
  { width: 1920, height: 1080 },
  { width: 1920, height: 1080 },
  // 1366x768 laptops — 15%
  { width: 1366, height: 768 },
  { width: 1366, height: 768 },
  { width: 1366, height: 768 },
  // 1440x900 MacBook Air — 8%
  { width: 1440, height: 900 },
  { width: 1440, height: 900 },
  // 1536x864 Surface — 7%
  { width: 1536, height: 864 },
  { width: 1536, height: 864 },
  // 2560x1440 QHD — 5%
  { width: 2560, height: 1440 },
  // 1280x800 older MacBooks — 5%
  { width: 1280, height: 800 },
  // 1600x900 — 4%
  { width: 1600, height: 900 },
]

// ── Timezone + locale by country code ────────────────────────────────────────
const COUNTRY_SETTINGS: Record<string, { timezone: string; locale: string; language: string[] }> = {
  gb: { timezone: 'Europe/London',    locale: 'en-GB', language: ['en-GB', 'en'] },
  us: { timezone: 'America/New_York', locale: 'en-US', language: ['en-US', 'en'] },
  de: { timezone: 'Europe/Berlin',    locale: 'de-DE', language: ['de-DE', 'de', 'en'] },
  tr: { timezone: 'Europe/Istanbul',  locale: 'tr-TR', language: ['tr-TR', 'tr', 'en'] },
  fr: { timezone: 'Europe/Paris',     locale: 'fr-FR', language: ['fr-FR', 'fr', 'en'] },
  nl: { timezone: 'Europe/Amsterdam', locale: 'nl-NL', language: ['nl-NL', 'nl', 'en'] },
  es: { timezone: 'Europe/Madrid',    locale: 'es-ES', language: ['es-ES', 'es', 'en'] },
  it: { timezone: 'Europe/Rome',      locale: 'it-IT', language: ['it-IT', 'it', 'en'] },
  pl: { timezone: 'Europe/Warsaw',    locale: 'pl-PL', language: ['pl-PL', 'pl', 'en'] },
  se: { timezone: 'Europe/Stockholm', locale: 'sv-SE', language: ['sv-SE', 'sv', 'en'] },
  no: { timezone: 'Europe/Oslo',      locale: 'nb-NO', language: ['nb-NO', 'no', 'en'] },
  dk: { timezone: 'Europe/Copenhagen',locale: 'da-DK', language: ['da-DK', 'da', 'en'] },
  au: { timezone: 'Australia/Sydney', locale: 'en-AU', language: ['en-AU', 'en'] },
  ca: { timezone: 'America/Toronto',  locale: 'en-CA', language: ['en-CA', 'en'] },
  in: { timezone: 'Asia/Kolkata',     locale: 'en-IN', language: ['en-IN', 'hi', 'en'] },
  ae: { timezone: 'Asia/Dubai',       locale: 'ar-AE', language: ['ar-AE', 'ar', 'en'] },
  sg: { timezone: 'Asia/Singapore',   locale: 'en-SG', language: ['en-SG', 'en'] },
  jp: { timezone: 'Asia/Tokyo',       locale: 'ja-JP', language: ['ja-JP', 'ja', 'en'] },
  br: { timezone: 'America/Sao_Paulo',locale: 'pt-BR', language: ['pt-BR', 'pt', 'en'] },
}

const DEFAULT_COUNTRY_SETTINGS = COUNTRY_SETTINGS['gb']

// ── User-Agent templates ──────────────────────────────────────────────────────
const CHROME_VERSIONS = ['120', '121', '122', '123', '124']
const WIN_UA_TEMPLATE = (v: string) =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`
const MAC_UA_TEMPLATE = (v: string) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Deterministic pick from an array using a hash of the seed string. */
function seededPick<T>(arr: T[], seed: string, salt = ''): T {
  const hash = crypto.createHash('sha256').update(seed + salt).digest('hex')
  const idx  = parseInt(hash.slice(0, 8), 16) % arr.length
  return arr[idx]
}

/** Deterministic integer in [min, max) using a hash of the seed string. */
function seededInt(min: number, max: number, seed: string, salt = ''): number {
  const hash = crypto.createHash('sha256').update(seed + salt).digest('hex')
  return min + (parseInt(hash.slice(0, 8), 16) % (max - min))
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface AccountFingerprint {
  webgl_vendor:          string
  webgl_renderer:        string
  screen_width:          number
  screen_height:         number
  platform:              string   // 'Win32' | 'MacIntel'
  user_agent:            string
  timezone:              string   // IANA e.g. 'Europe/London'
  locale:                string   // BCP-47 e.g. 'en-GB'
  language:              string[] // e.g. ['en-GB', 'en']
  canvas_seed:           number   // injected as a subtle noise offset
  hardware_concurrency:  number   // 4, 6, 8, 12, 16
  device_memory:         number   // 4, 8, 16 (GB)
  color_depth:           number   // 24 (standard)
}

/**
 * Generate a stable fingerprint for an account.
 * Pass `countryCode` (from proxies.country) so timezone/locale are geo-consistent.
 * All values are derived deterministically from accountId so the same account
 * always gets the same fingerprint, even if the column is lost and regenerated.
 */
export function generateFingerprint(accountId: string, countryCode?: string | null): AccountFingerprint {
  const geo  = (countryCode ? COUNTRY_SETTINGS[countryCode.toLowerCase()] : null) ?? DEFAULT_COUNTRY_SETTINGS
  const gpu  = seededPick(GPU_PROFILES, accountId, 'gpu')
  const screen = seededPick(SCREEN_PROFILES, accountId, 'screen')
  const chromeVer = seededPick(CHROME_VERSIONS, accountId, 'chrome')

  // Platform: Apple GPUs → MacIntel; everything else → Win32
  const isMac    = gpu.vendor === 'Apple'
  const platform = isMac ? 'MacIntel' : 'Win32'
  const userAgent = isMac
    ? MAC_UA_TEMPLATE(chromeVer)
    : WIN_UA_TEMPLATE(chromeVer)

  const canvasSeed = seededInt(1, 255, accountId, 'canvas')
  const concurrencyOptions = [4, 4, 6, 6, 8, 8, 8, 12, 16]
  const memoryOptions      = [4, 8, 8, 16]
  const hardwareConcurrency = seededPick(concurrencyOptions, accountId, 'cpu')
  const deviceMemory        = seededPick(memoryOptions, accountId, 'mem')

  return {
    webgl_vendor:         gpu.vendor,
    webgl_renderer:       gpu.renderer,
    screen_width:         screen.width,
    screen_height:        screen.height,
    platform,
    user_agent:           userAgent,
    timezone:             geo.timezone,
    locale:               geo.locale,
    language:             geo.language,
    canvas_seed:          canvasSeed,
    hardware_concurrency: hardwareConcurrency,
    device_memory:        deviceMemory,
    color_depth:          24,
  }
}

/**
 * Playwright init script factory.
 * Returns a JS function (as a string) that can be passed to page.addInitScript().
 * Patches the 8 most critical fingerprint vectors before any page JS runs.
 */
export function buildFingerprintInitScript(fp: AccountFingerprint): string {
  // Serialise to JSON so we can inline it into the script string safely
  const fpJson = JSON.stringify(fp)

  return `
(function () {
  try {
    const fp = ${fpJson};

    // ── 1. navigator.webdriver ──────────────────────────────────────────────
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true })

    // ── 2. Platform + hardware ──────────────────────────────────────────────
    Object.defineProperty(navigator, 'platform',            { get: () => fp.platform })
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => fp.hardware_concurrency })
    Object.defineProperty(navigator, 'deviceMemory',        { get: () => fp.device_memory })
    Object.defineProperty(navigator, 'languages',           { get: () => fp.language })
    Object.defineProperty(navigator, 'language',            { get: () => fp.language[0] })

    // ── 3. Screen ───────────────────────────────────────────────────────────
    Object.defineProperty(screen, 'width',      { get: () => fp.screen_width })
    Object.defineProperty(screen, 'height',     { get: () => fp.screen_height })
    Object.defineProperty(screen, 'availWidth', { get: () => fp.screen_width })
    Object.defineProperty(screen, 'availHeight',{ get: () => fp.screen_height - 40 })
    Object.defineProperty(screen, 'colorDepth', { get: () => fp.color_depth })
    Object.defineProperty(screen, 'pixelDepth', { get: () => fp.color_depth })

    // ── 4. WebGL vendor / renderer (replaces SwiftShader) ──────────────────
    const origGetParam = WebGLRenderingContext.prototype.getParameter
    WebGLRenderingContext.prototype.getParameter = function (pname) {
      if (pname === 37445) return fp.webgl_vendor    // UNMASKED_VENDOR_WEBGL
      if (pname === 37446) return fp.webgl_renderer  // UNMASKED_RENDERER_WEBGL
      return origGetParam.call(this, pname)
    }
    const origGetParam2 = WebGL2RenderingContext.prototype.getParameter
    WebGL2RenderingContext.prototype.getParameter = function (pname) {
      if (pname === 37445) return fp.webgl_vendor
      if (pname === 37446) return fp.webgl_renderer
      return origGetParam2.call(this, pname)
    }

    // ── 5. Canvas noise (unique per account, stable) ────────────────────────
    // Adds a sub-pixel noise offset to toDataURL output.
    // The actual visible image is unchanged; the hash is unique per account.
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const ctx = this.getContext('2d')
      if (ctx && this.width > 0 && this.height > 0) {
        const seed = fp.canvas_seed
        const imageData = ctx.getImageData(0, 0, 1, 1)
        imageData.data[0] = (imageData.data[0] + seed) % 256
        imageData.data[1] = (imageData.data[1] + Math.floor(seed * 1.3)) % 256
        ctx.putImageData(imageData, 0, 0)
      }
      return origToDataURL.apply(this, args)
    }

    // ── 6. chrome.runtime (prevents "not a real Chrome" detection) ──────────
    if (!window.chrome) window.chrome = {}
    if (!window.chrome.runtime) window.chrome.runtime = {}

    // ── 7. Permissions API (prevent "can I query battery?" bot signal) ──────
    const origQuery = navigator.permissions?.query?.bind(navigator.permissions)
    if (origQuery) {
      navigator.permissions.query = (parameters) => {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission, onchange: null } as PermissionStatus)
        }
        return origQuery(parameters)
      }
    }

    // ── 8. Plugins list (empty in headless — real browsers have 5+) ─────────
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const fakePlugins = [
          { name: 'PDF Viewer',             filename: 'internal-pdf-viewer',  description: 'Portable Document Format', length: 1 },
          { name: 'Chrome PDF Viewer',       filename: 'internal-pdf-viewer',  description: 'Portable Document Format', length: 1 },
          { name: 'Chromium PDF Viewer',     filename: 'internal-pdf-viewer',  description: 'Portable Document Format', length: 1 },
          { name: 'Microsoft Edge PDF Viewer',filename:'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
          { name: 'WebKit built-in PDF',     filename: 'internal-pdf-viewer',  description: 'Portable Document Format', length: 1 },
        ]
        const arr = Object.create(PluginArray.prototype)
        fakePlugins.forEach((p, i) => { arr[i] = p })
        arr.length = fakePlugins.length
        arr.item = (i) => arr[i] || null
        arr.namedItem = (name) => fakePlugins.find(p => p.name === name) || null
        arr.refresh = () => {}
        return arr
      }
    })

  } catch (e) { /* silently ignore — never crash the page */ }
})();
`
}
