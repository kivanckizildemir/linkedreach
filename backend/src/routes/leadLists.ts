import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import { salesNavScraperQueue, qualifyLeadsQueue } from '../lib/queue'
import * as XLSX from 'xlsx'
import multer from 'multer'
import { isLinkedInPeopleSearch } from '../linkedin/linkedinSearchApi'

function stripSessionId(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.delete('sessionId')
    return u.toString()
  } catch {
    return url
  }
}

function validateLinkedInScrapeUrl(search_url: string, source_type?: string): { valid: boolean; source: string; error?: string } {
  try {
    const u = new URL(search_url)
    if (!u.hostname.includes('linkedin.com')) return { valid: false, source: '', error: 'URL must be a LinkedIn URL' }
    if (u.pathname.startsWith('/sales/')) return { valid: true, source: source_type ?? 'sales_nav' }
    if (u.pathname.startsWith('/search/results/people')) return { valid: true, source: 'linkedin_search' }
    if (u.pathname.startsWith('/posts/') || u.pathname.includes('/activity-') || u.pathname.startsWith('/feed/update/')) return { valid: true, source: 'post_reactors' }
    if (u.pathname.startsWith('/events/')) return { valid: true, source: 'event_attendees' }
    return { valid: false, source: '', error: 'URL must be a Sales Navigator URL, LinkedIn people search, LinkedIn post, or LinkedIn event URL' }
  } catch {
    return { valid: false, source: '', error: 'Invalid URL' }
  }
}

export const leadListsRouter = Router()
leadListsRouter.use(requireAuth)

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// GET /api/lead-lists — all lists with lead count
leadListsRouter.get('/', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('lead_lists')
    .select(`
      id, name, source, search_url, created_at,
      leads(count)
    `)
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })

  if (error) { res.status(500).json({ error: error.message }); return }

  // Flatten the leads count from [{count: N}] to lead_count: N
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapped = (data ?? []).map((row: any) => ({
    ...row,
    lead_count: Array.isArray(row.leads) ? (row.leads[0]?.count ?? 0) : 0,
    leads: undefined,
  }))

  res.json({ data: mapped })
})

// GET /api/lead-lists/:id — single list with summary
leadListsRouter.get('/:id', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('lead_lists')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (error || !data) { res.status(404).json({ error: 'List not found' }); return }
  res.json({ data })
})

