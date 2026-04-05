import { apiFetch, parseErrorResponse } from '../lib/fetchJson'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GeneratedStep {
  id: string
  type: string
  message_template: string | null
  subject: string | null
  ai_generation_mode: boolean
  [key: string]: unknown
}

export interface GenerateAllResult {
  updated: number
  steps: GeneratedStep[]
  errors?: string[]
}

export interface PreviewResult {
  preview: string
  subject?: string
  lead_name: string
  lead_company: string | null
}

// ─── Generate all message steps in a sequence ─────────────────────────────────

export async function generateAllSteps(
  sequenceId: string,
  productId?: string
): Promise<GenerateAllResult> {
  const res = await apiFetch(`/api/sequence-ai/${sequenceId}/generate-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_id: productId }),
  })
  if (!res.ok) {
    const err = await parseErrorResponse(res)
    throw new Error(err)
  }
  return res.json() as Promise<GenerateAllResult>
}

// ─── Regenerate a single step ─────────────────────────────────────────────────

export async function generateSingleStep(
  sequenceId: string,
  stepId: string,
  productId?: string
): Promise<GeneratedStep> {
  const res = await apiFetch(`/api/sequence-ai/${sequenceId}/steps/${stepId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_id: productId }),
  })
  if (!res.ok) {
    const err = await parseErrorResponse(res)
    throw new Error(err)
  }
  const { data } = await res.json() as { data: GeneratedStep }
  return data
}

// ─── Preview a step for a specific lead ──────────────────────────────────────

export async function previewStepForLead(
  sequenceId: string,
  stepId: string,
  leadId: string
): Promise<PreviewResult> {
  const res = await apiFetch(`/api/sequence-ai/${sequenceId}/steps/${stepId}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_id: leadId }),
  })
  if (!res.ok) {
    const err = await parseErrorResponse(res)
    throw new Error(err)
  }
  return res.json() as Promise<PreviewResult>
}
