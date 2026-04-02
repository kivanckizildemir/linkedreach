/**
 * Bright Data Web Scraper API integration.
 *
 * Uses the "LinkedIn people profiles – collect by URL" dataset
 * (dataset ID: gd_l1viktl72bvl7bjuj0, synchronous mode).
 *
 * Rate: $1.50 / 1k records.
 */

const API_KEY   = process.env.BRIGHTDATA_API_KEY ?? ''
const DATASET_ID = 'gd_l1viktl72bvl7bjuj0'
const ENDPOINT  = `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${DATASET_ID}&include_errors=true`

export interface BrightDataProfile {
  first_name: string
  last_name:  string
  title:      string | null
  company:    string | null
  location:   string | null
  linkedin_url: string
}

interface RawProfile {
  name?:              string
  first_name?:        string
  last_name?:         string
  position?:          string
  city?:              string
  location?:          string
  country_code?:      string
  url?:               string
  input_url?:         string
  current_company?:   { name?: string } | null
  error?:             string
  error_code?:        string
}

function mapProfile(raw: RawProfile, inputUrl: string): BrightDataProfile | null {
  if (raw.error || raw.error_code) return null

  const fullName = raw.name ?? `${raw.first_name ?? ''} ${raw.last_name ?? ''}`.trim()
  const parts    = fullName.split(' ')
  const firstName = raw.first_name ?? parts[0] ?? ''
  const lastName  = raw.last_name  ?? parts.slice(1).join(' ') ?? ''

  if (!firstName && !lastName) return null

  const linkedinUrl = raw.url ?? raw.input_url ?? inputUrl
  const company     = raw.current_company?.name ?? null

  // Normalize location
  const location = raw.city ?? raw.location ?? null

  return {
    first_name:  firstName,
    last_name:   lastName,
    title:       raw.position ?? null,
    company,
    location,
    linkedin_url: linkedinUrl,
  }
}

/**
 * Scrape up to `urls.length` LinkedIn profile URLs via Bright Data.
 * Returns structured lead data for each successfully scraped profile.
 */
export async function scrapeLinkedInProfiles(urls: string[]): Promise<BrightDataProfile[]> {
  if (!API_KEY) throw new Error('BRIGHTDATA_API_KEY is not set')
  if (urls.length === 0) return []

  const body = urls.map(url => ({ url }))

  const res = await fetch(ENDPOINT, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Bright Data API error ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json() as RawProfile | RawProfile[]

  // Synchronous endpoint returns one object for single URL, array for multiple
  const profiles = Array.isArray(data) ? data : [data]

  const results: BrightDataProfile[] = []
  for (let i = 0; i < profiles.length; i++) {
    const mapped = mapProfile(profiles[i], urls[i])
    if (mapped) results.push(mapped)
  }

  return results
}
