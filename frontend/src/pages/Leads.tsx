import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchLeads, requalifyLead, qualifyAllLeads, importLeads, startSalesNavImport, getScrapeStatus } from '../api/leads'
import type { Lead } from '../api/leads'
import { fetchAccounts } from '../api/accounts'
import * as XLSX from 'xlsx'

const FLAG_COLORS: Record<NonNullable<Lead['icp_flag']>, string> = {
  hot:          'bg-red-100 text-red-700 border-red-200',
  warm:         'bg-orange-100 text-orange-700 border-orange-200',
  cold:         'bg-blue-100 text-blue-700 border-blue-200',
  disqualified: 'bg-gray-100 text-gray-500 border-gray-200',
}

const FLAG_ICONS: Record<NonNullable<Lead['icp_flag']>, string> = {
  hot: '🔥', warm: '☀️', cold: '❄️', disqualified: '✗',
}

function ScoreBar({ score }: { score: number }) {
  const color = score >= 75 ? '#EF4444' : score >= 50 ? '#F97316' : score >= 25 ? '#3B82F6' : '#9CA3AF'
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${score}%`, background: color }} />
      </div>
      <span className="text-xs font-semibold tabular-nums" style={{ color }}>{score}</span>
    </div>
  )
}

function ReasoningTooltip({ reasoning }: { reasoning: string }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative inline-block">
      <button
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        className="ml-1.5 w-4 h-4 rounded-full bg-gray-200 text-gray-500 text-[10px] font-bold flex items-center justify-center hover:bg-gray-300 transition-colors"
      >
        ?
      </button>
      {show && (
        <div className="absolute left-6 top-0 z-50 w-64 bg-gray-900 text-white text-xs rounded-xl p-3 shadow-xl leading-relaxed">
          <p className="font-semibold text-gray-300 mb-1 text-[10px] uppercase tracking-wider">AI Reasoning</p>
          {reasoning}
        </div>
      )}
    </div>
  )
}

export function Leads() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [icpFlag, setIcpFlag] = useState('')
  const [showImportModal, setShowImportModal] = useState(false)
  const [showCsvModal, setShowCsvModal] = useState(false)

  const { data: leads = [], isLoading } = useQuery({
    queryKey: ['leads', { search, icp_flag: icpFlag }],
    queryFn: () => fetchLeads({ search: search || undefined, icp_flag: icpFlag || undefined }),
  })

  const requalifyMutation = useMutation({
    mutationFn: requalifyLead,
    onSuccess: () => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['leads'] }), 4000)
    },
  })

  const qualifyAllMutation = useMutation({
    mutationFn: qualifyAllLeads,
    onSuccess: (result) => {
      if (result.queued > 0) {
        setTimeout(() => queryClient.invalidateQueries({ queryKey: ['leads'] }), 6000)
      }
    },
  })

  const unscoredCount = leads.filter(l => l.icp_score == null).length

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Leads</h1>
          <p className="mt-1 text-sm text-gray-500">Import and manage your lead lists</p>
        </div>
        <div className="flex gap-3">
          {unscoredCount > 0 && (
            <button
              onClick={() => qualifyAllMutation.mutate()}
              disabled={qualifyAllMutation.isPending}
              className="px-4 py-2 border border-blue-300 text-blue-700 text-sm font-medium rounded-lg hover:bg-blue-50 transition-colors disabled:opacity-60"
            >
              {qualifyAllMutation.isPending
                ? 'Queuing…'
                : `AI Score All (${unscoredCount})`}
            </button>
          )}
          {leads.length > 0 && (
            <button
              onClick={() => {
                const headers = ['First Name','Last Name','Title','Company','LinkedIn URL','ICP Flag','ICP Score','Email','Location','Industry']
                const rows = leads.map(l => [
                  l.first_name, l.last_name, l.title ?? '', l.company ?? '',
                  l.linkedin_url, l.icp_flag ?? '', l.icp_score ?? '',
                  (l as Record<string,unknown>).email ?? '', (l as Record<string,unknown>).location ?? '',
                  (l as Record<string,unknown>).industry ?? '',
                ])
                const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n')
                const blob = new Blob([csv], { type: 'text/csv' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url; a.download = `leads-${new Date().toISOString().split('T')[0]}.csv`
                a.click(); URL.revokeObjectURL(url)
              }}
              className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
          )}
          <button
            onClick={() => setShowCsvModal(true)}
            className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
          >
            Import CSV / Excel
          </button>
          <button
            onClick={() => setShowImportModal(true)}
            className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
          >
            Import from Sales Nav
          </button>
          <button className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
            Add Lead
          </button>
        </div>
      </div>

      <div className="mt-6 flex gap-4">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search leads…"
          className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          value={icpFlag}
          onChange={e => setIcpFlag(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All flags</option>
          <option value="hot">🔥 Hot</option>
          <option value="warm">☀️ Warm</option>
          <option value="cold">❄️ Cold</option>
          <option value="disqualified">✗ Disqualified</option>
        </select>
      </div>

      <div className="mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Title</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Company</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ICP Score</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Flag</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Source</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center text-gray-400 text-sm">Loading…</td>
                </tr>
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center text-gray-500">
                    No leads yet. Import from a Sales Navigator Excel export to get started.
                  </td>
                </tr>
              ) : (
                leads.map(lead => {
                  const isQueued = requalifyMutation.isPending && requalifyMutation.variables === lead.id
                  const reasoning = lead.raw_data?.ai_reasoning
                  return (
                    <tr key={lead.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                        {lead.first_name} {lead.last_name}
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{lead.title ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{lead.company ?? '—'}</td>
                      <td className="px-4 py-3">
                        {lead.icp_score != null ? (
                          <div className="flex items-center">
                            <ScoreBar score={lead.icp_score} />
                            {reasoning && <ReasoningTooltip reasoning={reasoning} />}
                          </div>
                        ) : (
                          <span className="text-gray-400 text-xs italic">Not scored</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {lead.icp_flag ? (
                          <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${FLAG_COLORS[lead.icp_flag]}`}>
                            <span>{FLAG_ICONS[lead.icp_flag]}</span>
                            {lead.icp_flag}
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs italic">Unscored</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 capitalize">{lead.source.replace('_', ' ')}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => requalifyMutation.mutate(lead.id)}
                          disabled={isQueued}
                          className="text-xs text-gray-400 hover:text-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 ml-auto"
                          title="Re-qualify with AI"
                        >
                          {isQueued ? (
                            <>
                              <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60" strokeDashoffset="20" />
                              </svg>
                              Queuing…
                            </>
                          ) : (
                            <>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" />
                              </svg>
                              AI Score
                            </>
                          )}
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {leads.length > 0 && (
          <div className="px-4 py-3 border-t border-gray-100 text-xs text-gray-400 flex items-center gap-2">
            <span>{leads.length} lead{leads.length !== 1 ? 's' : ''}</span>
            <span className="text-gray-300">·</span>
            <span>ICP scores powered by Claude AI</span>
          </div>
        )}
      </div>

      {showCsvModal && (
        <CsvImportModal
          onClose={() => setShowCsvModal(false)}
          onImported={() => {
            setShowCsvModal(false)
            queryClient.invalidateQueries({ queryKey: ['leads'] })
          }}
        />
      )}

      {showImportModal && (
        <SalesNavImportModal
          onClose={() => setShowImportModal(false)}
          onImported={() => {
            setShowImportModal(false)
            setTimeout(() => queryClient.invalidateQueries({ queryKey: ['leads'] }), 3000)
          }}
        />
      )}
    </div>
  )
}

