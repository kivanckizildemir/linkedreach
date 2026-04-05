import { useState, useCallback, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useViewport,
  ReactFlowProvider,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  fetchSequences,
  createSequence,
  createStep,
  updateStep,
  deleteStep,
  type Sequence,
  type SequenceStep,
  type StepType,
  type Branch,
  type ForkCondition,
  type ReactionType,
} from '../api/sequences'
import {
  fetchCampaignLeads,
  assignLeads,
  removeCampaignLead,
  type CampaignLead,
} from '../api/campaignLeads'
import { fetchLeads, type Lead } from '../api/leads'
import { fetchCampaign, updateCampaign, type Campaign } from '../api/campaigns'
import {
  PRESET_TEMPLATES,
  fetchUserTemplates,
  saveTemplate,
  deleteUserTemplate,
  type TemplateStep,
} from '../api/templates'
import { clearSteps } from '../api/sequences'
import { supabase } from '../lib/supabase'
import {
  generateAllSteps,
  generateSingleStep,
  previewStepForLead,
  type PreviewResult,
} from '../api/sequenceAi'

// ── Layout constants ──────────────────────────────────────────────────────────

const NW = 264       // node width
const NH = 84        // approx node height for layout calc
const VG = 56        // vertical gap between nodes
const BX = 320       // horizontal offset from center for fork branches
const ADD_SZ = 36    // add button size

// ── Step config ───────────────────────────────────────────────────────────────