// GET /api/lead-lists/:id/leads — leads in a list
leadListsRouter.get('/:id/leads', async (req: Request, res: Response) => {
  const { icp_flag, search } = req.query as { icp_flag?: string; search?: string }

  // Verify list belongs to user
  const { data: list, error: listErr } = await supabase
    .from('lead_lists')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()
  if (listErr || !list) { res.status(404).json({ error: 'List not found' }); return }

  let query = supabase
    .from('leads')
    .select('*')
    .eq('list_id', req.params.id)
    .order('created_at', { ascending: false })

  if (icp_flag) query = query.eq('icp_flag', icp_flag)
  if (search) query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,company.ilike.%${search}%`)

  const { data, error } = await query
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ data: data ?? [] })
})

// POST /api/lead-lists — create an empty list
leadListsRouter.post('/', async (req: Request, res: Response) => {
  const { name, source = 'manual' } = req.body as { name?: string; source?: string }
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return }

  const { data, error } = await supabase
    .from('lead_lists')
    .insert({ name: name.trim(), source, user_id: req.user.id })
    .select()
    .single()

  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(201).json({ data })
})

// PATCH /api/lead-lists/:id — rename
leadListsRouter.patch('/:id', async (req: Request, res: Response) => {
  const { name } = req.body as { name?: string }
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return }

  const { data, error } = await supabase
    .from('lead_lists')
    .update({ name: name.trim() })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single()

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ data })
})

// DELETE /api/lead-lists/:id — delete list (leads stay, list_id becomes null)
leadListsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { error } = await supabase
    .from('lead_lists')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)

  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(204).send()
})

// POST /api/lead-lists/:id/combine — add all leads from source_list into this list
leadListsRouter.post('/:id/combine', async (req: Request, res: Response) => {
  const { source_list_id } = req.body as { source_list_id: string }
  if (!source_list_id) { res.status(400).json({ error: 'source_list_id is required' }); return }

  // Verify both lists belong to user
  const { data: lists, error: listErr } = await supabase
    .from('lead_lists').select('id').in('id', [req.params.id, source_list_id]).eq('user_id', req.user.id)
  if (listErr || !lists || lists.length < 2) { res.status(404).json({ error: 'One or both lists not found' }); return }

  // Get leads in source that are not already in target
  const { data: targetUrls } = await supabase.from('leads').select('linkedin_url').eq('list_id', req.params.id)
  const existing = new Set((targetUrls ?? []).map((r: { linkedin_url: string }) => r.linkedin_url))

  const { data: sourceLeads } = await supabase.from('leads').select('linkedin_url').eq('list_id', source_list_id)
  const toMove = (sourceLeads ?? []).filter((r: { linkedin_url: string }) => !existing.has(r.linkedin_url)).map((r: { linkedin_url: string }) => r.linkedin_url)

  if (toMove.length > 0) {
    // Duplicate those leads into target list by inserting copies
    const { data: fullLeads } = await supabase.from('leads').select('*').in('linkedin_url', toMove).eq('list_id', source_list_id)
    if (fullLeads && fullLeads.length > 0) {
      const copies = fullLeads.map((l: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id, created_at, updated_at, ...rest } = l
        return { ...rest, list_id: req.params.id }
      })
      await supabase.from('leads').insert(copies)
    }
  }

  res.json({ added: toMove.length })
})

// POST /api/lead-lists/:id/intersect — keep only leads also in source_list
leadListsRouter.post('/:id/intersect', async (req: Request, res: Response) => {
  const { source_list_id } = req.body as { source_list_id: string }
  if (!source_list_id) { res.status(400).json({ error: 'source_list_id is required' }); return }

  const { data: lists, error: listErr } = await supabase
    .from('lead_lists').select('id').in('id', [req.params.id, source_list_id]).eq('user_id', req.user.id)
  if (listErr || !lists || lists.length < 2) { res.status(404).json({ error: 'One or both lists not found' }); return }

  const { data: sourceUrls } = await supabase.from('leads').select('linkedin_url').eq('list_id', source_list_id)
  const keepUrls = new Set((sourceUrls ?? []).map((r: { linkedin_url: string }) => r.linkedin_url))

  const { data: targetLeads } = await supabase.from('leads').select('id, linkedin_url').eq('list_id', req.params.id)
  const toRemove = (targetLeads ?? []).filter((r: { linkedin_url: string }) => !keepUrls.has(r.linkedin_url)).map((r: { id: string }) => r.id)

  if (toRemove.length > 0) {
    await supabase.from('leads').update({ list_id: null }).in('id', toRemove)
  }

  res.json({ removed: toRemove.length })
})

// POST /api/lead-lists/:id/exclude — remove from this list any leads also in source_list
leadListsRouter.post('/:id/exclude', async (req: Request, res: Response) => {
  const { source_list_id } = req.body as { source_list_id: string }
  if (!source_list_id) { res.status(400).json({ error: 'source_list_id is required' }); return }

  const { data: lists, error: listErr } = await supabase
    .from('lead_lists').select('id').in('id', [req.params.id, source_list_id]).eq('user_id', req.user.id)
  if (listErr || !lists || lists.length < 2) { res.status(404).json({ error: 'One or both lists not found' }); return }

  const { data: sourceUrls } = await supabase.from('leads').select('linkedin_url').eq('list_id', source_list_id)
  const excludeUrls = new Set((sourceUrls ?? []).map((r: { linkedin_url: string }) => r.linkedin_url))

  const { data: targetLeads } = await supabase.from('leads').select('id, linkedin_url').eq('list_id', req.params.id)
  const toRemove = (targetLeads ?? []).filter((r: { linkedin_url: string }) => excludeUrls.has(r.linkedin_url)).map((r: { id: string }) => r.id)

  if (toRemove.length > 0) {
    await supabase.from('leads').update({ list_id: null }).in('id', toRemove)
  }

  res.json({ removed: toRemove.length })
})

// POST /api/lead-lists/:id/duplicate — copy this list and all its leads into a new list
leadListsRouter.post('/:id/duplicate', async (req: Request, res: Response) => {
  const { data: original, error: origErr } = await supabase
    .from('lead_lists').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single()
  if (origErr || !original) { res.status(404).json({ error: 'List not found' }); return }

  // Create new list with same name + " (copy)"
  const { data: newList, error: createErr } = await supabase
    .from('lead_lists').insert({ name: `${original.name} (copy)`, user_id: req.user.id }).select().single()
  if (createErr || !newList) { res.status(500).json({ error: 'Failed to create duplicate list' }); return }

  // Copy all leads
  const { data: leads } = await supabase.from('leads').select('*').eq('list_id', req.params.id)
  if (leads && leads.length > 0) {
    const copies = leads.map((l: Record<string, unknown>) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, created_at, updated_at, ...rest } = l
      return { ...rest, list_id: newList.id }
    })
    const { error: insertErr } = await supabase.from('leads').insert(copies)
    if (insertErr) console.error('[duplicate] insert error:', insertErr.message)
  }

  res.json({ data: newList })
})

// POST /api/lead-lists/:id/scrape — queue scrape job into existing list
leadListsRouter.post('/:id/scrape', async (req: Request, res: Response) => {
  const { search_url: raw_url, account_id, max_leads = 100, source_type } = req.body as {
    search_url: string
    account_id: string
    max_leads?: number
    source_type?: string
  }
  const search_url = stripSessionId(raw_url)

  if (!search_url || !account_id) {
    res.status(400).json({ error: 'search_url and account_id are required' }); return
  }

  const urlCheck = validateLinkedInScrapeUrl(search_url, source_type)
  if (!urlCheck.valid) { res.status(400).json({ error: urlCheck.error }); return }

  const { data: list, error: listErr } = await supabase
    .from('lead_lists')
    .select('id, name')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()
  if (listErr || !list) { res.status(404).json({ error: 'List not found' }); return }

  const { data: acc, error: accErr } = await supabase
    .from('linkedin_accounts')
    .select('id')
    .eq('id', account_id)
    .eq('user_id', req.user.id)
    .single()
  if (accErr || !acc) { res.status(404).json({ error: 'Account not found' }); return }

  const job = await salesNavScraperQueue.add('scrape', {
    search_url,
    account_id,
    user_id: req.user.id,
    max_leads: Math.min(Math.max(1, max_leads), 2500),
    list_id: req.params.id,
    source_type: source_type ?? urlCheck.source,
  })

  res.status(202).json({ job_id: job.id, list_id: req.params.id })
})

// POST /api/lead-lists/:id/import-excel — parse Excel and add to existing list
leadListsRouter.post('/:id/import-excel', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'file is required' }); return }

  const { data: list, error: listErr } = await supabase
    .from('lead_lists')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()
  if (listErr || !list) { res.status(404).json({ error: 'List not found' }); return }

  let rows: Record<string, unknown>[]
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    rows = XLSX.utils.sheet_to_json(ws) as Record<string, unknown>[]
  } catch {
    res.status(400).json({ error: 'Could not parse Excel file' }); return
  }

  const leads = rows
    .map(r => {
      const get = (...keys: string[]) => {
        for (const k of keys) {
          const val = r[k] ?? r[k.toLowerCase()] ?? r[k.toUpperCase()]
          if (val) return String(val).trim()
        }
        return null
      }
      const firstName = get('First Name', 'first_name', 'firstname', 'FirstName')
      const lastName = get('Last Name', 'last_name', 'lastname', 'LastName')
      const linkedinUrl = get('LinkedIn URL', 'linkedin_url', 'profile_url', 'ProfileUrl', 'URL')
      if (!firstName || !lastName || !linkedinUrl) return null
      return {
        first_name: firstName,
        last_name: lastName,
        linkedin_url: linkedinUrl,
        title: get('Title', 'Job Title', 'title', 'job_title'),
        company: get('Company', 'company_name', 'Company Name'),
        location: get('Location', 'location'),
      }
    })
    .filter(Boolean)

  if (leads.length === 0) {
    res.status(400).json({ error: 'No valid leads found. Columns needed: First Name, Last Name, LinkedIn URL' }); return
  }

  const urls = leads.map(l => l!.linkedin_url)
  const { data: existing } = await supabase.from('leads').select('linkedin_url').in('linkedin_url', urls).eq('user_id', req.user.id)
  const existingUrls = new Set((existing ?? []).map((e: { linkedin_url: string }) => e.linkedin_url))
  const newLeads = leads.filter(l => !existingUrls.has(l!.linkedin_url))

  let saved = 0
  if (newLeads.length > 0) {
    const insertRows = newLeads.map(l => ({ ...l, user_id: req.user.id, source: 'excel' as const, list_id: req.params.id }))
    const { data: ins, error: insErr } = await supabase.from('leads').insert(insertRows).select('id')
    if (insErr) { res.status(500).json({ error: insErr.message }); return }
    saved = ins?.length ?? 0

    if (ins && ins.length > 0) {
      await qualifyLeadsQueue.addBulk(
        ins.map((lead: { id: string }) => ({
          name: 'qualify',
          data: { lead_id: lead.id, user_id: req.user.id },
          opts: { attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
        }))
      )
    }
  }

  res.status(201).json({ saved, skipped: leads.length - saved })
})

// POST /api/lead-lists/import-sales-nav — create list + queue scrape job
leadListsRouter.post('/import-sales-nav', async (req: Request, res: Response) => {
  const { list_name, search_url: raw_url2, account_id, max_leads = 250, source_type } = req.body as {
    list_name: string
    search_url: string
    account_id: string
    max_leads?: number
    source_type?: string
  }
  const search_url = stripSessionId(raw_url2)

  if (!list_name?.trim() || !search_url || !account_id) {
    res.status(400).json({ error: 'list_name, search_url, and account_id are required' })
    return
  }

  const urlCheck = validateLinkedInScrapeUrl(search_url, source_type)
  if (!urlCheck.valid) { res.status(400).json({ error: urlCheck.error }); return }

  // Verify account belongs to user
  const { data: acc, error: accErr } = await supabase
    .from('linkedin_accounts')
    .select('id')
    .eq('id', account_id)
    .eq('user_id', req.user.id)
    .single()
  if (accErr || !acc) { res.status(404).json({ error: 'Account not found' }); return }

  // Resolve DB source value — map post/event to valid enum values
  const dbSource = (['sales_nav', 'excel', 'manual', 'chrome_extension', 'linkedin_search'] as const).includes(urlCheck.source as 'sales_nav')
    ? urlCheck.source as 'sales_nav' | 'linkedin_search'
    : 'manual'

  // Create the list
  const { data: list, error: listErr } = await supabase
    .from('lead_lists')
    .insert({ name: list_name.trim(), source: dbSource, search_url, user_id: req.user.id })
    .select()
    .single()
  if (listErr || !list) { res.status(500).json({ error: listErr?.message ?? 'Failed to create list' }); return }

  // Queue the scrape job — pass source_type so worker knows how to scrape
  const job = await salesNavScraperQueue.add('scrape', {
    search_url,
    account_id,
    user_id: req.user.id,
    max_leads: Math.min(Math.max(1, max_leads), 2500),
    list_id: list.id,
    source_type: urlCheck.source,
  })

  res.status(202).json({ job_id: job.id, list_id: list.id, list_name: list.name })
})

// POST /api/lead-lists/import-excel — parse Excel and create list
leadListsRouter.post('/import-excel', upload.single('file'), async (req: Request, res: Response) => {
  const { list_name } = req.body as { list_name?: string }
  if (!list_name?.trim()) { res.status(400).json({ error: 'list_name is required' }); return }
  if (!req.file) { res.status(400).json({ error: 'file is required' }); return }

  let rows: Record<string, unknown>[]
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    rows = XLSX.utils.sheet_to_json(ws) as Record<string, unknown>[]
  } catch {
    res.status(400).json({ error: 'Could not parse Excel file' }); return
  }

  const leads = rows
    .map(r => {
      const get = (...keys: string[]) => {
        for (const k of keys) {
          const val = r[k] ?? r[k.toLowerCase()] ?? r[k.toUpperCase()]
          if (val) return String(val).trim()
        }
        return null
      }
      const firstName = get('First Name', 'first_name', 'firstname', 'FirstName')
      const lastName = get('Last Name', 'last_name', 'lastname', 'LastName')
      const linkedinUrl = get('LinkedIn URL', 'linkedin_url', 'profile_url', 'ProfileUrl', 'URL')
      if (!firstName || !lastName || !linkedinUrl) return null
      return {
        first_name: firstName,
        last_name: lastName,
        linkedin_url: linkedinUrl,
        title: get('Title', 'Job Title', 'title', 'job_title'),
        company: get('Company', 'company_name', 'Company Name'),
        location: get('Location', 'location'),
      }
    })
    .filter(Boolean)

  if (leads.length === 0) {
    res.status(400).json({ error: 'No valid leads found. Columns needed: First Name, Last Name, LinkedIn URL' })
    return
  }

  // Create list
  const { data: list, error: listErr } = await supabase
    .from('lead_lists')
    .insert({ name: list_name.trim(), source: 'excel', user_id: req.user.id })
    .select()
    .single()
  if (listErr || !list) { res.status(500).json({ error: listErr?.message ?? 'Failed to create list' }); return }

  // Deduplicate
  const urls = leads.map(l => l!.linkedin_url)
  const { data: existing } = await supabase.from('leads').select('linkedin_url').in('linkedin_url', urls).eq('user_id', req.user.id)
  const existingUrls = new Set((existing ?? []).map((e: { linkedin_url: string }) => e.linkedin_url))
  const newLeads = leads.filter(l => !existingUrls.has(l!.linkedin_url))

  let saved = 0
  if (newLeads.length > 0) {
    const rows = newLeads.map(l => ({ ...l, user_id: req.user.id, source: 'excel' as const, list_id: list.id }))
    const { data: ins, error: insErr } = await supabase.from('leads').insert(rows).select('id')
    if (insErr) { res.status(500).json({ error: insErr.message }); return }
    saved = ins?.length ?? 0

    if (ins && ins.length > 0) {
      await qualifyLeadsQueue.addBulk(
        ins.map((lead: { id: string }) => ({
          name: 'qualify',
          data: { lead_id: lead.id, user_id: req.user.id },
          opts: { attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
        }))
      )
    }
  }

  res.status(201).json({ list_id: list.id, list_name: list.name, saved, skipped: leads.length - saved })
})
