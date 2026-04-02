import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'

export const templatesRouter = Router()

templatesRouter.use(requireAuth)

// GET /api/templates — list user's saved templates
templatesRouter.get('/', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('sequence_templates')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data })
})

// POST /api/templates — save a template
templatesRouter.post('/', async (req: Request, res: Response) => {
  const { name, description, steps_json } = req.body as {
    name: string
    description?: string
    steps_json: unknown[]
  }

  if (!name || !Array.isArray(steps_json)) {
    res.status(400).json({ error: 'name and steps_json are required' })
    return
  }

  const { data, error } = await supabase
    .from('sequence_templates')
    .insert({
      user_id: req.user.id,
      name,
      description: description ?? null,
      steps_json,
    })
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(201).json({ data })
})

// DELETE /api/templates/:id
templatesRouter.delete('/:id', async (req: Request, res: Response) => {
  const { error } = await supabase
    .from('sequence_templates')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(204).send()
})