const STEP_CFG: Record<StepType, { label: string; icon: string; color: string; bg: string; border: string }> = {
  connect:      { label: 'Connection Request', icon: '🔗', color: '#2563EB', bg: '#EFF6FF', border: '#BFDBFE' },
  message:      { label: 'Message',            icon: '💬', color: '#16A34A', bg: '#F0FDF4', border: '#BBF7D0' },
  inmail:       { label: 'InMail',             icon: '⭐', color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
  wait:         { label: 'Wait',               icon: '⏳', color: '#6B7280', bg: '#F9FAFB', border: '#E5E7EB' },
  view_profile: { label: 'View Profile',       icon: '👁️', color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE' },
  react_post:   { label: 'React to Post',      icon: '❤️', color: '#E11D48', bg: '#FFF1F2', border: '#FECDD3' },
  follow:       { label: 'Follow',             icon: '➕', color: '#0891B2', bg: '#ECFEFF', border: '#A5F3FC' },
  fork:         { label: 'Condition Fork',     icon: '🔀', color: '#4F46E5', bg: '#EEF2FF', border: '#C7D2FE' },
  end:          { label: 'End Sequence',       icon: '⛔', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
}

// Only the two non-redundant conditions — YES/NO branches cover the inverse automatically.
const FORK_CONDS: { value: ForkCondition; question: string; yes: string; no: string }[] = [
  { value: 'replied',   question: 'Did the lead reply?',        yes: '✓ Replied',       no: '✗ No reply' },
  { value: 'connected', question: 'Is the lead connected?',     yes: '✓ Connected',     no: '✗ Not connected' },
]
// Keep a lookup for rendering existing steps that may have older condition values
const FORK_COND_LABEL: Record<ForkCondition, string> = {
  replied:       'Did the lead reply?',
  not_replied:   'Did the lead not reply?',
  connected:     'Is the lead connected?',
  not_connected: 'Is the lead not connected?',
}

// ── Sequence validation ───────────────────────────────────────────────────────
// Every open chain (main or fork branch) must end with an 'end' step.
// A chain that ends with a 'fork' is validated recursively via its own branches.

function validateSequence(steps: SequenceStep[]): string[] {
  const warnings: string[] = []

  function checkChain(parentId: string | null, branch: Branch, label: string) {
    const chain = steps
      .filter(s => s.parent_step_id === parentId && s.branch === branch)
      .sort((a, b) => a.step_order - b.step_order)

    if (chain.length === 0) {
      if (parentId !== null) {
        // Only warn about empty branches inside forks, not an empty main sequence
        warnings.push(`${label} branch is empty — add steps or an End Sequence`)
      }
      return
    }

    const last = chain[chain.length - 1]

    if (last.type === 'end') {
      return  // properly closed
    }

    if (last.type === 'fork') {
      // Fork terminates this chain — validate its own branches
      const forkLabel = FORK_COND_LABEL[last.condition?.type as ForkCondition] ?? 'Condition Fork'
      checkChain(last.id, 'if_yes', `"${forkLabel}" YES`)
      checkChain(last.id, 'if_no',  `"${forkLabel}" NO`)
      return
    }

    // Open chain — last step is neither 'end' nor 'fork'
    warnings.push(`${label} is missing an End Sequence step`)
  }

  // Only validate if the sequence has any steps at all
  const hasSteps = steps.some(s => s.parent_step_id === null && s.branch === 'main')
  if (hasSteps) {
    checkChain(null, 'main', 'Main sequence')
  }

  return warnings
}

const REACTIONS: Record<ReactionType, { label: string; emoji: string }> = {
  like:       { label: 'Like',       emoji: '👍' },
  celebrate:  { label: 'Clap',       emoji: '👏' },
  love:       { label: 'Love',       emoji: '❤️' },
  insightful: { label: 'Insightful', emoji: '💡' },
  curious:    { label: 'Curious',    emoji: '🤔' },
}

const ALL_STEP_TYPES: StepType[] = ['connect', 'message', 'inmail', 'wait', 'view_profile', 'react_post', 'follow', 'fork', 'end']

// ── Context-aware step gating ─────────────────────────────────────────────────

interface DisabledEntry { type: StepType; reason: string }

/** Rules that apply when entering a specific fork branch */
function forkBranchDisabled(condition: ForkCondition | undefined, branch: 'if_yes' | 'if_no'): DisabledEntry[] {
  const d: DisabledEntry[] = []
  if (condition === 'connected') {
    if (branch === 'if_yes') {
      d.push({ type: 'connect',  reason: 'Already connected — a 2nd request is impossible' })
      d.push({ type: 'inmail',   reason: 'InMail is for non-connections — use Message instead' })
      d.push({ type: 'follow',   reason: 'LinkedIn auto-follows when you connect' })
    } else {
      d.push({ type: 'message',  reason: "Not connected — can't DM yet. Send a request first." })
    }
  }
  if (condition === 'replied') {
    if (branch === 'if_yes') {
      d.push({ type: 'connect',  reason: 'They replied — they are already a connection' })
      d.push({ type: 'inmail',   reason: 'They already replied — reply back with a Message' })
    }
  }
  return d
}

/** Extra rules derived from what step types already appear in this chain */
function chainDisabled(chainTypes: StepType[]): DisabledEntry[] {
  const d: DisabledEntry[] = []
  const has = (t: StepType) => chainTypes.includes(t)

  if (has('connect')) {
    d.push({ type: 'connect', reason: 'Already sent a connection request in this branch' })
    if (!has('message')) {
      // Connection not yet accepted at this point in the chain
      d.push({ type: 'message', reason: 'Request not yet accepted — add a fork (Is connected?) first' })
    }
    d.push({ type: 'inmail', reason: "Don't mix Connection Request and InMail in the same branch" })
  }

  if (has('message')) {
    d.push({ type: 'connect', reason: 'Lead is already connected (message was sent)' })
    d.push({ type: 'inmail',  reason: 'InMail is for non-connections — lead is already connected' })
  }

  if (has('inmail')) {
    d.push({ type: 'inmail',   reason: 'Already sent an InMail in this branch' })
    d.push({ type: 'connect',  reason: "Don't mix InMail and Connection Request" })
    d.push({ type: 'message',  reason: 'Lead is not connected — InMail already covers outreach' })
  }

  return d
}

/** Merge two disabled lists, deduplicating by step type (first reason wins). */
function mergeDisabled(a: DisabledEntry[], b: DisabledEntry[]): DisabledEntry[] {
  const seen = new Set(a.map(e => e.type))
  return [...a, ...b.filter(e => !seen.has(e.type))]
}

// ── Tree ──────────────────────────────────────────────────────────────────────

interface StepNode { step: SequenceStep; ifYes?: StepNode[]; ifNo?: StepNode[] }

function buildTree(all: SequenceStep[], parentId: string | null = null, branch: Branch = 'main'): StepNode[] {
  return all
    .filter(s => s.parent_step_id === parentId && s.branch === branch)
    .sort((a, b) => a.step_order - b.step_order)
    .map(s => ({
      step: s,
      ...(s.type === 'fork' ? { ifYes: buildTree(all, s.id, 'if_yes'), ifNo: buildTree(all, s.id, 'if_no') } : {}),
    }))
}

// ── Layout ────────────────────────────────────────────────────────────────────

interface Callbacks {
  onAdd: (parentId: string | null, branch: Branch, type: StepType) => void
}

function mkEdge(
  id: string, source: string, target: string,
  opts: { sourceHandle?: string; label?: string; labelColor?: string; dashed?: boolean } = {}
): Edge {
  return {
    id,
    source,
    sourceHandle: opts.sourceHandle,
    target,
    type: 'smoothstep',
    label: opts.label,
    labelStyle: { fontSize: 11, fontWeight: 700, fill: opts.labelColor ?? '#64748B' },
    labelBgStyle: { fill: '#fff', fillOpacity: 0.95 },
    labelBgPadding: [4, 6] as [number, number],
    labelBgBorderRadius: 4,
    markerEnd: { type: MarkerType.ArrowClosed, color: opts.labelColor ?? '#94A3B8', width: 14, height: 14 },
    style: {
      stroke: opts.labelColor ?? '#94A3B8',
      strokeWidth: 2,
      ...(opts.dashed ? { strokeDasharray: '6,4' } : {}),
    },
  }
}

function buildLayout(allSteps: SequenceStep[], cb: Callbacks): { nodes: Node[]; edges: Edge[] } {
  const rfNodes: Node[] = []
  const rfEdges: Edge[] = []

  // Start pill
  rfNodes.push({ id: '__start', type: 'startNode', position: { x: -(NW / 2), y: 0 }, data: {} })

  const tree = buildTree(allSteps, null, 'main')

  function layoutList(
    nodes: StepNode[],
    cx: number,
    startY: number,
    fromId: string,
    fromHandle?: string,
    edgeLabel?: string,
    edgeColor?: string,
    inheritedDisabled: DisabledEntry[] = [],
  ): { endY: number; lastId: string; lastHandle?: string; chainDisabledForNext: DisabledEntry[] } {
    let y = startY
    let prevId = fromId
    let prevHandle = fromHandle
    let label = edgeLabel
    let color = edgeColor

    // Accumulate step types seen in this chain for context-aware gating
    const chainTypes: StepType[] = []

    for (const node of nodes) {
      const { step } = node
      const isFork = step.type === 'fork'
      const isEnd  = step.type === 'end'

      rfNodes.push({
        id: step.id,
        type: isFork ? 'forkNode' : isEnd ? 'endNode' : 'stepNode',
        position: { x: cx - NW / 2, y },
        data: { step },
        draggable: false,
      })

      rfEdges.push(mkEdge(`e_${prevId}_${step.id}`, prevId, step.id, {
        sourceHandle: prevHandle,
        label,
        labelColor: color,
      }))

      label = undefined
      color = undefined
      prevHandle = undefined

      if (!isFork && !isEnd) chainTypes.push(step.type)

      if (isEnd) {
        y += NH + VG
        prevId = step.id
        prevHandle = 'bottom'  // sentinel: suppress continuation add button
      } else if (isFork) {
        const branchY = y + NH + VG
        const forkCond = step.condition?.type as ForkCondition | undefined

        const yesInherited = mergeDisabled(inheritedDisabled, forkBranchDisabled(forkCond, 'if_yes'))
        const noInherited  = mergeDisabled(inheritedDisabled, forkBranchDisabled(forkCond, 'if_no'))

        const yesRes = layoutList(node.ifYes ?? [], cx - BX, branchY, step.id, 'yes', '✓ Yes', '#16A34A', yesInherited)
        const noRes  = layoutList(node.ifNo  ?? [], cx + BX, branchY, step.id, 'no',  '✗ No',  '#DC2626', noInherited)

        // Add buttons at end of each branch — only if the branch doesn't end with a fork itself.
        // A fork-terminated branch already has its own YES/NO add buttons; adding another here
        // would create a spurious third outcome button.
        const addYesId = `__add_${step.id}_yes`
        const addNoId  = `__add_${step.id}_no`

        if (yesRes.lastHandle !== 'bottom') {
          const yesAddDisabled = mergeDisabled(yesInherited, yesRes.chainDisabledForNext)
          rfNodes.push(
            { id: addYesId, type: 'addNode', position: { x: cx - BX - ADD_SZ / 2, y: yesRes.endY + VG }, draggable: false,
              data: { onAdd: (t: StepType) => cb.onAdd(step.id, 'if_yes', t), disabledReasons: yesAddDisabled } },
          )
          rfEdges.push(
            mkEdge(`e_${yesRes.lastId}_${addYesId}`, yesRes.lastId, addYesId, {
              sourceHandle: yesRes.lastHandle,
              label: yesRes.lastId === step.id ? '✓ Yes' : undefined,
              labelColor: yesRes.lastId === step.id ? '#16A34A' : undefined,
              dashed: true,
            }),
          )
        }

        if (noRes.lastHandle !== 'bottom') {
          const noAddDisabled = mergeDisabled(noInherited, noRes.chainDisabledForNext)
          rfNodes.push(
            { id: addNoId,  type: 'addNode', position: { x: cx + BX - ADD_SZ / 2, y: noRes.endY  + VG }, draggable: false,
              data: { onAdd: (t: StepType) => cb.onAdd(step.id, 'if_no',  t), disabledReasons: noAddDisabled } },
          )
          rfEdges.push(
            mkEdge(`e_${noRes.lastId}_${addNoId}`, noRes.lastId, addNoId, {
              sourceHandle: noRes.lastHandle,
              label: noRes.lastId === step.id ? '✗ No' : undefined,
              labelColor: noRes.lastId === step.id ? '#DC2626' : undefined,
              dashed: true,
            }),
          )
        }

        const maxY = Math.max(yesRes.endY, noRes.endY) + VG + ADD_SZ
        y = maxY + VG
        prevId = step.id
        prevHandle = 'bottom'
      } else {
        y += NH + VG
        prevId = step.id
      }
    }

    return { endY: y - VG, lastId: prevId, lastHandle: prevHandle, chainDisabledForNext: chainDisabled(chainTypes) }
  }

  const { endY, lastId, lastHandle, chainDisabledForNext: mainChainDisabled } = layoutList(tree, 0, NH + VG, '__start')

  // Don't show a main-chain add button when the last step is a fork —
  // forks terminate the flow; new steps go into the YES or NO branches only.
  if (lastHandle !== 'bottom') {
    const addMainId = '__add_main'
    rfNodes.push({
      id: addMainId, type: 'addNode', draggable: false,
      position: { x: -ADD_SZ / 2, y: endY + VG },
      data: { onAdd: (t: StepType) => cb.onAdd(null, 'main', t), disabledReasons: mainChainDisabled },
    })
    rfEdges.push(mkEdge(`e_${lastId}_${addMainId}`, lastId, addMainId, { sourceHandle: lastHandle, dashed: true }))
  }

  return { nodes: rfNodes, edges: rfEdges }
}

// ── Custom nodes ──────────────────────────────────────────────────────────────

function StartNodeComp() {
  return (
    <div style={{ width: NW }} className="flex items-center justify-center">
      <div className="px-8 py-2 bg-gray-900 text-white text-sm font-semibold rounded-full shadow-lg tracking-wide">
        START
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-gray-400 !w-2 !h-2" />
    </div>
  )
}

function StepNodeComp({ data }: NodeProps) {
  const { step } = data as { step: SequenceStep }
  const cfg = STEP_CFG[step.type]
  const reaction = step.condition?.reaction as ReactionType | undefined

  return (
    <div
      style={{ width: NW, background: cfg.bg, border: `2px solid ${cfg.border}`, borderLeft: `5px solid ${cfg.color}`, cursor: 'pointer' }}
      className="rounded-2xl shadow-md relative"
    >
      <Handle type="target" position={Position.Top} className="!w-2 !h-2" style={{ background: cfg.color }} />

      <div className="flex items-start gap-2.5 px-3.5 py-3">
        <span className="text-lg leading-none mt-0.5 select-none">{cfg.icon}</span>
        <div className="flex-1 min-w-0 pr-1">
          <p className="text-[10px] font-bold uppercase tracking-widest mb-0.5" style={{ color: cfg.color }}>
            {cfg.label}
          </p>
          {/* AI/Manual badge for message steps */}
          {(step.type === 'connect' || step.type === 'message' || step.type === 'inmail') && (
            <span className={`absolute top-2 right-2 text-xs font-semibold px-1.5 py-0.5 rounded-full ${step.ai_generation_mode ? 'bg-violet-100 text-violet-600' : 'bg-gray-100 text-gray-400'}`}>
              {step.ai_generation_mode ? '✨' : '✍️'}
            </span>
          )}
          <div className="text-xs text-gray-700 leading-relaxed">
            {step.type === 'wait' && (() => {
              const val = step.wait_days ?? 1
              const unit = (step.condition?.wait_unit as string) ?? 'days'
              return (
                <span className="font-semibold text-sm text-gray-800">
                  {val} {unit === 'minutes' ? (val !== 1 ? 'minutes' : 'minute') : unit === 'hours' ? (val !== 1 ? 'hours' : 'hour') : (val !== 1 ? 'days' : 'day')}
                </span>
              )
            })()}
            {step.type === 'view_profile' && <span className="text-gray-500">Visits profile before next action</span>}
            {step.type === 'follow' && <span className="text-gray-500">Follows this lead on LinkedIn</span>}
            {step.type === 'end' && <span className="text-red-400">Stops the sequence for this lead</span>}
            {step.type === 'react_post' && (
              <span>{reaction ? `${REACTIONS[reaction].emoji} ${REACTIONS[reaction].label}` : <span className="text-gray-400 italic">No reaction set</span>}</span>
            )}
            {step.type === 'connect' && (
              <span className="truncate block text-gray-500 italic">
                {step.message_template ? `"${step.message_template}"` : 'No note attached'}
              </span>
            )}
            {(step.type === 'message' || step.type === 'inmail') && (
              <div className="space-y-0.5">
                {step.type === 'inmail' && step.subject && (
                  <p className="font-semibold text-gray-800 truncate">Sub: {step.subject}</p>
                )}
                <p className="text-gray-500 truncate italic">
                  {step.message_template ?? 'No message set'}
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: cfg.color + '66' }}>
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} className="!w-2 !h-2" style={{ background: cfg.color }} />
    </div>
  )
}

function ForkNodeComp({ data }: NodeProps) {
  const { step } = data as { step: SequenceStep }
  const forkCond = step.condition?.type as ForkCondition | undefined
  const condDef = FORK_CONDS.find(c => c.value === forkCond)

  return (
    <div
      style={{ width: NW, background: '#EEF2FF', border: '2.5px dashed #818CF8', borderLeft: '5px solid #4F46E5', cursor: 'pointer' }}
      className="rounded-2xl shadow-md"
    >
      <Handle type="target" position={Position.Top} className="!w-2 !h-2 !bg-indigo-500" />

      <div className="flex items-start gap-2.5 px-3.5 py-3">
        <span className="text-lg leading-none mt-0.5 select-none">🔀</span>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-500 mb-0.5">Condition</p>
          <p className="text-sm font-semibold text-indigo-800">
            {forkCond
              ? (FORK_COND_LABEL[forkCond] ?? forkCond)
              : <span className="italic font-normal text-indigo-400">No condition set</span>}
          </p>
        </div>
        <div className="shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-indigo-300">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </div>
      </div>

      <div className="flex justify-between px-5 pb-3 text-[10px] font-bold">
        <span className="text-green-600">{condDef?.yes ?? '✓ Yes'}</span>
        <span className="text-red-500">{condDef?.no ?? '✗ No'}</span>
      </div>

      <Handle id="yes" type="source" position={Position.Bottom}
        style={{ left: '25%', background: '#16A34A' }} className="!w-2.5 !h-2.5" />
      <Handle id="no" type="source" position={Position.Bottom}
        style={{ left: '75%', background: '#DC2626' }} className="!w-2.5 !h-2.5" />
      <Handle id="bottom" type="source" position={Position.Bottom}
        style={{ left: '50%', opacity: 0, pointerEvents: 'none' }} />
    </div>
  )
}

// Invisible placeholder — just anchors the edge. The real button lives in the DOM overlay.
function AddNodeComp() {
  return (
    <div style={{ width: ADD_SZ, height: ADD_SZ }}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: 'none' }} />
    </div>
  )
}

