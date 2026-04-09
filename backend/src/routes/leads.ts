import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import { qualifyLeadsQueue, salesNavScraperQueue, profileEnrichQueue } from '../lib/queue'
import { scrapeLinkedInProfiles } from '../lib/brightdata'
import type { IcpFlag, LeadSource } from '../types'

export const leadsRouter = Router()

leadsRouter.use(requireAuth)

// GET /api/leads
leadsRouter.get('/', async (req: Request, res: Response) => {
  const { icp_flag, source, search } = req.query as {
    icp_flag?: IcpFlag
    source?: LeadSource
    search?: string
  }

  let query = supabase
    .from('leads')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })

  if (icp_flag) query = query.eq('icp_flag', icp_flag)
  if (source) query = query.eq('source', source)
  if (search) {
    query = query.or(
      `first_name.ilike.%${search}%,last_name.ilike.%${search}%,company.ilike.%${search}%`
    )
  }

  const { data, error } = await query

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data })
})

// GET /api/leads/:id
leadsRouter.get('/:id', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (error) {
    res.status(404).json({ error: 'Lead not found' })
    return
  }

  res.json({ data })
})

// POST /api/leads
leadsRouter.post('/', async (req: Request, res: Response) => {
  const {
    linkedin_url,
    first_name,
    last_name,
    title,
    company,
    industry,
    location,
    connection_degree,
    source,
    raw_data,
    list_id,
  } = req.body as {
    linkedin_url: string
    first_name: string
    last_name: string
    title?: string
    company?: string
    industry?: string
    location?: string
    connection_degree?: number
    source?: LeadSource
    raw_data?: Record<string, unknown>
    list_id?: string
  }

  if (!linkedin_url || !first_name || !last_name) {
    res.status(400).json({ error: 'linkedin_url, first_name, and last_name are required' })
    return
  }

  const { data, error } = await supabase
    .from('leads')
    .insert({
      user_id: req.user.id,
      linkedin_url,
      first_name,
      last_name,
      title: title ?? null,
      company: company ?? null,
      industry: industry ?? null,
      location: location ?? null,
      connection_degree: connection_degree ?? null,
      source: source ?? 'manual',
      raw_data: raw_data ?? null,
      ...(list_id ? { list_id } : {}),
    })
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(201).json({ data })
})

