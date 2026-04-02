import type { Request, Response, NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'

// Use a request-scoped client so we validate against the user's JWT,
// not the service role. The service client is used for data operations.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' })
    return
  }

  const token = authHeader.slice(7)

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(500).json({ error: 'Server misconfiguration' })
    return
  }

  const client = createClient(supabaseUrl, supabaseAnonKey)
  const { data, error } = await client.auth.getUser(token)

  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }

  req.user = data.user
  next()
}
