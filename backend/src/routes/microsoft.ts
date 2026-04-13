/**
 * Microsoft OAuth routes for Teams meeting integration.
 *
 * GET  /api/microsoft/auth        → redirect to Microsoft consent screen
 * GET  /api/microsoft/callback    → exchange code for tokens, store in DB
 * GET  /api/microsoft/status      → { connected, ms_email }
 * DELETE /api/microsoft/disconnect → remove stored tokens
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'

export const microsoftRouter = Router()

const CLIENT_ID     = process.env.MICROSOFT_CLIENT_ID     ?? ''
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET ?? ''
const TENANT_ID     = process.env.MICROSOFT_TENANT_ID     ?? 'common'
const REDIRECT_URI  = process.env.MICROSOFT_REDIRECT_URI  ?? ''
const FRONTEND_URL  = process.env.FRONTEND_URL            ?? 'http://localhost:5173'

const SCOPES = 'OnlineMeetings.ReadWrite offline_access User.Read'

// ── GET /api/microsoft/auth ───────────────────────────────────────────────────
// Redirects the user to Microsoft's OAuth consent screen.
// The user must be authenticated — their Supabase JWT is passed as ?token=
// so the callback can identify them after the redirect.

microsoftRouter.get('/auth', async (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? req.query.token as string
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) {
    res.status(401).json({ error: 'Invalid session' })
    return
  }

  // Encode user ID in state so we can recover it in the callback
  const state = Buffer.from(JSON.stringify({ userId: user.id, token })).toString('base64url')

  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    response_type: 'code',
    redirect_uri:  REDIRECT_URI,
    scope:         SCOPES,
    state,
    response_mode: 'query',
  })

  const authUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?${params.toString()}`
  res.redirect(authUrl)
})

// ── GET /api/microsoft/callback ───────────────────────────────────────────────
// Microsoft redirects here after the user consents.
// Exchange the code for tokens, fetch the user's profile, store in DB.

microsoftRouter.get('/callback', async (req: Request, res: Response) => {
  const { code, state, error: oauthError } = req.query as Record<string, string>

  if (oauthError) {
    console.error('[microsoft] OAuth error:', oauthError)
    res.redirect(`${FRONTEND_URL}/settings?ms_error=${encodeURIComponent(oauthError)}`)
    return
  }

  if (!code || !state) {
    res.redirect(`${FRONTEND_URL}/settings?ms_error=missing_params`)
    return
  }

  let userId: string
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'))
    userId = decoded.userId
  } catch {
    res.redirect(`${FRONTEND_URL}/settings?ms_error=invalid_state`)
    return
  }

  // Exchange code for tokens
  const tokenBody = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type:    'authorization_code',
    code,
    redirect_uri:  REDIRECT_URI,
    scope:         SCOPES,
  })

  let tokens: { access_token: string; refresh_token: string; expires_in: number }
  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    tokenBody.toString(),
      }
    )
    if (!tokenRes.ok) {
      const err = await tokenRes.text()
      throw new Error(`Token exchange failed: ${err.slice(0, 200)}`)
    }
    tokens = await tokenRes.json() as typeof tokens
  } catch (err) {
    console.error('[microsoft] Token exchange error:', err)
    res.redirect(`${FRONTEND_URL}/settings?ms_error=token_exchange_failed`)
    return
  }

  // Fetch Microsoft profile
  let msEmail = ''
  let msUserId = ''
  try {
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    })
    if (meRes.ok) {
      const me = await meRes.json() as { id: string; mail?: string; userPrincipalName?: string }
      msUserId = me.id
      msEmail  = me.mail ?? me.userPrincipalName ?? ''
    }
  } catch { /* non-fatal — store what we have */ }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

  // Upsert connection
  const { error: dbErr } = await supabase
    .from('microsoft_connections')
    .upsert({
      user_id:       userId,
      ms_email:      msEmail,
      ms_user_id:    msUserId,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    expiresAt,
    }, { onConflict: 'user_id' })

  if (dbErr) {
    console.error('[microsoft] DB upsert error:', dbErr.message)
    res.redirect(`${FRONTEND_URL}/settings?ms_error=db_error`)
    return
  }

  console.log(`[microsoft] Connected ${msEmail} for user ${userId}`)
  res.redirect(`${FRONTEND_URL}/settings?ms_connected=1`)
})

// ── GET /api/microsoft/status ─────────────────────────────────────────────────

microsoftRouter.get('/status', async (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return }

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) { res.status(401).json({ error: 'Invalid session' }); return }

  const { data } = await supabase
    .from('microsoft_connections')
    .select('ms_email')
    .eq('user_id', user.id)
    .maybeSingle()

  res.json({
    connected: !!data,
    ms_email:  (data as any)?.ms_email ?? null,
  })
})

// ── DELETE /api/microsoft/disconnect ─────────────────────────────────────────

microsoftRouter.delete('/disconnect', async (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return }

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) { res.status(401).json({ error: 'Invalid session' }); return }

  await supabase
    .from('microsoft_connections')
    .delete()
    .eq('user_id', user.id)

  res.json({ ok: true })
})
