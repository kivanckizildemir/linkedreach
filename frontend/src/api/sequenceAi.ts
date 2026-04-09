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

export interface BuildFlowResult {
  strategy: string | null
  rationale: string | null
  mode: 'ai_automated' | 'manual'
  steps: GeneratedStep[]
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
  productId?: string,
  profileSources?: string[]
): Promise<GeneratedStep> {
  const res = await apiFetch(`/api/sequence-ai/${sequenceId}/steps/${stepId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_id: productId, profile_sources: profileSources }),
  })
  if (!res.ok) {
    const err = await parseErrorResponse(res)
    throw new Error(err)
  }
  const { data } = await res.json() as { data: GeneratedStep }
  return data
}

// ─── Build a full AI-designed sequence flow ───────────────────────────────────

export async function buildSequenceFlow(sequenceId: string): Promise<BuildFlowResult> {
  const res = await apiFetch(`/api/sequence-ai/${sequenceId}/build-flow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const err = await parseErrorResponse(res)
    throw new Error(err)
  }
  return res.json() as Promise<BuildFlowResult>
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