// POST /api/leads/import — bulk insert from Excel parse
leadsRouter.post('/import', async (req: Request, res: Response) => {
  const { leads } = req.body as {
    leads: Array<{
      linkedin_url: string
      first_name: string
      last_name: string
      title?: string
      company?: string
      industry?: string
      location?: string
      connection_degree?: number
      raw_data?: Record<string, unknown>
    }>
  }

  if (!Array.isArray(leads) || leads.length === 0) {
    res.status(400).json({ error: 'leads array is required and must not be empty' })
    return
  }

  const rows = leads.map((l) => ({
    ...l,
    user_id: req.user.id,
    source: 'excel_import' as LeadSource,
  }))

  // Deduplicate: skip leads whose linkedin_url already exists for this user
  const urls = rows.map(r => r.linkedin_url)
  const { data: existing } = await supabase
    .from('leads')
    .select('linkedin_url')
    .in('linkedin_url', urls)
    .eq('user_id', req.user.id)
  const existingUrls = new Set((existing ?? []).map((e: { linkedin_url: string }) => e.linkedin_url))
  const newRows = rows.filter(r => !existingUrls.has(r.linkedin_url))

  let data: { id: string }[] = []
  if (newRows.length > 0) {
    const { data: ins, error } = await supabase
      .from('leads')
      .insert(newRows)
      .select()
    if (error) {
      res.status(500).json({ error: error.message })
      return
    }
    data = ins ?? []
  }

  // Enqueue AI qualification for each imported lead
  if (data.length > 0) {
    const jobs = data.map((lead: { id: string }) => ({
      name: 'qualify',
      data: { lead_id: lead.id, user_id: req.user.id },
      opts: { attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
    }))
    await qualifyLeadsQueue.addBulk(jobs)
  }

  res.status(201).json({ data, imported: data.length })
})

// POST /api/leads/import-sales-nav — scrape a Sales Navigator search URL
leadsRouter.post('/import-sales-nav', async (req: Request, res: Response) => {
  const { search_url, account_id, max_leads = 100 } = req.body as {
    search_url: string
    account_id: string
    max_leads?: number
  }

  if (!search_url || !account_id) {
    res.status(400).json({ error: 'search_url and account_id are required' })
    return
  }

  // Validate it's a Sales Navigator URL
  try {
    const u = new URL(search_url)
    if (!u.hostname.includes('linkedin.com') || !u.pathname.startsWith('/sales/search/people')) {
      res.status(400).json({ error: 'URL must be a Sales Navigator people search URL' })
      return
    }
  } catch {
    res.status(400).json({ error: 'Invalid URL' })
    return
  }

  // Verify account belongs to user
  const { data: acc, error: accErr } = await supabase
    .from('linkedin_accounts')
    .select('id')
    .eq('id', account_id)
    .eq('user_id', req.user.id)
    .single()

  if (accErr || !acc) {
    res.status(404).json({ error: 'Account not found' })
    return
  }

  const job = await salesNavScraperQueue.add('scrape', {
    search_url,
    account_id,
    user_id:   req.user.id,
    max_leads: Math.min(Math.max(1, max_leads), 1000),
  })

  res.status(202).json({ job_id: job.id, message: 'Scraping started' })
})

// POST /api/leads/import-profiles — import LinkedIn profiles via Bright Data
leadsRouter.post('/import-profiles', async (req: Request, res: Response) => {
  const { urls } = req.body as { urls: string[] }

  if (!Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: 'urls array is required' })
    return
  }

  // Clean and validate URLs
  const clean = urls
    .map(u => u.trim())
    .filter(u => u.includes('linkedin.com/in/'))
    .slice(0, 100) // cap at 100 per request

  if (clean.length === 0) {
    res.status(400).json({ error: 'No valid LinkedIn profile URLs provided (must contain linkedin.com/in/)' })
    return
  }

  try {
    const profiles = await scrapeLinkedInProfiles(clean)

    if (profiles.length === 0) {
      res.json({ imported: 0, message: 'No profiles could be scraped' })
      return
    }

    const rows = profiles.map(p => ({
      ...p,
      user_id: req.user.id,
      source:  'linkedin_import' as const,
    }))

    const importUrls = rows.map(r => r.linkedin_url)
    const { data: existingImport } = await supabase
      .from('leads').select('linkedin_url').in('linkedin_url', importUrls).eq('user_id', req.user.id)
    const existingImportUrls = new Set((existingImport ?? []).map((e: { linkedin_url: string }) => e.linkedin_url))
    const newImportRows = rows.filter(r => !existingImportUrls.has(r.linkedin_url))

    const { data, error } = newImportRows.length > 0
      ? await supabase.from('leads').insert(newImportRows).select('id')
      : { data: [] as { id: string }[], error: null }

    if (error) throw new Error(error.message)

    const saved = data?.length ?? 0

    // Queue AI qualification
    if (data && data.length > 0) {
      await qualifyLeadsQueue.addBulk(
        data.map((l: { id: string }) => ({
          name: 'qualify',
          data: { lead_id: l.id, user_id: req.user.id },
          opts: { attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
        }))
      )
    }

    res.json({ imported: saved, scraped: profiles.length })
  } catch (err) {
    console.error('[import-profiles]', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// GET /api/leads/scrape-status/:jobId — poll scrape job progress
leadsRouter.get('/scrape-status/:jobId', async (req: Request, res: Response) => {
  const job = await salesNavScraperQueue.getJob(String(req.params.jobId))

  if (!job) {
    res.status(404).json({ error: 'Job not found' })
    return
  }

  const state    = await job.getState()
  const progress = job.progress as number ?? 0
  const result   = state === 'completed' ? (job.returnvalue as { scraped: number; saved: number }) : null
  const failMsg  = state === 'failed' ? job.failedReason : null

  res.json({ state, progress, result, error: failMsg })
})

// POST /api/leads/qualify-all — queue leads for AI (re-)qualification
// Body: { force?: boolean, ids?: string[], list_id?: string }
//   force=true  → re-score even already-scored leads
//   ids         → limit to these lead IDs (selected or campaign subset)
//   list_id     → limit to leads in this list (on-demand trigger when list is opened)
leadsRouter.post('/qualify-all', async (req: Request, res: Response) => {
  const { force, ids, list_id } = req.body as { force?: boolean; ids?: string[]; list_id?: string }

  let query = supabase
    .from('leads')
    .select('id')
    .eq('user_id', req.user.id)

  if (ids && ids.length > 0) {
    query = query.in('id', ids)
  }

  if (list_id) {
    query = query.eq('list_id', list_id)
  }

  if (!force) {
    // Default: only unscored leads
    query = query.is('icp_score', null)
  }

  const { data: leads, error } = await query

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  if (!leads || leads.length === 0) {
    res.json({ queued: 0, message: 'No leads to score' })
    return
  }

  const jobs = leads.map((lead: { id: string }) => ({
    name: 'qualify',
    data: { lead_id: lead.id, user_id: req.user.id },
    opts: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      // Stable jobId deduplicates — BullMQ silently drops duplicates already
      // in the queue, preventing repeated triggers from flooding the worker.
      jobId: `qualify-${lead.id}`,
    },
  }))
  await qualifyLeadsQueue.addBulk(jobs)

  res.json({ queued: leads.length })
})

// POST /api/leads/:id/qualify — manually trigger AI re-qualification
leadsRouter.post('/:id/qualify', async (req: Request, res: Response) => {
  const { data: lead, error } = await supabase
    .from('leads')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (error || !lead) {
    res.status(404).json({ error: 'Lead not found' })
    return
  }

  await qualifyLeadsQueue.add(
    'qualify',
    { lead_id: req.params.id, user_id: req.user.id },
    { attempts: 2, backoff: { type: 'exponential', delay: 5000 } }
  )

  res.json({ message: 'Qualification job queued' })
})

// PATCH /api/leads/:id
leadsRouter.patch('/:id', async (req: Request, res: Response) => {
  const allowed = [
    'icp_score',
    'icp_flag',
    'title',
    'company',
    'industry',
    'location',
  ] as const
  type AllowedKey = (typeof allowed)[number]

  const updates: Partial<Record<AllowedKey, unknown>> = {}
  for (const key of allowed) {
    if (key in req.body) {
      updates[key] = req.body[key] as unknown
    }
  }

  const { data, error } = await supabase
    .from('leads')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data })
})

// POST /api/leads/:id/personalise — generate AI opening line for this lead
leadsRouter.post('/:id/personalise', async (req: Request, res: Response) => {
  const { data: lead, error } = await supabase
    .from('leads')
    .select('id, first_name, last_name, title, company, industry, raw_data, about, experience_description, skills, recent_posts')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (error || !lead) {
    res.status(404).json({ error: 'Lead not found' }); return
  }

  try {
    const { personaliseOpeningLine } = await import('../ai/personalise')
    const result = await personaliseOpeningLine({
      first_name: lead.first_name,
      last_name: lead.last_name,
      title: lead.title ?? null,
      company: lead.company ?? null,
      industry: lead.industry ?? null,
      about: (lead as { about?: string | null }).about ?? null,
      experience_description: (lead as { experience_description?: string | null }).experience_description ?? null,
      skills: (lead as { skills?: string[] | null }).skills ?? undefined,
      recent_posts: (lead as { recent_posts?: string[] | null }).recent_posts ?? undefined,
    })

    // Save opening line into raw_data
    const currentRaw = (lead.raw_data as Record<string, unknown> | null) ?? {}
    await supabase
      .from('leads')
      .update({ raw_data: { ...currentRaw, opening_line: result.opening_line } })
      .eq('id', lead.id)

    res.json({ opening_line: result.opening_line })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'AI failed' })
  }
})

