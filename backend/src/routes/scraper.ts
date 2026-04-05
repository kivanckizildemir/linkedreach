/**
 * Scraper Routes
 *
 * POST /api/scraper/profile    — scrape a single LinkedIn profile
 * POST /api/scraper/search     — scrape LinkedIn people search results
 * POST /api/scraper/sales-nav  — scrape Sales Navigator search results
 *
 * All routes require authentication and verify the accountId belongs to the user.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import {
  scrapeLinkedInProfile,
  scrapeLinkedInSearch,
  scrapeSalesNavSearch,
} from '../linkedin/scraper'
import type { SearchFilters, SalesNavFilters } from '../linkedin/scraper'

export const scraperRouter = Router()

scraperRouter.use(requireAuth)

// ── Helper: verify account belongs to user ────────────────────────────────────

async function verifyAccount(accountId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('linkedin_accounts')
    .select('id')
    .eq('id', accountId)
    .eq('user_id', userId)
    .single()
  return !error && !!data
}

// ── POST /api/scraper/profile ─────────────────────────────────────────────────

scraperRouter.post('/profile', async (req: Request, res: Response) => {
  const { accountId, profileUrl } = req.body as {
    accountId?: string
    profileUrl?: string
  }

  if (!accountId || !profileUrl) {
    res.status(400).json({ error: 'accountId and profileUrl are required' })
    return
  }

  if (!profileUrl.includes('linkedin.com/in/') && !profileUrl.includes('linkedin.com/sales/lead/')) {
    res.status(400).json({ error: 'profileUrl must be a LinkedIn profile URL' })
    return
  }

  if (!(await verifyAccount(accountId, req.user.id))) {
    res.status(404).json({ error: 'Account not found' })
    return
  }

  try {
    const profile = await scrapeLinkedInProfile(profileUrl, accountId)
    res.json({ data: profile })
  } catch (err) {
    const msg = (err as Error).message
    console.error('[scraper/profile]', msg)
    res.status(500).json({ error: msg })
  }
})

// ── POST /api/scraper/search ──────────────────────────────────────────────────

scraperRouter.post('/search', async (req: Request, res: Response) => {
  const { accountId, query, filters = {}, page = 1 } = req.body as {
    accountId?: string
    query?: string
    filters?: SearchFilters
    page?: number
  }

  if (!accountId || !query) {
    res.status(400).json({ error: 'accountId and query are required' })
    return
  }

  if (!(await verifyAccount(accountId, req.user.id))) {
    res.status(404).json({ error: 'Account not found' })
    return
  }

  try {
    const results = await scrapeLinkedInSearch(query, filters, accountId, page)
    res.json({ data: results, page, count: results.length })
  } catch (err) {
    const msg = (err as Error).message
    console.error('[scraper/search]', msg)
    res.status(500).json({ error: msg })
  }
})

// ── POST /api/scraper/sales-nav ───────────────────────────────────────────────

scraperRouter.post('/sales-nav', async (req: Request, res: Response) => {
  const { accountId, query = '', filters = {}, page = 1, maxLeads = 25 } = req.body as {
    accountId?: string
    query?: string
    filters?: SalesNavFilters
    page?: number
    maxLeads?: number
  }

  if (!accountId) {
    res.status(400).json({ error: 'accountId is required' })
    return
  }

  if (!(await verifyAccount(accountId, req.user.id))) {
    res.status(404).json({ error: 'Account not found' })
    return
  }

  const limit = Math.min(Math.max(1, maxLeads), 100)

  try {
    const results = await scrapeSalesNavSearch(query, filters, accountId, page, limit)
    res.json({ data: results, page, count: results.length })
  } catch (err) {
    const msg = (err as Error).message
    console.error('[scraper/sales-nav]', msg)
    res.status(500).json({ error: msg })
  }
})