// ── Column name normalizer ───────────────────────────────────────────────────
// Handles various column names from Sales Navigator exports, LinkedIn exports,
// and generic CSVs.

function normalise(header: string): string {
  return header.toLowerCase().replace(/[\s_\-().]+/g, '')
}

function pickCol(row: Record<string, string>, ...candidates: string[]): string {
  for (const c of candidates) {
    const key = Object.keys(row).find(k => normalise(k) === normalise(c))
    if (key && row[key]?.trim()) return row[key].trim()
  }
  return ''
}

interface ParsedLead {
  linkedin_url: string
  first_name: string
  last_name: string
  title?: string
  company?: string
  industry?: string
  location?: string
  connection_degree?: number
  raw_data?: Record<string, unknown>
}

function parseSheet(rows: Record<string, string>[]): ParsedLead[] {
  const leads: ParsedLead[] = []
  for (const row of rows) {
    const linkedin_url = pickCol(row,
      'LinkedIn URL', 'Profile URL', 'linkedin url', 'profile url',
      'LinkedinURL', 'ProfileURL', 'url', 'linkedin', 'profilelink'
    )
    if (!linkedin_url) continue

    const first_name = pickCol(row,
      'First Name', 'firstname', 'first', 'firstName'
    )
    const last_name = pickCol(row,
      'Last Name', 'lastname', 'last', 'lastName', 'surname'
    )
    if (!first_name && !last_name) continue

    const degStr = pickCol(row, 'Degree', 'Connection Degree', 'connectiondegree', 'degree')
    const degNum = degStr ? parseInt(degStr.replace(/\D/g, ''), 10) : undefined

    leads.push({
      linkedin_url,
      first_name: first_name || '—',
      last_name: last_name || '',
      title: pickCol(row,
        'Title', 'Job Title', 'Current Title', 'jobtitle', 'currenttitle', 'position'
      ) || undefined,
      company: pickCol(row,
        'Company', 'Current Company', 'currentcompany', 'organization', 'employer'
      ) || undefined,
      industry: pickCol(row, 'Industry', 'industry') || undefined,
      location: pickCol(row, 'Location', 'Geography', 'location', 'geography', 'region') || undefined,
      connection_degree: !isNaN(degNum!) ? degNum : undefined,
      raw_data: { source_row: row },
    })
  }
  return leads
}

function CsvImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ParsedLead[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [parseError, setParseError] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ imported: number } | null>(null)
  const [importError, setImportError] = useState('')

  function handleFile(file: File) {
    setParseError('')
    setParsed(null)
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' })
        if (rows.length === 0) { setParseError('File appears to be empty.'); return }
        const leads = parseSheet(rows)
        if (leads.length === 0) {
          setParseError(
            'Could not find LinkedIn URL + name columns. Make sure your file has columns like "LinkedIn URL", "First Name", "Last Name".'
          )
          return
        }
        setParsed(leads)
      } catch (err) {
        setParseError(`Failed to parse file: ${(err as Error).message}`)
      }
    }
    reader.readAsArrayBuffer(file)
  }

  async function handleImport() {
    if (!parsed) return
    setImporting(true)
    setImportError('')
    try {
      const result = await importLeads(parsed)
      setImportResult(result)
    } catch (e) {
      setImportError((e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Import CSV / Excel</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Upload a Sales Navigator export, LinkedIn CSV, or any spreadsheet with LinkedIn profile URLs.
          </p>
        </div>

        {importResult ? (
          <div className="space-y-4 py-4 text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.5">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <div>
              <p className="text-base font-semibold text-gray-900">Import complete</p>
              <p className="text-sm text-gray-500 mt-1">
                {importResult.imported} lead{importResult.imported !== 1 ? 's' : ''} imported — AI scoring queued
              </p>
            </div>
            <button
              onClick={onImported}
              className="w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors"
            >
              View Leads
            </button>
          </div>
        ) : (
          <>
            {/* Drop zone / file picker */}
            <div
              className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-colors"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault()
                const file = e.dataTransfer.files[0]
                if (file) handleFile(file)
              }}
            >
              <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {fileName ? (
                <p className="text-sm font-medium text-gray-700">{fileName}</p>
              ) : (
                <>
                  <p className="text-sm text-gray-500">Click to upload or drag & drop</p>
                  <p className="text-xs text-gray-400 mt-1">.xlsx, .xls, .csv</p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
              />
            </div>

            {parseError && <p className="text-sm text-red-600">{parseError}</p>}

            {parsed && (
              <div className="bg-gray-50 rounded-xl p-4 space-y-2">
                <p className="text-sm font-medium text-gray-700">
                  Found <span className="text-blue-600 font-bold">{parsed.length}</span> valid lead{parsed.length !== 1 ? 's' : ''}
                </p>
                <div className="max-h-36 overflow-y-auto space-y-1">
                  {parsed.slice(0, 5).map((l, i) => (
                    <div key={i} className="text-xs text-gray-500 flex gap-2">
                      <span className="font-medium text-gray-700 min-w-[120px]">{l.first_name} {l.last_name}</span>
                      <span className="truncate text-gray-400">{l.company ?? ''}{l.title ? ` · ${l.title}` : ''}</span>
                    </div>
                  ))}
                  {parsed.length > 5 && (
                    <p className="text-xs text-gray-400">…and {parsed.length - 5} more</p>
                  )}
                </div>
              </div>
            )}

            {importError && <p className="text-sm text-red-600">{importError}</p>}

            <div className="flex gap-3 pt-1">
              <button
                onClick={onClose}
                className="flex-1 py-2.5 border border-gray-200 text-sm font-medium rounded-xl hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={!parsed || importing}
                className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importing ? 'Importing…' : `Import ${parsed ? parsed.length : ''} Leads`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SalesNavImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}) {
  const [searchUrl, setSearchUrl] = useState('')
  const [accountId, setAccountId] = useState('')
  const [maxLeads, setMaxLeads] = useState(100)
  const [status, setStatus] = useState<'idle' | 'scraping' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<{ scraped: number; saved: number } | null>(null)
  const [error, setError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  })

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  function isValidSalesNavUrl(url: string) {
    try {
      const u = new URL(url)
      return u.hostname.includes('linkedin.com') && u.pathname.startsWith('/sales/search/people')
    } catch {
      return false
    }
  }

  async function handleStart() {
    if (!isValidSalesNavUrl(searchUrl)) {
      setError('Please enter a valid Sales Navigator people search URL.')
      return
    }
    if (!accountId) {
      setError('Please select a LinkedIn account to use for scraping.')
      return
    }
    setError('')
    setStatus('scraping')
    setProgress(0)

    try {
      const { job_id } = await startSalesNavImport(searchUrl, accountId, maxLeads)

      pollRef.current = setInterval(async () => {
        try {
          const s = await getScrapeStatus(job_id)
          setProgress(s.progress ?? 0)

          if (s.state === 'completed') {
            clearInterval(pollRef.current!)
            setResult(s.result ?? { scraped: 0, saved: 0 })
            setStatus('done')
          } else if (s.state === 'failed') {
            clearInterval(pollRef.current!)
            setError(s.error ?? 'Scrape job failed.')
            setStatus('error')
          }
        } catch {
          // transient poll error — keep trying
        }
      }, 3000)
    } catch (e) {
      setError((e as Error).message)
      setStatus('error')
    }
  }

  const activeAccounts = accounts.filter(a => a.status === 'active')

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Import from Sales Navigator</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Run a search in Sales Navigator, copy the URL from your browser, and paste it below.
          </p>
        </div>

        {status === 'done' ? (
          <div className="space-y-4 py-4 text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.5">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <div>
              <p className="text-base font-semibold text-gray-900">Import complete</p>
              <p className="text-sm text-gray-500 mt-1">
                Scraped {result?.scraped ?? 0} profiles · {result?.saved ?? 0} leads saved — AI scoring queued
              </p>
            </div>
            <button onClick={onImported}
              className="w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors">
              View Leads
            </button>
          </div>
        ) : status === 'scraping' ? (
          <div className="space-y-4 py-6">
            <div className="text-center">
              <p className="text-sm font-medium text-gray-700 mb-1">Scraping Sales Navigator…</p>
              <p className="text-xs text-gray-400">This can take a few minutes depending on result count.</p>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-500"
                style={{ width: `${Math.max(5, progress)}%` }}
              />
            </div>
            <p className="text-center text-xs text-gray-400">{progress}% complete</p>
            {error && <p className="text-sm text-red-600 text-center">{error}</p>}
          </div>
        ) : (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">Sales Navigator Search URL</label>
              <input
                autoFocus
                type="url"
                value={searchUrl}
                onChange={e => setSearchUrl(e.target.value)}
                placeholder="https://www.linkedin.com/sales/search/people?query=..."
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-400">
                Go to Sales Navigator → People search → apply filters → copy the URL from your browser.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">LinkedIn Account</label>
              {activeAccounts.length === 0 ? (
                <p className="text-sm text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                  No active accounts. Add a LinkedIn account in the Accounts page first.
                </p>
              ) : (
                <select
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">Select account…</option>
                  {activeAccounts.map(a => (
                    <option key={a.id} value={a.id}>{a.linkedin_email}</option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Max leads to import
                <span className="ml-2 text-blue-600 font-semibold">{maxLeads}</span>
              </label>
              <input
                type="range"
                min={10}
                max={500}
                step={10}
                value={maxLeads}
                onChange={e => setMaxLeads(Number(e.target.value))}
                className="w-full accent-blue-600"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                <span>10</span><span>500</span>
              </div>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex gap-3 pt-1">
              <button onClick={onClose}
                className="flex-1 py-2.5 border border-gray-200 text-sm font-medium rounded-xl hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button
                onClick={handleStart}
                disabled={!searchUrl || !accountId || activeAccounts.length === 0}
                className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-colors">
                Start Scraping
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
