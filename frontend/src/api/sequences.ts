import { supabase } from '../lib/supabase'

export type StepType = 'connect' | 'message' | 'wait' | 'inmail' | 'view_profile' | 'react_post' | 'fork' | 'follow' | 'end'
export type Branch = 'main' | 'if_yes' | 'if_no'
export type ForkCondition = 'replied' | 'not_replied' | 'connected' | 'not_connected'
export type ReactionType = 'like' | 'celebrate' | 'love' | 'insightful' | 'curious'

export interface SequenceStep {
  id: string
  sequence_id: string
  step_order: number
  type: StepType
  message_template: string | null
  subject: string | null
  wait_days: number | null
  condition: Record<string, unknown> | null
  parent_step_id: string | null
  branch: Branch
  created_at: string
  updated_at: string
}

export interface Sequence {
  id: string
  campaign_id: string
  name: string
  created_at: string
  updated_at: string
  sequence_steps: SequenceStep[]
}

export async function fetchSequences(campaign_id: string): Promise<Sequence[]> {
  const { data, error } = await supabase
    .from('sequences')
    .select('*, sequence_steps(*)')
    .eq('campaign_id', campaign_id)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  const sequences = (data ?? []) as Sequence[]
  for (const seq of sequences) {
    seq.sequence_steps.sort((a, b) => a.step_order - b.step_order)
  }
  return sequences
}

export async function createSequence(campaign_id: string, name: string): Promise<Sequence> {
  const { data, error } = await supabase
    .from('sequences')
    .insert({ campaign_id, name })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return { ...(data as Sequence), sequence_steps: [] }
}

export async function createStep(
  sequence_id: string,
  step: Omit<SequenceStep, 'id' | 'sequence_id' | 'created_at' | 'updated_at'>
): Promise<SequenceStep> {
  const { data, error } = await supabase
    .from('sequence_steps')
    .insert({ sequence_id, ...step })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as SequenceStep
}

export async function updateStep(
  id: string,
  updates: Partial<Pick<SequenceStep, 'type' | 'message_template' | 'subject' | 'wait_days' | 'step_order' | 'condition'>>
): Promise<SequenceStep> {
  const { data, error } = await supabase
    .from('sequence_steps')
    .update(updates)
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as SequenceStep
}

export async function deleteStep(id: string): Promise<void> {
  const { error } = await supabase.from('sequence_steps').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function clearSteps(sequenceId: string): Promise<void> {
  const { error } = await supabase.from('sequence_steps').delete().eq('sequence_id', sequenceId)
  if (error) throw new Error(error.message)
}

export async function reorderSteps(steps: { id: string; step_order: number }[]): Promise<void> {
  await Promise.all(
    steps.map(({ id, step_order }) =>
      supabase.from('sequence_steps').update({ step_order }).eq('id', id)
    )
  )
}