// Rendered in a regular div overlay above the canvas — React Flow never sees these events.
function OverlayAddButton({ onAdd, disabledReasons = [] }: {
  onAdd: (type: StepType) => void
  disabledReasons?: DisabledEntry[]
}) {
  const [open, setOpen] = useState(false)
  const [tooltip, setTooltip] = useState<string | null>(null)
  const disabledMap = new Map(disabledReasons.map(e => [e.type, e.reason]))

  return (
    <div className="relative" style={{ width: ADD_SZ, height: ADD_SZ }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: ADD_SZ, height: ADD_SZ }}
        className="rounded-full border-2 border-dashed border-gray-300 bg-white text-gray-400 hover:border-blue-400 hover:text-blue-500 hover:bg-blue-50 transition-all flex items-center justify-center text-xl font-light shadow-sm"
      >
        +
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-1/2 -translate-x-1/2 top-10 z-50 bg-white rounded-2xl shadow-2xl border border-gray-100 p-2 w-64">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 px-3 py-1.5">Add step</p>
            {ALL_STEP_TYPES.map(type => {
              const cfg = STEP_CFG[type]
              const reason = disabledMap.get(type)
              const isDisabled = !!reason
              return (
                <div key={type} className="relative"
                  onMouseEnter={() => isDisabled ? setTooltip(type) : undefined}
                  onMouseLeave={() => setTooltip(null)}>
                  <button
                    onClick={() => { if (!isDisabled) { onAdd(type); setOpen(false) } }}
                    className={[
                      'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left',
                      isDisabled
                        ? 'opacity-40 cursor-not-allowed'
                        : 'hover:bg-gray-50',
                    ].join(' ')}
                  >
                    <span className="text-base w-5 text-center">{cfg.icon}</span>
                    <p className="text-sm font-medium text-gray-800">{cfg.label}</p>
                    {isDisabled && (
                      <span className="ml-auto text-[9px] font-bold text-red-400 uppercase tracking-wider">N/A</span>
                    )}
                  </button>
                  {isDisabled && tooltip === type && (
                    <div className="absolute left-full top-0 ml-2 z-60 w-52 bg-gray-900 text-white text-xs rounded-xl px-3 py-2 shadow-xl leading-relaxed pointer-events-none whitespace-normal">
                      <p className="font-semibold text-red-300 mb-0.5 text-[10px] uppercase tracking-wider">Not allowed here</p>
                      {reason}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function EndNodeComp() {
  return (
    <div style={{ width: NW }} className="flex items-center justify-center">
      <Handle type="target" position={Position.Top} className="!w-2 !h-2 !bg-red-400" />
      <div
        style={{ width: NW, background: '#FEF2F2', border: '2px solid #FECACA', borderLeft: '5px solid #DC2626' }}
        className="rounded-2xl shadow-md px-4 py-3 flex items-center gap-2.5 cursor-pointer"
      >
        <span className="text-lg select-none">⛔</span>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-red-600 mb-0.5">End Sequence</p>
          <p className="text-xs text-red-400">Stops this lead's journey here</p>
        </div>
      </div>
    </div>
  )
}

// ── nodeTypes — defined outside component for stability ───────────────────────

const nodeTypes = {
  startNode: StartNodeComp as React.ComponentType<NodeProps>,
  stepNode:  StepNodeComp  as React.ComponentType<NodeProps>,
  forkNode:  ForkNodeComp  as React.ComponentType<NodeProps>,
  endNode:   EndNodeComp   as React.ComponentType<NodeProps>,
  addNode:   AddNodeComp   as React.ComponentType<NodeProps>,
}

// ── Edit modal ────────────────────────────────────────────────────────────────

function EditModal({ step, sequenceId, onSave, onDelete, onClose, onTest }: {
  step: SequenceStep
  sequenceId: string
  onSave: (updates: Partial<SequenceStep>) => void
  onDelete: (id: string) => void
  onClose: () => void
  onTest: (step: SequenceStep) => void
}) {
  const [msg,       setMsg]  = useState(step.message_template ?? '')
  const [subject,   setSubj] = useState(step.subject ?? '')
  const [waitVal,   setWaitVal] = useState(step.wait_days ?? 1)
  const [waitUnit,  setWaitUnit] = useState<'minutes' | 'hours' | 'days'>((step.condition?.wait_unit as 'minutes' | 'hours' | 'days') ?? 'days')
  const [forkCond,  setFork] = useState<ForkCondition>((step.condition?.type as ForkCondition) ?? 'replied')
  const [reaction,  setRct]  = useState<ReactionType>((step.condition?.reaction as ReactionType) ?? 'like')
  const [aiMode,    setAiMode] = useState(step.ai_generation_mode ?? false)
  const [regen,     setRegen] = useState(false)
  const [regenErr,  setRegenErr] = useState('')
  const cfg = STEP_CFG[step.type]
  const isMessage = step.type === 'connect' || step.type === 'message' || step.type === 'inmail'

  const waitMax = waitUnit === 'minutes' ? 120 : waitUnit === 'hours' ? 72 : 60

  async function handleRegenerate() {
    setRegen(true)
    setRegenErr('')
    try {
      const result = await generateSingleStep(sequenceId, step.id)
      setMsg(result.message_template ?? '')
      if (result.subject) setSubj(result.subject)
      setAiMode(true)
    } catch (err) {
      setRegenErr(err instanceof Error ? err.message : 'Regeneration failed')
    } finally {
      setRegen(false)
    }
  }

  function save() {
    const u: Partial<SequenceStep> = {}
    if (step.type === 'wait')        { u.wait_days = waitVal; u.condition = { wait_unit: waitUnit } }
    if (step.type === 'fork')        u.condition = { type: forkCond }
    if (step.type === 'react_post')  u.condition = { reaction }
    if (step.type === 'inmail')      { u.subject = subject; u.message_template = msg || null; u.ai_generation_mode = aiMode }
    if (step.type === 'connect' || step.type === 'message') { u.message_template = msg || null; u.ai_generation_mode = aiMode }
    onSave(u)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-100">
          <span className="text-2xl">{cfg.icon}</span>
          <h2 className="text-base font-bold text-gray-900">Edit {cfg.label}</h2>
          {isMessage && (
            <div className="ml-1 flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
              <button
                type="button"
                onClick={() => setAiMode(true)}
                className={[
                  'px-3 py-1 transition-colors',
                  aiMode ? 'bg-violet-600 text-white' : 'text-gray-500 hover:bg-gray-50',
                ].join(' ')}
              >
                ✨ AI Automated
              </button>
              <button
                type="button"
                onClick={() => setAiMode(false)}
                className={[
                  'px-3 py-1 border-l border-gray-200 transition-colors',
                  !aiMode ? 'bg-gray-800 text-white' : 'text-gray-500 hover:bg-gray-50',
                ].join(' ')}
              >
                ✍️ Manual
              </button>
            </div>
          )}
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-700 transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {step.type === 'wait' && (
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-3">Wait duration</label>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setWaitVal(v => Math.max(1, v - 1))}
                  className="w-9 h-9 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 flex items-center justify-center font-bold"
                >−</button>
                <span className="text-2xl font-bold text-gray-900 w-10 text-center">{waitVal}</span>
                <button
                  onClick={() => setWaitVal(v => Math.min(waitMax, v + 1))}
                  className="w-9 h-9 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 flex items-center justify-center font-bold"
                >+</button>
                <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm font-medium ml-1">
                  {(['minutes', 'hours', 'days'] as const).map(u => (
                    <button
                      key={u}
                      onClick={() => { setWaitUnit(u); setWaitVal(v => Math.min(v, u === 'minutes' ? 120 : u === 'hours' ? 72 : 60)) }}
                      className={[
                        'px-3 py-1.5 transition-colors capitalize',
                        waitUnit === u
                          ? 'bg-gray-800 text-white'
                          : 'text-gray-600 hover:bg-gray-50',
                      ].join(' ')}
                    >
                      {u}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step.type === 'fork' && (
            <div className="space-y-3">
              <label className="block text-sm font-semibold text-gray-700">Branch condition</label>
              <div className="grid grid-cols-1 gap-2">
                {FORK_CONDS.map(({ value, question, yes, no }) => (
                  <button key={value} onClick={() => setFork(value)}
                    className={[
                      'flex items-start gap-3 px-4 py-3 rounded-xl border-2 text-sm text-left transition-all',
                      forkCond === value
                        ? 'border-indigo-400 bg-indigo-50'
                        : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50',
                    ].join(' ')}>
                    <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${forkCond === value ? 'border-indigo-500 bg-indigo-500' : 'border-gray-300'}`}>
                      {forkCond === value && <span className="w-1.5 h-1.5 rounded-full bg-white block" />}
                    </span>
                    <div>
                      <p className="font-semibold text-gray-800">{question}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        <span className="text-green-600 font-medium">{yes}</span>
                        {' → '}
                        <span className="text-red-500 font-medium">{no}</span>
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step.type === 'react_post' && (
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">Reaction type</label>
              <div className="flex flex-wrap gap-2">
                {(Object.entries(REACTIONS) as [ReactionType, { label: string; emoji: string }][]).map(([val, { label, emoji }]) => (
                  <button key={val} onClick={() => setRct(val)}
                    className={[
                      'flex items-center gap-2 px-3 py-2 rounded-xl border-2 text-sm font-medium transition-all',
                      reaction === val
                        ? 'border-rose-400 bg-rose-50 text-rose-700'
                        : 'border-gray-200 text-gray-700 hover:border-gray-300',
                    ].join(' ')}>
                    <span className="text-base">{emoji}</span> {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step.type === 'inmail' && (
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">Subject line</label>
              <input type="text" value={subject} onChange={e => setSubj(e.target.value)}
                placeholder="e.g. Quick question about your team"
                className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          )}

          {(step.type === 'connect' || step.type === 'message' || step.type === 'inmail') && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-semibold text-gray-700">
                  {step.type === 'connect' ? 'Note (optional, max 300 chars)' : 'Message body'}
                </label>
                {aiMode && (
                  <button
                    onClick={handleRegenerate}
                    disabled={regen}
                    className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-violet-700 bg-violet-50 border border-violet-200 rounded-lg hover:bg-violet-100 disabled:opacity-50 transition-colors"
                  >
                    {regen ? '⏳ Regenerating…' : '✨ Regenerate'}
                  </button>
                )}
              </div>
              {!aiMode && (
                <p className="text-xs text-gray-400 mb-2">
                  Personalise with{' '}
                  {['{{first_name}}', '{{company}}', '{{title}}'].map(v => (
                    <code key={v} className="bg-gray-100 px-1.5 py-0.5 rounded mx-0.5 text-gray-600">{v}</code>
                  ))}
                </p>
              )}
              {regenErr && (
                <p className="text-xs text-red-500 mb-2">{regenErr}</p>
              )}
              <textarea
                value={msg}
                onChange={e => { setMsg(e.target.value); setAiMode(false) }}
                rows={5}
                maxLength={step.type === 'connect' ? 300 : undefined}
                placeholder={step.type === 'connect'
                  ? 'Hi {{first_name}}, I came across your profile and would love to connect…'
                  : 'Hi {{first_name}}, thanks for connecting! I wanted to reach out because…'}
                className={[
                  'w-full px-4 py-3 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none',
                  aiMode ? 'border-violet-200 bg-violet-50/30' : 'border-gray-200',
                ].join(' ')}
              />
              <div className="flex items-center justify-between mt-1">
                {aiMode
                  ? <span className="text-[10px] text-violet-500 font-medium">✨ AI generated — edit freely or regenerate</span>
                  : <span className="text-[10px] text-gray-400">Edit manually</span>
                }
                <span className="text-xs text-gray-400">{msg.length}{step.type === 'connect' ? '/300' : ''}</span>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-3 px-6 pb-6">
          <button onClick={() => { onDelete(step.id); onClose() }}
            className="py-2.5 px-4 border-2 border-red-200 text-sm font-semibold text-red-500 rounded-xl hover:bg-red-50 transition-colors">
            Delete
          </button>
          <button onClick={onClose}
            className="flex-1 py-2.5 border-2 border-gray-200 text-sm font-semibold text-gray-700 rounded-xl hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          {isMessage && (
            <button
              onClick={() => { save(); onTest(step) }}
              className="flex-1 py-2.5 text-sm font-semibold text-violet-700 border-2 border-violet-200 rounded-xl hover:bg-violet-50 transition-colors"
            >
              🔍 Test
            </button>
          )}
          <button onClick={save}
            className="flex-1 py-2.5 text-sm font-semibold text-white rounded-xl transition-colors"
            style={{ background: STEP_CFG[step.type].color }}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Test Message Modal ────────────────────────────────────────────────────────
// Can be opened from the toolbar (no pre-selected step) or from EditModal (step pre-selected).

const MESSAGE_STEP_TYPES = new Set(['connect', 'message', 'inmail'])

function TestMessageModal({
  initialStep,
  allSteps,
  sequenceId,
  campaignId,
  campaignApproach,
  campaignTone,
  onClose,
}: {
  initialStep?: SequenceStep       // pre-selected when opened from EditModal
  allSteps: SequenceStep[]         // all steps — used to build step picker
  sequenceId: string
  campaignId: string
  campaignApproach?: string | null
  campaignTone?: string | null
  onClose: () => void
}) {
  const messageSteps = allSteps.filter(s => MESSAGE_STEP_TYPES.has(s.type))

  const [selectedStepId, setSelectedStepId] = useState<string>(initialStep?.id ?? messageSteps[0]?.id ?? '')
  const [leadId, setLeadId] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<PreviewResult | null>(null)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)

  const { data: campaignLeads = [], isLoading: leadsLoading } = useQuery({
    queryKey: ['campaign-leads', campaignId],
    queryFn: () => fetchCampaignLeads(campaignId),
  })

  async function handlePreview() {
    if (!leadId || !selectedStepId) return
    setLoading(true)
    setErr('')
    setResult(null)
    try {
      const r = await previewStepForLead(sequenceId, selectedStepId, leadId)
      setResult(r)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Preview failed')
    } finally {
      setLoading(false)
    }
  }

  function copyToClipboard() {
    if (!result) return
    navigator.clipboard.writeText(result.preview).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const canGenerate = !!selectedStepId && !!leadId && campaignLeads.length > 0

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[110] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-100 shrink-0">
          <span className="text-2xl">🔍</span>
          <div>
            <h2 className="text-base font-bold text-gray-900">Test Message for Lead</h2>
            <p className="text-xs text-gray-400">See exactly what a lead would receive — fully resolved</p>
          </div>
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-700 transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* Step picker */}
          {messageSteps.length === 0 ? (
            <p className="text-sm text-amber-600 bg-amber-50 px-4 py-3 rounded-xl">
              No message steps in this sequence yet. Add a Connection Request, Message, or InMail step first.
            </p>
          ) : (
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Step to preview</label>
              <div className="grid gap-2">
                {messageSteps.map(s => {
                  const cfg = STEP_CFG[s.type]
                  const isSelected = s.id === selectedStepId
                  return (
                    <button
                      key={s.id}
                      onClick={() => { setSelectedStepId(s.id); setResult(null); setErr('') }}
                      className={[
                        'flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left transition-all',
                        isSelected
                          ? 'border-violet-400 bg-violet-50'
                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50',
                      ].join(' ')}
                    >
                      <span className="text-lg shrink-0">{cfg.icon}</span>
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs font-bold uppercase tracking-wider mb-0.5 ${isSelected ? 'text-violet-600' : 'text-gray-500'}`}>
                          {cfg.label}
                        </p>
                        <p className="text-sm text-gray-700 truncate">
                          {s.message_template
                            ? s.message_template.substring(0, 70) + (s.message_template.length > 70 ? '…' : '')
                            : <span className="italic text-gray-400">No message set yet</span>}
                        </p>
                      </div>
                      {s.ai_generation_mode && (
                        <span className="text-[10px] font-semibold text-violet-600 bg-violet-100 px-2 py-0.5 rounded-full shrink-0">✨ AI</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Approach/Tone info banner */}
          {(!campaignApproach || !campaignTone) && messageSteps.length > 0 && (
            <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 px-4 py-3 rounded-xl text-xs text-blue-700">
              <span className="shrink-0 mt-0.5">ℹ️</span>
              <span>For best results, set an Outreach Approach and Tone in campaign Settings before generating a preview.</span>
            </div>
          )}

          {/* Lead picker */}
          {messageSteps.length > 0 && (
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Lead to preview for</label>
              {leadsLoading ? (
                <p className="text-xs text-gray-400">Loading leads…</p>
              ) : campaignLeads.length === 0 ? (
                <p className="text-xs text-amber-600 bg-amber-50 px-3 py-2.5 rounded-xl">
                  No leads in this campaign yet. Go to the <strong>Leads</strong> tab and add some first.
                </p>
              ) : (
                <select
                  value={leadId}
                  onChange={e => { setLeadId(e.target.value); setResult(null); setErr('') }}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-500"
                >
                  <option value="">— pick a lead —</option>
                  {campaignLeads.map(cl => (
                    <option key={cl.lead.id} value={cl.lead.id}>
                      {cl.lead.first_name} {cl.lead.last_name}
                      {cl.lead.company ? ` · ${cl.lead.company}` : ''}
                      {cl.lead.title ? ` (${cl.lead.title})` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* Generate button */}
          {messageSteps.length > 0 && campaignLeads.length > 0 && (
            <button
              onClick={handlePreview}
              disabled={!canGenerate || loading}
              className="w-full py-2.5 bg-violet-600 text-white text-sm font-semibold rounded-xl hover:bg-violet-700 disabled:opacity-50 transition-colors"
            >
              {loading ? '⏳ Generating preview…' : '✨ Generate Preview'}
            </button>
          )}

          {err && (
            <p className="text-xs text-red-500 bg-red-50 px-3 py-2.5 rounded-xl">{err}</p>
          )}

          {/* Result */}
          {result && (
            <div className="space-y-2">
              <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    {result.lead_name}{result.lead_company ? ` · ${result.lead_company}` : ''}
                  </p>
                  <button onClick={copyToClipboard} className="text-xs text-violet-600 hover:text-violet-800 font-medium transition-colors">
                    {copied ? '✓ Copied!' : 'Copy'}
                  </button>
                </div>
                {result.subject && (
                  <p className="text-xs font-semibold text-gray-700 mb-2 pb-2 border-b border-gray-200">
                    Subject: {result.subject}
                  </p>
                )}
                <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{result.preview}</p>
              </div>
              <p className="text-[10px] text-gray-400 text-center">
                Live preview only — no message was sent.
              </p>
            </div>
          )}
        </div>

        <div className="px-6 pb-5 shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2.5 border-2 border-gray-200 text-sm font-semibold text-gray-700 rounded-xl hover:bg-gray-50 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Flow canvas (inner — can use useReactFlow) ────────────────────────────────

function FlowCanvas({ sequence, campaignId }: { sequence: Sequence; campaignId: string }) {
  const queryClient = useQueryClient()
  const { fitView } = useReactFlow()
  const viewport = useViewport()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [steps, setSteps] = useState<SequenceStep[]>(sequence.sequence_steps)
  const [editingStep, setEditingStep] = useState<SequenceStep | null>(null)
  const [testingStep, setTestingStep] = useState<SequenceStep | null>(null)
  const [showTestModal, setShowTestModal] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generateErr, setGenerateErr] = useState('')
  const [showGenConfirm, setShowGenConfirm] = useState(false)

  const { data: userSettings } = useQuery({
    queryKey: ['user-settings'],
    queryFn: async () => {
      const { data } = await supabase.from('user_settings').select('icp_config').single()
      return data as { icp_config: { default_ai_mode?: boolean } } | null
    },
  })
  const defaultAiMode = userSettings?.icp_config?.default_ai_mode ?? false

  const { data: campaignData } = useQuery({
    queryKey: ['campaign-detail', campaignId],
    queryFn: () => fetchCampaign(campaignId),
  })

  const invalidate = useCallback(async () => {
    // Bypass the query cache so we always get fresh data after mutations
    const seqs = await fetchSequences(campaignId)
    setSteps(seqs[0]?.sequence_steps ?? [])
    queryClient.setQueryData(['sequences', campaignId], seqs)
  }, [queryClient, campaignId])

  const onAdd = useCallback(async (parentId: string | null, branch: Branch, type: StepType) => {
    const siblings = steps.filter(s =>
      s.parent_step_id === parentId && s.branch === branch
    )
    const nextOrder = siblings.length > 0 ? Math.max(...siblings.map(s => s.step_order)) + 1 : 1
    const newStep = await createStep(sequence.id, {
      type,
      step_order: nextOrder,
      message_template: null,
      subject: null,
      wait_days: type === 'wait' ? 1 : null,
      condition: type === 'react_post' ? { reaction: 'like' } : type === 'fork' ? { type: 'replied' } : type === 'wait' ? { wait_unit: 'days' } : null,
      parent_step_id: parentId,
      branch,
      ai_generation_mode: (['connect', 'message', 'inmail'].includes(type)) ? defaultAiMode : false,
    })
    // Immediately add to local state for instant render, then refresh parent cache
    setSteps(prev => [...prev, newStep])
    queryClient.invalidateQueries({ queryKey: ['sequences', campaignId] })
  }, [steps, sequence.id, queryClient, campaignId, defaultAiMode])

  const updateMutation = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<SequenceStep> }) => updateStep(id, updates),
    onSuccess: updated => {
      setSteps(prev => prev.map(s => s.id === updated.id ? updated : s))
      setEditingStep(null)
    },
  })

  const onDelete = useCallback(async (id: string) => {
    // Optimistically remove from local state for instant feedback
    setSteps(prev => prev.filter(s => s.id !== id && s.parent_step_id !== id))
    setEditingStep(null)
    await deleteStep(id)
    await invalidate()
    queryClient.invalidateQueries({ queryKey: ['sequences', campaignId] })
  }, [invalidate, queryClient, campaignId])

  async function handleGenerateAll() {
    setGenerating(true)
    setGenerateErr('')
    setShowGenConfirm(false)
    try {
      const result = await generateAllSteps(sequence.id)
      await invalidate()
      queryClient.invalidateQueries({ queryKey: ['sequences', campaignId] })
      if (result.errors && result.errors.length > 0) {
        setGenerateErr(`Generated ${result.updated} step(s). Some errors: ${result.errors.join('; ')}`)
      }
    } catch (err) {
      setGenerateErr(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }

  const cb: Callbacks = { onAdd }

  // Recompute layout whenever steps change
  useEffect(() => {
    const layout = buildLayout(steps, cb)
    setNodes(layout.nodes)
    setEdges(layout.edges)
    // Fit view after a tick to let nodes render
    setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 50)
  }, [steps])

  // Compute overlay positions for add buttons using the current viewport transform.
  // node.position is in canvas coords; multiply by zoom and add viewport offset to get pixel coords.
  const addOverlays = nodes
    .filter(n => n.type === 'addNode')
    .map(n => ({
      id: n.id,
      left: n.position.x * viewport.zoom + viewport.x,
      top:  n.position.y * viewport.zoom + viewport.y,
      onAdd: (n.data as { onAdd: (t: StepType) => void; disabledReasons?: DisabledEntry[] }).onAdd,
      disabledReasons: (n.data as { disabledReasons?: DisabledEntry[] }).disabledReasons ?? [],
    }))

  const warnings = validateSequence(steps)

  return (
    <div className="relative w-full h-full">
      {warnings.length > 0 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 w-full max-w-lg px-3 pointer-events-none">
          <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 shadow-md pointer-events-auto">
            <div className="flex items-start gap-2.5">
              <span className="text-amber-500 text-base shrink-0 mt-0.5">⚠️</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-amber-800 mb-1">Incomplete branches</p>
                <ul className="space-y-0.5">
                  {warnings.map((w, i) => (
                    <li key={i} className="text-xs text-amber-700">• {w}</li>
                  ))}
                </ul>
                <p className="text-[11px] text-amber-600 mt-1.5">
                  Add an <span className="font-semibold">⛔ End Sequence</span> step to each open branch.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        panOnScroll={true}
        panOnScrollSpeed={0.5}
        zoomOnScroll={false}
        zoomOnPinch={true}
        minZoom={0.2}
        maxZoom={1.5}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_evt, node) => {
          if (node.type === 'stepNode' || node.type === 'forkNode' || node.type === 'endNode') {
            setEditingStep((node.data as { step: SequenceStep }).step)
          }
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#E2E8F0" />
        <Controls showInteractive={false} className="!shadow-md !rounded-xl !border !border-gray-200 !overflow-hidden" />
      </ReactFlow>

      {/* Overlay buttons — outside React Flow's event tree, always clickable */}
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 5 }}>
        {addOverlays.map(({ id, left, top, onAdd, disabledReasons }) => (
          <div key={id} className="absolute pointer-events-auto"
            style={{ left, top, transform: `scale(${viewport.zoom})`, transformOrigin: 'top left' }}>
            <OverlayAddButton onAdd={onAdd} disabledReasons={disabledReasons} />
          </div>
        ))}
      </div>

      {/* Toolbar — top-right of canvas */}
      <div className="absolute top-3 right-3 pointer-events-auto flex gap-2" style={{ zIndex: 10 }}>
        <button
          onClick={() => setShowGenConfirm(true)}
          disabled={generating || steps.filter(s => ['connect','message','inmail'].includes(s.type)).length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 text-white text-xs font-medium rounded-lg shadow-sm hover:bg-violet-700 disabled:opacity-50 transition-colors"
        >
          {generating ? '⏳ Generating…' : '✨ Generate with AI'}
        </button>
        <button
          onClick={() => setShowTestModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-xs font-medium text-violet-700 border border-violet-200 rounded-lg shadow-sm hover:bg-violet-50 hover:border-violet-300 transition-colors"
        >
          🔍 Test Message
        </button>
        <button
          onClick={() => setShowTemplates(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-xs font-medium text-gray-700 border border-gray-200 rounded-lg shadow-sm hover:bg-gray-50 hover:border-gray-300 transition-colors"
        >
          <span>📋</span> Templates
        </button>
      </div>

      {/* Generate confirmation */}
      {showGenConfirm && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-20 pointer-events-auto">
          <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-base font-bold text-gray-900 mb-2">✨ Generate with AI</h3>
            <p className="text-sm text-gray-600 mb-4">
              AI will write message templates for all message steps in this sequence based on your product settings and lead profiles. Existing messages will be overwritten.
            </p>
            {generateErr && <p className="text-xs text-red-500 mb-3">{generateErr}</p>}
            <div className="flex gap-3">
              <button
                onClick={() => setShowGenConfirm(false)}
                className="flex-1 py-2 text-sm text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
              >Cancel</button>
              <button
                onClick={handleGenerateAll}
                className="flex-1 py-2 text-sm font-semibold text-white bg-violet-600 rounded-xl hover:bg-violet-700 transition-colors"
              >Generate All</button>
            </div>
          </div>
        </div>
      )}

      {generateErr && !showGenConfirm && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
          <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-4 py-2 rounded-xl shadow-md flex items-center gap-2">
            <span>{generateErr}</span>
            <button onClick={() => setGenerateErr('')} className="text-red-400 hover:text-red-600">✕</button>
          </div>
        </div>
      )}

      {editingStep && (
        <EditModal
          step={editingStep}
          sequenceId={sequence.id}
          onSave={updates => updateMutation.mutate({ id: editingStep.id, updates })}
          onDelete={onDelete}
          onClose={() => setEditingStep(null)}
          onTest={step => { setEditingStep(null); setTestingStep(step) }}
        />
      )}

      {testingStep && (
        <TestMessageModal
          initialStep={testingStep}
          allSteps={steps}
          sequenceId={sequence.id}
          campaignId={campaignId}
          campaignApproach={(campaignData?.icp_config as Record<string,unknown>)?.message_approach as string | undefined}
          campaignTone={(campaignData?.icp_config as Record<string,unknown>)?.message_tone as string | undefined}
          onClose={() => setTestingStep(null)}
        />
      )}

      {showTestModal && (
        <TestMessageModal
          allSteps={steps}
          sequenceId={sequence.id}
          campaignId={campaignId}
          campaignApproach={(campaignData?.icp_config as Record<string,unknown>)?.message_approach as string | undefined}
          campaignTone={(campaignData?.icp_config as Record<string,unknown>)?.message_tone as string | undefined}
          onClose={() => setShowTestModal(false)}
        />
      )}

      {showTemplates && (
        <TemplatesModal
          sequence={sequence}
          currentSteps={steps}
          onClose={() => setShowTemplates(false)}
          onApplied={async () => {
            setShowTemplates(false)
            await invalidate()
            queryClient.invalidateQueries({ queryKey: ['sequences', campaignId] })
          }}
        />
      )}
    </div>
  )
}

// ── Templates Modal ───────────────────────────────────────────────────────────

const STEP_TYPE_ICON: Record<StepType, string> = {
  connect:      '🔗',
  message:      '💬',
  inmail:       '⭐',
  wait:         '⏳',
  view_profile: '👁️',
  react_post:   '❤️',
  follow:       '➕',
  fork:         '🔀',
  end:          '⛔',
}

function TemplateStepPills({ steps }: { steps: TemplateStep[] }) {
  const mainSteps = steps.filter(s => s.parent_index === null)
  const hasFork   = steps.some(s => s.type === 'fork')
  const yesBranch = steps.filter(s => s.branch === 'if_yes')
  const noBranch  = steps.filter(s => s.branch === 'if_no')

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {mainSteps.map((s, i) => (
          <span key={i} className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
            {STEP_TYPE_ICON[s.type]}
            {s.type === 'wait'
              ? `${s.wait_days ?? 1} ${(s.condition?.wait_unit as string) ?? 'days'}`
              : s.type.replace('_', ' ')}
          </span>
        ))}
      </div>
      {hasFork && (yesBranch.length > 0 || noBranch.length > 0) && (
        <div className="flex gap-3 pl-2 border-l-2 border-indigo-200">
          {yesBranch.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="text-[10px] font-bold text-green-600 self-center">YES →</span>
              {yesBranch.map((s, i) => (
                <span key={i} className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-green-50 text-green-700">
                  {STEP_TYPE_ICON[s.type]}
                </span>
              ))}
            </div>
          )}
          {noBranch.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="text-[10px] font-bold text-red-500 self-center">NO →</span>
              {noBranch.map((s, i) => (
                <span key={i} className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-red-50 text-red-700">
                  {STEP_TYPE_ICON[s.type]}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TemplatesModal({
  sequence,
  currentSteps,
  onClose,
  onApplied,
}: {
  sequence: Sequence
  currentSteps: SequenceStep[]
  onClose: () => void
  onApplied: () => void
}) {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'browse' | 'saved'>('browse')
  const [applying, setApplying] = useState<string | null>(null)
  const [showSaveForm, setShowSaveForm] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveDesc, setSaveDesc] = useState('')

  const { data: userTemplates = [], isLoading: loadingUserTemplates, refetch } = useQuery({
    queryKey: ['templates'],
    queryFn: fetchUserTemplates,
    enabled: tab === 'saved',
  })

  const deleteMutation = useMutation({
    mutationFn: deleteUserTemplate,
    onSuccess: () => refetch(),
  })

  const saveMutation = useMutation({
    mutationFn: () => {
      // Convert current steps to template steps
      const stepToIndex = new Map(currentSteps.map((s, idx) => [s.id, idx]))
      const templateSteps: TemplateStep[] = currentSteps.map((s) => ({
        type: s.type,
        step_order: s.step_order,
        branch: s.branch,
        parent_index: s.parent_step_id != null ? (stepToIndex.get(s.parent_step_id) ?? null) : null,
        message_template: s.message_template,
        subject: s.subject,
        wait_days: s.wait_days,
        condition: s.condition,
      }))
      return saveTemplate(saveName.trim(), saveDesc.trim(), templateSteps)
    },
    onSuccess: () => {
      setShowSaveForm(false)
      setSaveName('')
      setSaveDesc('')
      void queryClient.invalidateQueries({ queryKey: ['templates'] })
      void refetch()
      setTab('saved')
    },
  })

  async function applyTemplate(steps: TemplateStep[]) {
    const templateId = steps[0]?.type ?? 'template'
    setApplying(templateId)
    try {
      // 1. Clear existing steps
      await clearSteps(sequence.id)
      // 2. Create steps in order, tracking parent UUID by array index
      const createdIds: string[] = []
      for (const tStep of steps) {
        const parentId = tStep.parent_index != null ? (createdIds[tStep.parent_index] ?? null) : null
        const created = await createStep(sequence.id, {
          type: tStep.type,
          step_order: tStep.step_order,
          branch: tStep.branch,
          parent_step_id: parentId,
          message_template: tStep.message_template ?? null,
          subject: tStep.subject ?? null,
          wait_days: tStep.wait_days ?? null,
          condition: tStep.condition ?? null,
          ai_generation_mode: false,
        })
        createdIds.push(created.id)
      }
      onApplied()
    } finally {
      setApplying(null)
    }
  }

  const allPresets = PRESET_TEMPLATES

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-100">
          <span className="text-xl">📋</span>
          <h2 className="text-base font-bold text-gray-900">Sequence Templates</h2>
          <div className="flex gap-1 ml-4">
            {(['browse', 'saved'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={[
                  'px-3 py-1 text-xs font-medium rounded-lg transition-colors capitalize',
                  tab === t ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-100',
                ].join(' ')}>
                {t === 'browse' ? 'Pre-defined' : 'My Templates'}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-600 transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {tab === 'browse' && allPresets.map(tmpl => (
            <TemplateCard
              key={tmpl.id}
              name={tmpl.name}
              description={tmpl.description}
              steps={tmpl.steps}
              isApplying={applying === tmpl.steps[0]?.type}
              onApply={() => applyTemplate(tmpl.steps)}
            />
          ))}

          {tab === 'saved' && (
            <>
              {loadingUserTemplates ? (
                <div className="py-8 text-center text-sm text-gray-400">Loading…</div>
              ) : userTemplates.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="text-gray-600 font-medium text-sm">No saved templates yet</p>
                  <p className="text-gray-400 text-xs mt-1">Save your current sequence as a template to reuse it later.</p>
                </div>
              ) : (
                userTemplates.map(tmpl => (
                  <TemplateCard
                    key={tmpl.id}
                    name={tmpl.name}
                    description={tmpl.description ?? ''}
                    steps={tmpl.steps_json}
                    isApplying={applying === tmpl.id}
                    onApply={() => applyTemplate(tmpl.steps_json)}
                    onDelete={() => deleteMutation.mutate(tmpl.id)}
                    isDeleting={deleteMutation.isPending}
                  />
                ))
              )}
            </>
          )}
        </div>

        {/* Footer — save current */}
        <div className="border-t border-gray-100 p-4">
          {currentSteps.length === 0 ? (
            <p className="text-xs text-gray-400 text-center">Add steps to your sequence to save it as a template.</p>
          ) : showSaveForm ? (
            <div className="space-y-2">
              <input
                type="text"
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                placeholder="Template name…"
                autoFocus
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="text"
                value={saveDesc}
                onChange={e => setSaveDesc(e.target.value)}
                placeholder="Short description (optional)"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex gap-2">
                <button onClick={() => setShowSaveForm(false)}
                  className="flex-1 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
                <button
                  onClick={() => saveMutation.mutate()}
                  disabled={!saveName.trim() || saveMutation.isPending}
                  className="flex-1 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {saveMutation.isPending ? 'Saving…' : 'Save Template'}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowSaveForm(true)}
              className="w-full py-2 text-sm font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
            >
              💾 Save Current Sequence as Template
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function TemplateCard({
  name, description, steps, isApplying, onApply, onDelete, isDeleting,
}: {
  name: string
  description: string
  steps: TemplateStep[]
  isApplying: boolean
  onApply: () => void
  onDelete?: () => void
  isDeleting?: boolean
}) {
  return (
    <div className="border border-gray-200 rounded-xl p-4 hover:border-blue-200 transition-colors group">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900">{name}</p>
          <p className="text-xs text-gray-500 mt-0.5">{description}</p>
          <div className="mt-2.5">
            <TemplateStepPills steps={steps} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5 shrink-0">
          <button
            onClick={onApply}
            disabled={isApplying}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap"
          >
            {isApplying ? 'Applying…' : 'Use Template'}
          </button>
          {onDelete && (
            <button
              onClick={onDelete}
              disabled={isDeleting}
              className="px-3 py-1.5 text-xs text-red-500 hover:text-red-700 hover:underline disabled:opacity-50 transition-colors text-center"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Campaign Leads Tab ────────────────────────────────────────────────────────

const CL_STATUS_COLORS: Record<CampaignLead['status'], string> = {
  pending:          'bg-gray-100 text-gray-600',
  connection_sent:  'bg-blue-100 text-blue-700',
  connected:        'bg-indigo-100 text-indigo-700',
  messaged:         'bg-purple-100 text-purple-700',
  replied:          'bg-green-100 text-green-700',
  converted:        'bg-emerald-100 text-emerald-700',
  stopped:          'bg-red-100 text-red-700',
}

const CL_STATUS_LABEL: Record<CampaignLead['status'], string> = {
  pending:          'Pending',
  connection_sent:  'Conn. Sent',
  connected:        'Connected',
  messaged:         'Messaged',
  replied:          'Replied',
  converted:        'Converted',
  stopped:          'Stopped',
}

const ICP_BADGE: Record<NonNullable<Lead['icp_flag']>, { bg: string; label: string }> = {
  hot:          { bg: 'bg-red-100 text-red-700',    label: '🔥 Hot' },
  warm:         { bg: 'bg-yellow-100 text-yellow-700', label: '☀️ Warm' },
  cold:         { bg: 'bg-blue-100 text-blue-700',  label: '❄️ Cold' },
  disqualified: { bg: 'bg-gray-100 text-gray-500',  label: '✗ DQ' },
}

function CampaignLeadsTab({ campaignId }: { campaignId: string }) {
  const queryClient = useQueryClient()
  const [showAddModal, setShowAddModal] = useState(false)

  const { data: campaignLeads = [], isLoading } = useQuery({
    queryKey: ['campaign-leads', campaignId],
    queryFn: () => fetchCampaignLeads(campaignId),
  })

  const removeMutation = useMutation({
    mutationFn: (clId: string) => removeCampaignLead(campaignId, clId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['campaign-leads', campaignId] }),
  })

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">
          {campaignLeads.length} lead{campaignLeads.length !== 1 ? 's' : ''} in this campaign
        </p>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          + Add Leads
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="py-12 text-center text-sm text-gray-400">Loading…</div>
        ) : campaignLeads.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-gray-900 font-medium">No leads yet</p>
            <p className="mt-1 text-sm text-gray-500">Add leads from your leads pool to start the sequence.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs font-medium text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3">Lead</th>
                <th className="text-left px-4 py-3 hidden md:table-cell">Company</th>
                <th className="text-left px-4 py-3 hidden lg:table-cell">ICP</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3 hidden md:table-cell">Step</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {campaignLeads.map(cl => (
                <tr key={cl.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <a
                      href={cl.lead.linkedin_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-gray-900 hover:text-blue-600 transition-colors"
                      onClick={e => e.stopPropagation()}
                    >
                      {cl.lead.first_name} {cl.lead.last_name}
                    </a>
                    {cl.lead.title && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate max-w-[180px]">{cl.lead.title}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-gray-600 max-w-[140px] truncate">
                    {cl.lead.company ?? '—'}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    {cl.lead.icp_flag ? (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${ICP_BADGE[cl.lead.icp_flag].bg}`}>
                        {ICP_BADGE[cl.lead.icp_flag].label}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${CL_STATUS_COLORS[cl.status]}`}>
                      {CL_STATUS_LABEL[cl.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-gray-500 text-xs">
                    Step {cl.current_step}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => removeMutation.mutate(cl.id)}
                      disabled={removeMutation.isPending}
                      className="text-xs text-red-500 hover:text-red-700 hover:underline disabled:opacity-50 transition-colors"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAddModal && (
        <AddLeadsModal
          campaignId={campaignId}
          existingLeadIds={campaignLeads.map(cl => cl.lead.id)}
          onClose={() => setShowAddModal(false)}
          onAdded={() => {
            void queryClient.invalidateQueries({ queryKey: ['campaign-leads', campaignId] })
            setShowAddModal(false)
          }}
        />
      )}
    </div>
  )
}

function AddLeadsModal({
  campaignId,
  existingLeadIds,
  onClose,
  onAdded,
}: {
  campaignId: string
  existingLeadIds: string[]
  onClose: () => void
  onAdded: () => void
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [accountId, setAccountId] = useState('')

  const { data: allLeads = [], isLoading } = useQuery({
    queryKey: ['leads'],
    queryFn: () => fetchLeads(),
  })

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => {
      const { data } = await supabase
        .from('linkedin_accounts')
        .select('id, linkedin_email, status')
        .in('status', ['active', 'warming_up'])
      return (data ?? []) as { id: string; linkedin_email: string; status: string }[]
    },
  })

  // Pre-fill from campaign's default account
  const { data: campaignDetail } = useQuery({
    queryKey: ['campaign-detail', campaignId],
    queryFn: () => fetchCampaign(campaignId),
  })
  useEffect(() => {
    if (campaignDetail && !accountId) {
      const icp = campaignDetail.icp_config as { default_account_id?: string }
      if (icp.default_account_id) setAccountId(icp.default_account_id)
    }
  }, [campaignDetail])

  const available = allLeads.filter(l =>
    !existingLeadIds.includes(l.id) &&
    (search === '' ||
      `${l.first_name} ${l.last_name} ${l.company ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  )

  const assignMutation = useMutation({
    mutationFn: () => assignLeads(campaignId, Array.from(selected), accountId || undefined),
    onSuccess: onAdded,
  })

  const toggle = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[80vh]">
        <div className="p-5 border-b border-gray-100 space-y-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Add Leads to Campaign</h2>
            <p className="text-xs text-gray-500 mt-0.5">Select leads from your pool to add to this campaign.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">LinkedIn Account</label>
            <select
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— select account —</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.linkedin_email} ({a.status})</option>
              ))}
            </select>
          </div>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search leads…"
            autoFocus
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="py-10 text-center text-sm text-gray-400">Loading…</div>
          ) : available.length === 0 ? (
            <div className="py-10 text-center text-sm text-gray-400">
              {allLeads.length === 0 ? 'No leads in your pool yet.' : 'No leads match your search.'}
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {available.map(l => (
                <label key={l.id} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(l.id)}
                    onChange={() => toggle(l.id)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">
                      {l.first_name} {l.last_name}
                    </p>
                    <p className="text-xs text-gray-400 truncate">
                      {[l.title, l.company].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  {l.icp_flag && (
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${ICP_BADGE[l.icp_flag].bg}`}>
                      {ICP_BADGE[l.icp_flag].label}
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-100 flex items-center justify-between">
          <p className="text-xs text-gray-500">{selected.size} selected</p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => assignMutation.mutate()}
              disabled={selected.size === 0 || assignMutation.isPending}
              className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {assignMutation.isPending ? 'Adding…' : `Add ${selected.size > 0 ? selected.size : ''} Lead${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Analytics Tab ────────────────────────────────────────────────────────────

interface LeadCounts {
  total: number
  pending: number
  connection_sent: number
  connected: number
  messaged: number
  replied: number
  converted: number
  stopped: number
}

function pct(n: number, total: number): string {
  if (total === 0) return '—'
  return `${Math.round((n / total) * 100)}%`
}

function AnalyticsTab({ campaignId }: { campaignId: string }) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['campaign-analytics', campaignId],
    queryFn: async () => {
      const { data } = await supabase
        .from('campaign_leads')
        .select('status')
        .eq('campaign_id', campaignId)
      return (data ?? []) as { status: string }[]
    },
  })

  const counts: LeadCounts = {
    total: rows.length,
    pending: 0,
    connection_sent: 0,
    connected: 0,
    messaged: 0,
    replied: 0,
    converted: 0,
    stopped: 0,
  }
  for (const r of rows) {
    const s = r.status as keyof LeadCounts
    if (s in counts) counts[s]++
  }

  const funnel = [
    {
      label: 'Total Leads',
      value: counts.total,
      pct: '100%',
      color: 'bg-gray-200',
      bar: 100,
    },
    {
      label: 'Connection Sent',
      value: counts.connection_sent + counts.connected + counts.messaged + counts.replied + counts.converted,
      pct: pct(counts.connection_sent + counts.connected + counts.messaged + counts.replied + counts.converted, counts.total),
      color: 'bg-blue-400',
      bar: counts.total ? Math.round(((counts.connection_sent + counts.connected + counts.messaged + counts.replied + counts.converted) / counts.total) * 100) : 0,
    },
    {
      label: 'Connected',
      value: counts.connected + counts.messaged + counts.replied + counts.converted,
      pct: pct(counts.connected + counts.messaged + counts.replied + counts.converted, counts.total),
      color: 'bg-indigo-400',
      bar: counts.total ? Math.round(((counts.connected + counts.messaged + counts.replied + counts.converted) / counts.total) * 100) : 0,
    },
    {
      label: 'Messaged',
      value: counts.messaged + counts.replied + counts.converted,
      pct: pct(counts.messaged + counts.replied + counts.converted, counts.total),
      color: 'bg-green-400',
      bar: counts.total ? Math.round(((counts.messaged + counts.replied + counts.converted) / counts.total) * 100) : 0,
    },
    {
      label: 'Replied',
      value: counts.replied + counts.converted,
      pct: pct(counts.replied + counts.converted, counts.total),
      color: 'bg-emerald-500',
      bar: counts.total ? Math.round(((counts.replied + counts.converted) / counts.total) * 100) : 0,
    },
    {
      label: 'Converted',
      value: counts.converted,
      pct: pct(counts.converted, counts.total),
      color: 'bg-yellow-400',
      bar: counts.total ? Math.round((counts.converted / counts.total) * 100) : 0,
    },
  ]

  const statCards = [
    { label: 'Total Leads',       value: counts.total },
    { label: 'Pending',           value: counts.pending },
    { label: 'Stopped / Ended',   value: counts.stopped },
    { label: 'Reply Rate',
      value: counts.total ? `${Math.round(((counts.replied + counts.converted) / counts.total) * 100)}%` : '—' },
  ]

  return (
    <div className="flex-1 overflow-y-auto p-8 space-y-8">
      {isLoading ? (
        <div className="text-center text-sm text-gray-400 py-16">Loading…</div>
      ) : counts.total === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-900 font-medium">No leads in this campaign yet</p>
          <p className="mt-1 text-sm text-gray-500">Add leads from the Leads tab to start seeing analytics.</p>
        </div>
      ) : (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {statCards.map(({ label, value }) => (
              <div key={label} className="bg-white rounded-xl border border-gray-200 p-5">
                <p className="text-xs font-medium text-gray-500">{label}</p>
                <p className="mt-2 text-3xl font-bold text-gray-900">{value}</p>
              </div>
            ))}
          </div>

          {/* Funnel */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-5">Outreach Funnel</h2>
            <div className="space-y-4">
              {funnel.map(step => (
                <div key={step.label}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm text-gray-700">{step.label}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-semibold text-gray-900">{step.value}</span>
                      <span className="text-xs text-gray-400 w-10 text-right">{step.pct}</span>
                    </div>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-2 rounded-full transition-all ${step.color}`}
                      style={{ width: `${step.bar}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Settings Tab ──────────────────────────────────────────────────────────────

const CAMPAIGN_STATUSES: Campaign['status'][] = ['draft', 'active', 'paused', 'completed']
const STATUS_LABELS: Record<Campaign['status'], string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
}

interface SettingsProduct {
  id: string
  name: string
  one_liner?: string
  description?: string
  tone_of_voice?: string
}

function SettingsTab({ campaignId }: { campaignId: string }) {
  const queryClient = useQueryClient()

  const { data: campaign, isLoading } = useQuery({
    queryKey: ['campaign-detail', campaignId],
    queryFn: () => fetchCampaign(campaignId),
  })

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => {
      const { data } = await supabase.from('linkedin_accounts').select('id, linkedin_email, status')
      return (data ?? []) as { id: string; linkedin_email: string; status: string }[]
    },
  })

  const { data: userSettings } = useQuery({
    queryKey: ['user-settings'],
    queryFn: async () => {
      const { data } = await supabase.from('user_settings').select('icp_config').single()
      return data as { icp_config: { products_services?: SettingsProduct[] } } | null
    },
  })
  const products: SettingsProduct[] = userSettings?.icp_config?.products_services ?? []

  const [name, setName] = useState('')
  const [status, setStatus] = useState<Campaign['status']>('draft')
  const [connLimit, setConnLimit] = useState(25)
  const [msgLimit, setMsgLimit] = useState(100)
  const [icpRoles, setIcpRoles] = useState('')
  const [icpIndustries, setIcpIndustries] = useState('')
  const [icpSeniority, setIcpSeniority] = useState('')
  const [icpKeywords, setIcpKeywords] = useState('')
  const [defaultAccountId, setDefaultAccountId] = useState('')
  const [productId, setProductId] = useState<string>('')
  const [messageApproach, setMessageApproach] = useState<string>('')
  const [messageTone, setMessageTone] = useState<string>('')
  const [saved, setSaved] = useState(false)
  const initialized = useRef(false)

  useEffect(() => {
    if (campaign && !initialized.current) {
      initialized.current = true
      setName(campaign.name)
      setStatus(campaign.status)
      setConnLimit(campaign.daily_connection_limit)
      setMsgLimit(campaign.daily_message_limit)
      const icp = campaign.icp_config as {
        target_roles?: string
        target_industries?: string
        seniority_levels?: string
        keywords?: string
        default_account_id?: string
        message_approach?: string
        message_tone?: string
      }
      setIcpRoles(icp.target_roles ?? '')
      setIcpIndustries(icp.target_industries ?? '')
      setIcpSeniority(icp.seniority_levels ?? '')
      setIcpKeywords(icp.keywords ?? '')
      setDefaultAccountId(icp.default_account_id ?? '')
      setProductId(campaign.product_id ?? '')
      setMessageApproach(icp.message_approach ?? '')
      setMessageTone(icp.message_tone ?? '')
    }
  }, [campaign])

  const saveMutation = useMutation({
    mutationFn: () => updateCampaign(campaignId, {
      name: name.trim() || campaign?.name,
      status,
      daily_connection_limit: connLimit,
      daily_message_limit: msgLimit,
      product_id: productId || null,
      message_approach: messageApproach || null,
      message_tone: messageTone || null,
      icp_config: {
        target_roles: icpRoles,
        target_industries: icpIndustries,
        seniority_levels: icpSeniority,
        keywords: icpKeywords,
        default_account_id: defaultAccountId || undefined,
      },
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaign-detail', campaignId] })
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  if (isLoading) {
    return <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Loading…</div>
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl space-y-6">

        {/* Basic info */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-900">Campaign Details</h3>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Campaign Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Status</label>
            <div className="flex gap-2 flex-wrap">
              {CAMPAIGN_STATUSES.map(s => (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  className={[
                    'px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
                    status === s
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'text-gray-600 border-gray-200 hover:bg-gray-50',
                  ].join(' ')}
                >
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
            {status === 'active' && (
              <p className="mt-2 text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">
                Setting to Active will start running the sequence for all pending leads.
              </p>
            )}
          </div>
        </div>

        {/* Daily limits */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-900">Daily Limits</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Connection requests / day
                <span className="ml-1 text-gray-400 font-normal">(max 25)</span>
              </label>
              <input
                type="number"
                min={1}
                max={25}
                value={connLimit}
                onChange={e => setConnLimit(Math.min(25, Math.max(1, Number(e.target.value))))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Messages / day
                <span className="ml-1 text-gray-400 font-normal">(max 100)</span>
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={msgLimit}
                onChange={e => setMsgLimit(Math.min(100, Math.max(1, Number(e.target.value))))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Default Account */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">LinkedIn Account</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Default account used when adding leads to this campaign.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Account</label>
            <select
              value={defaultAccountId}
              onChange={e => setDefaultAccountId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— select an account —</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.linkedin_email} ({a.status})
                </option>
              ))}
            </select>
            {accounts.length === 0 && (
              <p className="mt-1.5 text-xs text-amber-600">No accounts added yet — add one under Accounts.</p>
            )}
          </div>
        </div>

        {/* Product / AI */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">AI Product Context</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Select the product or service to use when generating sequence messages with AI.
            </p>
          </div>
          {products.length === 0 ? (
            <p className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">
              No products defined yet. Go to <strong>Settings → Products & Services</strong> to add one, then return here to select it.
            </p>
          ) : (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">Product / Service</label>
              <select
                value={productId}
                onChange={e => setProductId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
              >
                <option value="">— no product selected —</option>
                {products.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {productId && (() => {
                const p = products.find(x => x.id === productId)
                if (!p) return null
                return (
                  <div className="mt-3 p-3 bg-violet-50 border border-violet-100 rounded-xl space-y-1">
                    {p.one_liner && <p className="text-xs text-violet-800 font-medium">{p.one_liner}</p>}
                    {p.tone_of_voice && (
                      <p className="text-[10px] text-violet-500 capitalize">Tone: {p.tone_of_voice}</p>
                    )}
                    <p className="text-[10px] text-violet-400">
                      AI will use this product context when generating sequence messages.
                    </p>
                  </div>
                )
              })()}
            </div>
          )}
        </div>

        {/* Outreach Style */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Outreach Style</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              The AI will use these settings to shape the strategic angle and tone of every message.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Approach</label>
            <select
              value={messageApproach}
              onChange={e => setMessageApproach(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
            >
              <option value="">— no approach selected —</option>
              <option value="pain_based">🩹 Pain-based — address a problem they face</option>
              <option value="value_first">💡 Value-first — lead with the outcome/benefit</option>
              <option value="curiosity">❓ Curiosity — hook with an open question or gap</option>
              <option value="social_proof">🏆 Social proof — reference similar results</option>
              <option value="direct">🎯 Direct ask — straight to the point</option>
              <option value="consultative">🤝 Consultative — ask questions, advisory tone</option>
              <option value="hyper_personalised">🔍 Hyper-personalised — reference their profile/posts</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Tone</label>
            <select
              value={messageTone}
              onChange={e => setMessageTone(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
            >
              <option value="">— no tone selected —</option>
              <option value="professional">🏢 Professional</option>
              <option value="conversational">💬 Conversational</option>
              <option value="bold">⚡ Bold</option>
              <option value="empathetic">🤗 Empathetic</option>
              <option value="witty">😄 Witty</option>
            </select>
          </div>
        </div>

        {/* ICP Config */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">ICP Configuration</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Claude AI uses this to score and qualify leads for this campaign.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Target Roles</label>
            <input
              type="text"
              value={icpRoles}
              onChange={e => setIcpRoles(e.target.value)}
              placeholder="e.g. VP of Sales, Head of Growth, Founder"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Target Industries</label>
            <input
              type="text"
              value={icpIndustries}
              onChange={e => setIcpIndustries(e.target.value)}
              placeholder="e.g. SaaS, Fintech, B2B Software"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Seniority Levels</label>
            <input
              type="text"
              value={icpSeniority}
              onChange={e => setIcpSeniority(e.target.value)}
              placeholder="e.g. C-Level, VP, Director, Manager"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">
              Keywords to match
            </label>
            <input
              type="text"
              value={icpKeywords}
              onChange={e => setIcpKeywords(e.target.value)}
              placeholder="e.g. outreach, pipeline, revenue, growth"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <p className="text-xs text-gray-400 bg-gray-50 px-3 py-2 rounded-lg">
            💡 Claude AI will score each lead 0–100 and flag them hot/warm/cold/disqualified based on how well they match this ICP.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="px-5 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-60 transition-colors"
          >
            {saveMutation.isPending ? 'Saving…' : 'Save Settings'}
          </button>
          {saved && (
            <span className="text-sm text-green-600 font-medium">✓ Saved</span>
          )}
          {saveMutation.error && (
            <span className="text-sm text-red-600">{saveMutation.error.message}</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Tab = 'sequence' | 'leads' | 'analytics' | 'settings'

export function SequenceBuilder() {
  const { id: campaignId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [campaignName, setCampaignName] = useState('')
  const [tab, setTab] = useState<Tab>('sequence')

  useQuery({
    queryKey: ['campaign', campaignId],
    queryFn: async () => {
      const { data } = await supabase.from('campaigns').select('name').eq('id', campaignId!).single()
      if (data) setCampaignName((data as { name: string }).name)
      return data
    },
    enabled: !!campaignId,
  })

  const { data: sequences = [], isLoading } = useQuery({
    queryKey: ['sequences', campaignId],
    queryFn: () => fetchSequences(campaignId!),
    enabled: !!campaignId,
  })

  const createSeqMutation = useMutation({
    mutationFn: () => createSequence(campaignId!, 'Main Sequence'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sequences', campaignId] }),
  })

  const sequence = sequences[0]
  const stepCount = sequence?.sequence_steps.length ?? 0

  const TABS: { key: Tab; label: string }[] = [
    { key: 'sequence',  label: 'Sequence' },
    { key: 'leads',     label: 'Leads' },
    { key: 'analytics', label: 'Analytics' },
    { key: 'settings',  label: 'Settings' },
  ]

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-gray-200 bg-white px-6 py-0 flex items-stretch gap-4">
        <button
          onClick={() => navigate('/campaigns')}
          className="self-center p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors shrink-0"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>

        <div className="self-center py-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Campaign</p>
          <h1 className="text-base font-bold text-gray-900 leading-tight">{campaignName || '…'}</h1>
        </div>

        {/* Tabs */}
        <div className="flex items-end gap-1 ml-6 pl-6 border-l border-gray-200">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={[
                'px-4 py-3 text-sm font-medium border-b-2 transition-colors',
                tab === t.key
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'sequence' && sequence && (
          <span className="ml-auto self-center text-xs font-semibold text-gray-500 bg-gray-100 px-3 py-1.5 rounded-full">
            {stepCount} step{stepCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Tab content */}
      {tab === 'sequence' && (
        <div className="flex-1 relative" style={{ background: '#F8FAFC' }}>
          {isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">Loading…</div>
          ) : !sequence ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <div className="text-center">
                <p className="text-gray-900 font-semibold text-base">No sequence yet</p>
                <p className="mt-1 text-sm text-gray-500">Create a sequence to start building your outreach flow.</p>
              </div>
              <button
                onClick={() => createSeqMutation.mutate()}
                disabled={createSeqMutation.isPending}
                className="px-5 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-60 transition-colors shadow-md"
              >
                {createSeqMutation.isPending ? 'Creating…' : 'Create Sequence'}
              </button>
            </div>
          ) : (
            <ReactFlowProvider>
              <FlowCanvas sequence={sequence} campaignId={campaignId!} />
            </ReactFlowProvider>
          )}
        </div>
      )}

      {tab === 'leads' && <CampaignLeadsTab campaignId={campaignId!} />}

      {tab === 'analytics' && <AnalyticsTab campaignId={campaignId!} />}

      {tab === 'settings' && <SettingsTab campaignId={campaignId!} />}
    </div>
  )
}
