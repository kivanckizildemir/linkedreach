/**
 * LocationSelector — Sales Navigator-style location picker.
 *
 * Supports: Regions (EMEA, APAC...), Countries, Cities, Radius (city + miles).
 * Selected entries render as removable pills.
 * Mode toggle: include / exclude.
 */

import { useState, useRef, useEffect } from 'react'

// ── Static data ───────────────────────────────────────────────────────────────

const REGIONS = [
  'EMEA', 'APAC', 'LATAM', 'NA', 'MEA', 'DACH', 'Nordics', 'Benelux', 'CEE', 'SEA', 'GCC',
]

const COUNTRIES = [
  { label: 'United Kingdom', code: 'GB' },
  { label: 'United States',  code: 'US' },
  { label: 'Germany',        code: 'DE' },
  { label: 'France',         code: 'FR' },
  { label: 'Netherlands',    code: 'NL' },
  { label: 'Spain',          code: 'ES' },
  { label: 'Italy',          code: 'IT' },
  { label: 'Sweden',         code: 'SE' },
  { label: 'Norway',         code: 'NO' },
  { label: 'Denmark',        code: 'DK' },
  { label: 'Finland',        code: 'FI' },
  { label: 'Switzerland',    code: 'CH' },
  { label: 'Austria',        code: 'AT' },
  { label: 'Belgium',        code: 'BE' },
  { label: 'Poland',         code: 'PL' },
  { label: 'Portugal',       code: 'PT' },
  { label: 'Ireland',        code: 'IE' },
  { label: 'Australia',      code: 'AU' },
  { label: 'Canada',         code: 'CA' },
  { label: 'India',          code: 'IN' },
  { label: 'Singapore',      code: 'SG' },
  { label: 'Japan',          code: 'JP' },
  { label: 'South Korea',    code: 'KR' },
  { label: 'China',          code: 'CN' },
  { label: 'Brazil',         code: 'BR' },
  { label: 'Mexico',         code: 'MX' },
  { label: 'South Africa',   code: 'ZA' },
  { label: 'UAE',            code: 'AE' },
  { label: 'Saudi Arabia',   code: 'SA' },
  { label: 'Israel',         code: 'IL' },
  { label: 'Turkey',         code: 'TR' },
  { label: 'Nigeria',        code: 'NG' },
  { label: 'Kenya',          code: 'KE' },
  { label: 'New Zealand',    code: 'NZ' },
  { label: 'Indonesia',      code: 'ID' },
  { label: 'Malaysia',       code: 'MY' },
  { label: 'Thailand',       code: 'TH' },
  { label: 'Philippines',    code: 'PH' },
  { label: 'Vietnam',        code: 'VN' },
  { label: 'Romania',        code: 'RO' },
  { label: 'Czech Republic', code: 'CZ' },
  { label: 'Hungary',        code: 'HU' },
  { label: 'Greece',         code: 'GR' },
  { label: 'Ukraine',        code: 'UA' },
]

