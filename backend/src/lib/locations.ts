/**
 * Location utilities for Agent Mode face-to-face meeting matching.
 *
 * Supports:
 *  - Named regions (EMEA, APAC, LATAM, NA, MEA, DACH, Nordics, ...)
 *  - Countries (by name or ISO-2 code)
 *  - Cities (by name)
 *  - Radius (center city + miles) — uses Nominatim geocoding + Haversine
 */

// ── Region → ISO-2 country code map ──────────────────────────────────────────

export const REGION_COUNTRIES: Record<string, string[]> = {
  EMEA: [
    'GB','DE','FR','NL','BE','LU','IE','ES','PT','IT','CH','AT','SE','NO','DK','FI',
    'PL','CZ','SK','HU','RO','BG','HR','SI','RS','BA','ME','MK','AL','GR','CY','MT',
    'LT','LV','EE','IS','LI','AD','MC','SM','VA','BY','UA','MD','GE','AM','AZ',
    'TR','IL','AE','SA','QA','KW','BH','OM','JO','LB','EG','ZA','MA','NG','KE','GH',
    'SN','CI','TN','DZ','LY','ET','TZ','UG','RW','CM',
  ],
  APAC: [
    'CN','JP','KR','IN','AU','NZ','SG','MY','TH','ID','PH','VN','PK','BD','LK',
    'NP','MM','KH','LA','BN','TW','HK','MO','MN','KZ','UZ','TM','KG','TJ',
    'AF','FJ','PG','SB','VU','WS','TO','FM','PW','MH','NR','KI','TV',
  ],
  LATAM: [
    'BR','MX','AR','CO','CL','PE','VE','EC','BO','PY','UY','GY','SR','GF',
    'CR','PA','GT','HN','SV','NI','BZ','CU','DO','HT','JM','TT','BB','LC',
    'VC','GD','AG','DM','KN','BS','TC','KY','AW','CW',
  ],
  NA: ['US','CA','MX'],
  MEA: [
    'AE','SA','QA','KW','BH','OM','JO','LB','IL','TR','EG','ZA','NG','KE',
    'GH','SN','CI','TN','DZ','MA','LY','ET','TZ','UG','RW','CM','MZ','ZM',
    'ZW','BW','NA','MU','MG','SD','SS','SO','DJ','ER',
  ],
  DACH: ['DE','AT','CH'],
  Nordics: ['SE','NO','DK','FI','IS'],
  Benelux: ['BE','NL','LU'],
  CEE: ['PL','CZ','SK','HU','RO','BG','HR','SI','RS','BA','ME','MK','AL','GR'],
  SEA: ['SG','MY','TH','ID','PH','VN','MM','KH','LA','BN'],
  GCC: ['AE','SA','QA','KW','BH','OM'],
}

// Country name → ISO-2 (covers most outreach targets)
export const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  'united kingdom': 'GB', 'uk': 'GB', 'britain': 'GB', 'great britain': 'GB',
  'united states': 'US', 'usa': 'US', 'america': 'US',
  'germany': 'DE', 'deutschland': 'DE',
  'france': 'FR',
  'netherlands': 'NL', 'holland': 'NL',
  'spain': 'ES',
  'italy': 'IT',
  'sweden': 'SE',
  'norway': 'NO',
  'denmark': 'DK',
  'finland': 'FI',
  'switzerland': 'CH',
  'austria': 'AT',
  'belgium': 'BE',
  'poland': 'PL',
  'portugal': 'PT',
  'ireland': 'IE',
  'australia': 'AU',
  'canada': 'CA',
  'india': 'IN',
  'singapore': 'SG',
  'japan': 'JP',
  'south korea': 'KR', 'korea': 'KR',
  'china': 'CN',
  'brazil': 'BR',
  'mexico': 'MX',
  'south africa': 'ZA',
  'uae': 'AE', 'united arab emirates': 'AE',
  'saudi arabia': 'SA',
  'israel': 'IL',
  'turkey': 'TR',
  'nigeria': 'NG',
  'kenya': 'KE',
  'new zealand': 'NZ',
  'indonesia': 'ID',
  'malaysia': 'MY',
  'thailand': 'TH',
  'philippines': 'PH',
  'vietnam': 'VN',
  'romania': 'RO',
  'czech republic': 'CZ', 'czechia': 'CZ',
  'hungary': 'HU',
  'greece': 'GR',
  'ukraine': 'UA',
  'russia': 'RU',
}

// ── F2FLocation types ─────────────────────────────────────────────────────────

export interface F2FLocationRegion  { type: 'region';  label: string; value: string }
export interface F2FLocationCountry { type: 'country'; label: string; code: string }
export interface F2FLocationCity    { type: 'city';    label: string; country_code: string }
export interface F2FLocationRadius  { type: 'radius';  center: string; miles: number }

export type F2FLocation =
  | F2FLocationRegion
  | F2FLocationCountry
  | F2FLocationCity
  | F2FLocationRadius

// ── Geocoding (Nominatim — no API key required) ───────────────────────────────

interface NominatimResult { lat: string; lon: string }

const geocodeCache = new Map<string, { lat: number; lon: number } | null>()

async function geocode(place: string): Promise<{ lat: number; lon: number } | null> {
  const key = place.toLowerCase().trim()
  if (geocodeCache.has(key)) return geocodeCache.get(key)!
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'LinkedReach/1.0 (contact@linkedreach.io)' },
    })
    if (!res.ok) { geocodeCache.set(key, null); return null }
    const data = await res.json() as NominatimResult[]
    if (!data.length) { geocodeCache.set(key, null); return null }
    const result = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) }
    geocodeCache.set(key, result)
    return result
  } catch {
    geocodeCache.set(key, null)
    return null
  }
}

// Haversine distance in miles
function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── Core matcher ──────────────────────────────────────────────────────────────

async function entryMatches(leadLocation: string, entry: F2FLocation): Promise<boolean> {
  const loc = leadLocation.toLowerCase()

  if (entry.type === 'region') {
    const codes = REGION_COUNTRIES[entry.value] ?? []
    for (const code of codes) {
      const name = Object.entries(COUNTRY_NAME_TO_CODE).find(([, c]) => c === code)?.[0]
      if (name && loc.includes(name)) return true
      if (loc.includes(`, ${code.toLowerCase()}`) || loc.endsWith(` ${code.toLowerCase()}`)) return true
    }
    return false
  }

  if (entry.type === 'country') {
    const name = Object.entries(COUNTRY_NAME_TO_CODE).find(([, c]) => c === entry.code)?.[0]
    return loc.includes(entry.code.toLowerCase()) || (!!name && loc.includes(name))
  }

  if (entry.type === 'city') {
    return loc.includes(entry.label.toLowerCase())
  }

  if (entry.type === 'radius') {
    const [center, lead] = await Promise.all([geocode(entry.center), geocode(leadLocation)])
    if (!center || !lead) return false
    return distanceMiles(center.lat, center.lon, lead.lat, lead.lon) <= entry.miles
  }

  return false
}

/**
 * Returns true if the lead's location qualifies for a face-to-face meeting
 * based on the mode ('include' | 'exclude') and configured location list.
 */
export async function matchF2FLocation(
  leadLocation: string | null | undefined,
  mode: 'include' | 'exclude',
  locations: F2FLocation[]
): Promise<boolean> {
  if (!leadLocation?.trim()) return false
  if (!locations.length) return mode === 'exclude'

  const results = await Promise.all(locations.map(e => entryMatches(leadLocation, e)))
  const anyMatch = results.some(Boolean)
  return mode === 'include' ? anyMatch : !anyMatch
}
