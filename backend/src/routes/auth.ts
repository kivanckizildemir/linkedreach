import { Router } from 'express'
import type { Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'

export const authRouter = Router()

// POST /api/auth/token — sign in with email + password, return JWT
// Used by the Chrome extension (no web app session needed)
authRouter.post('/token', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string }
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' })
    return
  }
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(500).json({ error: 'Server misconfiguration' })
    return
  }
  const client = createClient(supabaseUrl, supabaseAnonKey)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data.session) {
    res.status(401).json({ error: error?.message ?? 'Invalid credentials' })
    return
  }
  res.json({
    access_token: data.session.access_token,
    expires_at: data.session.expires_at,
    user: { id: data.user.id, email: data.user.email },
  })
})