const CITIES = [
  { label: 'London',        country_code: 'GB' },
  { label: 'Manchester',    country_code: 'GB' },
  { label: 'Birmingham',    country_code: 'GB' },
  { label: 'Edinburgh',     country_code: 'GB' },
  { label: 'New York',      country_code: 'US' },
  { label: 'San Francisco', country_code: 'US' },
  { label: 'Los Angeles',   country_code: 'US' },
  { label: 'Chicago',       country_code: 'US' },
  { label: 'Boston',        country_code: 'US' },
  { label: 'Austin',        country_code: 'US' },
  { label: 'Berlin',        country_code: 'DE' },
  { label: 'Munich',        country_code: 'DE' },
  { label: 'Hamburg',       country_code: 'DE' },
  { label: 'Frankfurt',     country_code: 'DE' },
  { label: 'Paris',         country_code: 'FR' },
  { label: 'Amsterdam',     country_code: 'NL' },
  { label: 'Rotterdam',     country_code: 'NL' },
  { label: 'Stockholm',     country_code: 'SE' },
  { label: 'Oslo',          country_code: 'NO' },
  { label: 'Copenhagen',    country_code: 'DK' },
  { label: 'Helsinki',      country_code: 'FI' },
  { label: 'Zurich',        country_code: 'CH' },
  { label: 'Geneva',        country_code: 'CH' },
  { label: 'Brussels',      country_code: 'BE' },
  { label: 'Warsaw',        country_code: 'PL' },
  { label: 'Vienna',        country_code: 'AT' },
  { label: 'Madrid',        country_code: 'ES' },
  { label: 'Barcelona',     country_code: 'ES' },
  { label: 'Milan',         country_code: 'IT' },
  { label: 'Rome',          country_code: 'IT' },
  { label: 'Dubai',         country_code: 'AE' },
  { label: 'Abu Dhabi',     country_code: 'AE' },
  { label: 'Riyadh',        country_code: 'SA' },
  { label: 'Tel Aviv',      country_code: 'IL' },
  { label: 'Singapore',     country_code: 'SG' },
  { label: 'Sydney',        country_code: 'AU' },
  { label: 'Melbourne',     country_code: 'AU' },
  { label: 'Toronto',       country_code: 'CA' },
  { label: 'Vancouver',     country_code: 'CA' },
  { label: 'Mumbai',        country_code: 'IN' },
  { label: 'Bangalore',     country_code: 'IN' },
  { label: 'Delhi',         country_code: 'IN' },
  { label: 'Tokyo',         country_code: 'JP' },
  { label: 'Seoul',         country_code: 'KR' },
  { label: 'São Paulo',     country_code: 'BR' },
  { label: 'Mexico City',   country_code: 'MX' },
]

// ── Types ─────────────────────────────────────────────────────────────────────

export type F2FLocation =
  | { type: 'region';  label: string; value: string }
  | { type: 'country'; label: string; code: string }
  | { type: 'city';    label: string; country_code: string }
  | { type: 'radius';  center: string; miles: number }

interface SearchResult {
  key:   string
  label: string
  group: string
  entry: F2FLocation
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  mode:      'include' | 'exclude'
  locations: F2FLocation[]
  onModeChange:      (mode: 'include' | 'exclude') => void
  onLocationsChange: (locations: F2FLocation[]) => void
}