// GET /api/leads/:id/campaigns — list campaigns this lead is enrolled in
leadsRouter.get('/:id/campaigns', async (req: Request, res: Response) => {
  // Verify lead belongs to user
  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (leadErr || !lead) {
    res.status(404).json({ error: 'Lead not found' })
    return
  }

  const { data, error } = await supabase
    .from('campaign_leads')
    .select('id, status, reply_classification, created_at, campaign:campaigns(id, name, status)')
    .eq('lead_id', req.params.id)
    .order('created_at', { ascending: false })

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data: data ?? [] })
})

// POST /api/leads/bulk-delete — delete multiple leads by IDs
leadsRouter.post('/bulk-delete', async (req: Request, res: Response) => {
  const { ids } = req.body as { ids: string[] }

  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids array is required' })
    return
  }

  const { error, count } = await supabase
    .from('leads')
    .delete({ count: 'exact' })
    .in('id', ids)
    .eq('user_id', req.user.id)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ deleted: count ?? 0 })
})

// POST /api/leads/enrich-profiles
leadsRouter.post('/enrich-profiles', async (req: Request, res: Response) => {
  try {
    const { list_id, lead_ids, account_id } = req.body as {
      list_id?: string
      lead_ids?: string[]
      account_id: string
    }

    if (!account_id) return res.status(400).json({ error: 'account_id is required' })

    let query = supabase
      .from('leads')
      .select('id, linkedin_url, first_name, last_name')
      .eq('user_id', req.user.id)
      .not('linkedin_url', 'is', null)

    if (lead_ids && lead_ids.length > 0) {
      query = query.in('id', lead_ids)
    } else if (list_id) {
      query = query.eq('list_id', list_id)
    }

    const { data: leads, error } = await query

    if (error) return res.status(500).json({ error: error.message })
    if (!leads || leads.length === 0) return res.status(400).json({ error: 'No leads with LinkedIn URLs found' })

    const job = await profileEnrichQueue.add('enrich', {
      lead_ids: leads.map(l => l.id),
      account_id,
      user_id: req.user.id,
    }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    })

    return res.json({ job_id: job.id, count: leads.length })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// GET /api/leads/enrich-status/:jobId
leadsRouter.get('/enrich-status/:jobId', async (req: Request, res: Response) => {
  try {
    const job = await profileEnrichQueue.getJob(String(req.params.jobId))
    if (!job) return res.status(404).json({ error: 'Job not found' })

    const state = await job.getState()
    const progress = job.progress as number

    return res.json({ state, progress, result: job.returnvalue })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// DELETE /api/leads/enrich-job/:jobId — cancel a running/queued enrich job
leadsRouter.delete('/enrich-job/:jobId', async (req: Request, res: Response) => {
  try {
    const job = await profileEnrichQueue.getJob(String(req.params.jobId))
    if (!job) return res.status(404).json({ error: 'Job not found' })
    await job.remove()
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// POST /api/leads/qualify-cancel — drain pending qualify jobs for this user's leads
leadsRouter.post('/qualify-cancel', async (req: Request, res: Response) => {
  try {
    const { lead_ids } = req.body as { lead_ids?: string[] }
    if (!lead_ids || lead_ids.length === 0) return res.json({ removed: 0 })

    const waiting = await qualifyLeadsQueue.getWaiting()
    const delayed = await qualifyLeadsQueue.getDelayed()
    const toRemove = [...waiting, ...delayed].filter(j =>
      j.data?.lead_id && lead_ids.includes(j.data.lead_id)
    )
    await Promise.all(toRemove.map(j => j.remove().catch(() => null)))
    return res.json({ removed: toRemove.length })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// DELETE /api/leads/:id
leadsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { error } = await supabase
    .from('leads')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(204).send()
})