export function LocationSelector({ mode, locations, onModeChange, onLocationsChange }: Props) {
  const [query,       setQuery]       = useState('')
  const [open,        setOpen]        = useState(false)
  const [radiusMode,  setRadiusMode]  = useState(false)
  const [radiusCity,  setRadiusCity]  = useState('')
  const [radiusMiles, setRadiusMiles] = useState(50)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropRef  = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Build search results
  const q = query.toLowerCase().trim()
  const results: SearchResult[] = []

  if (q) {
    REGIONS
      .filter(r => r.toLowerCase().includes(q))
      .forEach(r => results.push({
        key: `region-${r}`, label: r, group: 'Regions',
        entry: { type: 'region', label: r, value: r },
      }))

    COUNTRIES
      .filter(c => c.label.toLowerCase().includes(q) || c.code.toLowerCase().includes(q))
      .slice(0, 8)
      .forEach(c => results.push({
        key: `country-${c.code}`, label: c.label, group: 'Countries',
        entry: { type: 'country', label: c.label, code: c.code },
      }))

    CITIES
      .filter(c => c.label.toLowerCase().includes(q))
      .slice(0, 8)
      .forEach(c => results.push({
        key: `city-${c.label}`, label: `${c.label}`, group: 'Cities',
        entry: { type: 'city', label: c.label, country_code: c.country_code },
      }))
  }

  function locationKey(loc: F2FLocation): string {
    if (loc.type === 'region')  return `region-${loc.value}`
    if (loc.type === 'country') return `country-${loc.code}`
    if (loc.type === 'city')    return `city-${loc.label}`
    return `radius-${loc.center}-${loc.miles}`
  }

  function isSelected(entry: F2FLocation): boolean {
    const k = locationKey(entry)
    return locations.some(l => locationKey(l) === k)
  }

  function toggle(entry: F2FLocation) {
    const k = locationKey(entry)
    if (locations.some(l => locationKey(l) === k)) {
      onLocationsChange(locations.filter(l => locationKey(l) !== k))
    } else {
      onLocationsChange([...locations, entry])
    }
  }

  function addRadius() {
    if (!radiusCity.trim()) return
    const entry: F2FLocation = { type: 'radius', center: radiusCity.trim(), miles: radiusMiles }
    if (!isSelected(entry)) onLocationsChange([...locations, entry])
    setRadiusCity('')
    setRadiusMiles(50)
    setRadiusMode(false)
  }

  function pillLabel(loc: F2FLocation): string {
    if (loc.type === 'radius') return `${loc.center} +${loc.miles}mi`
    return loc.label
  }

  // Group results for rendering
  const groups: Record<string, SearchResult[]> = {}
  for (const r of results) {
    if (!groups[r.group]) groups[r.group] = []
    groups[r.group].push(r)
  }

  return (
    <div className="space-y-3">
      {/* Mode toggle */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onModeChange('include')}
          className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
            mode === 'include'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          Include
        </button>
        <button
          type="button"
          onClick={() => onModeChange('exclude')}
          className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
            mode === 'exclude'
              ? 'bg-red-600 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          Exclude
        </button>
        <span className="text-xs text-gray-400 self-center">
          {mode === 'include'
            ? 'Offer face-to-face only in these locations'
            : 'Offer face-to-face everywhere except these locations'}
        </span>
      </div>

      {/* Selected pills */}
      {locations.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {locations.map(loc => (
            <span
              key={locationKey(loc)}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                mode === 'include'
                  ? 'bg-blue-100 text-blue-800'
                  : 'bg-red-100 text-red-800'
              }`}
            >
              {loc.type === 'radius' && <span className="opacity-60">⊙</span>}
              {pillLabel(loc)}
              <button
                type="button"
                onClick={() => toggle(loc)}
                className="ml-0.5 opacity-60 hover:opacity-100"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search input + dropdown */}
      <div className="relative" ref={dropRef}>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            placeholder="Search regions, countries, cities..."
            value={query}
            onChange={e => { setQuery(e.target.value); setOpen(true); setRadiusMode(false) }}
            onFocus={() => setOpen(true)}
            className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="button"
            onClick={() => { setRadiusMode(r => !r); setOpen(false); setQuery('') }}
            className={`px-3 py-1.5 rounded text-sm border transition-colors ${
              radiusMode
                ? 'bg-purple-100 text-purple-700 border-purple-300'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
            title="Add radius"
          >
            ⊙ Radius
          </button>
        </div>

        {/* Dropdown */}
        {open && results.length > 0 && (
          <div className="absolute z-50 top-full mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
            {Object.entries(groups).map(([group, items]) => (
              <div key={group}>
                <div className="px-3 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wide bg-gray-50">
                  {group}
                </div>
                {items.map(item => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => { toggle(item.entry); setQuery(''); setOpen(false) }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between ${
                      isSelected(item.entry) ? 'text-blue-600 font-medium' : 'text-gray-700'
                    }`}
                  >
                    {item.label}
                    {isSelected(item.entry) && <span className="text-blue-500">✓</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Radius builder */}
      {radiusMode && (
        <div className="flex gap-2 items-center bg-purple-50 border border-purple-200 rounded-lg p-3">
          <input
            type="text"
            placeholder="Center city (e.g. London)"
            value={radiusCity}
            onChange={e => setRadiusCity(e.target.value)}
            className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"
          />
          <input
            type="number"
            min={5}
            max={500}
            step={5}
            value={radiusMiles}
            onChange={e => setRadiusMiles(Number(e.target.value))}
            className="w-20 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"
          />
          <span className="text-sm text-gray-500">miles</span>
          <button
            type="button"
            onClick={addRadius}
            disabled={!radiusCity.trim()}
            className="px-3 py-1 bg-purple-600 text-white rounded text-sm disabled:opacity-40 hover:bg-purple-700"
          >
            Add
          </button>
        </div>
      )}
    </div>
  )
}
