/**
 * ChatSequenceBuilder — AI chat panel for generating LinkedIn sequences.
 *
 * Slides in from the right of the SequenceBuilder canvas.
 * User describes what they want; Claude responds conversationally and
 * optionally proposes a full step list. One click applies it.
 */

import { useState, useRef, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  chatSequence,
  type ChatMessage,
  type GeneratedStep,
} from '../api/campaigns'
import { clearSteps, createStep, type StepType, type Branch } from '../api/sequences'

// ── Step type metadata (matches SequenceBuilder) ─────────────────────────────
const STEP_META: Record<string, { icon: string; label: string; color: string }> = {
  view_profile: { icon: '👁️',  label: 'View Profile',   color: '#3B82F6' },
  follow:       { icon: '➕',  label: 'Follow',          color: '#8B5CF6' },
  connect:      { icon: '🤝',  label: 'Connect',         color: '#10B981' },
  message:      { icon: '💬',  label: 'Message',         color: '#F59E0B' },
  inmail:       { icon: '📧',  label: 'InMail',          color: '#6366F1' },
  react_post:   { icon: '❤️',  label: 'React to Post',  color: '#EC4899' },
  wait:         { icon: '⏳',  label: 'Wait',            color: '#9CA3AF' },
  fork:         { icon: '🔀',  label: 'Fork',            color: '#4F46E5' },
  end:          { icon: '🏁',  label: 'End',             color: '#6B7280' },
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StepPill({ step }: { step: GeneratedStep }) {
  const meta = STEP_META[step.type] ?? { icon: '•', label: step.type, color: '#9CA3AF' }
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-xs">
      <span>{meta.icon}</span>
      <span className="font-semibold text-gray-800">{meta.label}</span>
      {step.wait_days != null && (
        <span className="text-gray-400">
          {step.wait_days < 1
            ? `${Math.round(step.wait_days * 24)}h`
            : `${step.wait_days}d`}
        </span>
      )}
      {step.message_template && (
        <span className="text-gray-400 max-w-[140px] truncate">
          "{step.message_template.substring(0, 40)}{step.message_template.length > 40 ? '…' : ''}"
        </span>
      )}
    </div>
  )
}

function TypingIndicator() {
  return (
    <div className="flex items-end gap-2 py-1">
      <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold shrink-0">AI</div>
      <div className="flex items-center gap-1 px-3 py-2 bg-white border border-gray-200 rounded-2xl rounded-bl-sm">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
    </div>
  )
}

interface Message extends ChatMessage {
  steps?: GeneratedStep[] | null
  isError?: boolean
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  campaignId: string
  sequenceId: string | null
  onClose: () => void
  onApplied: () => void
}

export function ChatSequenceBuilder({ campaignId, sequenceId, onClose, onApplied }: Props) {
  const queryClient = useQueryClient()
  const [messages, setMessages]     = useState<Message[]>([])
  const [input, setInput]           = useState('')
  const [isLoading, setIsLoading]   = useState(false)
  const [pendingSteps, setPendingSteps] = useState<GeneratedStep[] | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)

  // Scroll to bottom whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  // Focus input on mount
  useEffect(() => { inputRef.current?.focus() }, [])

  // Apply generated steps to the sequence
  const applyMutation = useMutation({
    mutationFn: async (steps: GeneratedStep[]) => {
      if (!sequenceId) throw new Error('No sequence found. Create a sequence first.')
      await clearSteps(sequenceId)

      // Map step_order → real DB UUID so branch steps can reference their parent fork
      const idByOrder = new Map<number, string>()
      // Also track fork UUIDs by step_order for auto-wiring if_yes/if_no steps
      const forkIdByOrder = new Map<number, string>()

      for (const step of steps) {
        // Resolve parent_step_id:
        // 1. AI may pass a step_order integer as parent_step_id — resolve to DB UUID
        // 2. branch steps (if_yes / if_no) with no parent → find the nearest fork above them
        let resolvedParentId: string | null = null

        if (typeof step.parent_step_id === 'number') {
          resolvedParentId = idByOrder.get(step.parent_step_id as number) ?? null
        } else if (step.parent_step_id) {
          resolvedParentId = step.parent_step_id
        } else if (step.branch === 'if_yes' || step.branch === 'if_no') {
          // Auto-wire: find the highest fork step_order below this step's order
          let bestForkOrder = -1
          for (const [order] of forkIdByOrder) {
            if (order < step.step_order && order > bestForkOrder) bestForkOrder = order
          }
          if (bestForkOrder >= 0) resolvedParentId = forkIdByOrder.get(bestForkOrder) ?? null
        }

        const created = await createStep(sequenceId, {
          type:               step.type as StepType,
          branch:             (step.branch ?? 'main') as Branch,
          step_order:         step.step_order,
          message_template:   step.message_template,
          subject:            step.subject,
          wait_days:          step.wait_days != null ? Math.max(1, Math.round(step.wait_days)) : null,
          ai_generation_mode: step.ai_generation_mode ?? false,
          condition:          step.condition ?? null,
          parent_step_id:     resolvedParentId,
        })

        idByOrder.set(step.step_order, created.id)
        if (step.type === 'fork') forkIdByOrder.set(step.step_order, created.id)
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sequences', campaignId] })
      setPendingSteps(null)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '✅ Sequence applied! You can see it in the canvas. Feel free to click any step to edit the messages.',
      }])
      onApplied()
    },
    onError: (err: Error) => {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `❌ Failed to apply: ${err.message}`,
        isError: true,
      }])
    },
  })

  async function handleSend() {
    const text = input.trim()
    if (!text || isLoading) return

    const userMsg: Message = { role: 'user', content: text }
    const history = [...messages, userMsg]
    setMessages(history)
    setInput('')
    setIsLoading(true)

    try {
      // Only send role+content to the API (strip UI-only fields)
      const apiMessages: ChatMessage[] = history.map(m => ({ role: m.role, content: m.content }))
      const result = await chatSequence(campaignId, sequenceId, apiMessages)

      const assistantMsg: Message = {
        role:    'assistant',
        content: result.reply,
        steps:   result.steps,
      }
      setMessages(prev => [...prev, assistantMsg])

      if (result.steps?.length) {
        setPendingSteps(result.steps)
      }
    } catch (err) {
      setMessages(prev => [...prev, {
        role:    'assistant',
        content: `Sorry, something went wrong: ${(err as Error).message}`,
        isError: true,
      }])
    } finally {
      setIsLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const STARTERS = [
    'Build a 5-step SaaS founder outreach sequence',
    'Create a follow-up flow for people who didn\'t reply',
    'Design a warm intro sequence for mutual connections',
    'Make a sequence for cold outreach to HR directors',
  ]

  return (
    <div className="absolute top-0 right-0 bottom-0 w-[420px] flex flex-col bg-white border-l border-gray-200 shadow-2xl z-30">

      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 bg-white">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-white text-sm font-bold">
          ✨
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-900">Build with AI</p>
          <p className="text-[11px] text-gray-400">Describe your sequence — I'll build it</p>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" style={{ background: '#F8FAFC' }}>

        {/* Empty state — starters */}
        {messages.length === 0 && (
          <div className="space-y-4">
            <div className="text-center pt-4 pb-2">
              <div className="text-3xl mb-2">🤖</div>
              <p className="text-sm font-semibold text-gray-800">Hi! I'm your sequence builder.</p>
              <p className="text-xs text-gray-500 mt-1">
                Tell me what you want to achieve and I'll design the perfect LinkedIn outreach flow.
              </p>
            </div>
            <div className="space-y-2">
              {STARTERS.map(s => (
                <button
                  key={s}
                  onClick={() => { setInput(s); inputRef.current?.focus() }}
                  className="w-full text-left px-3 py-2.5 bg-white border border-gray-200 rounded-xl text-xs text-gray-700 hover:border-blue-300 hover:bg-blue-50 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Conversation */}
        {messages.map((msg, i) => (
          <div key={i} className={`flex items-end gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>

            {/* Avatar */}
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-[10px] font-bold shrink-0">AI</div>
            )}

            {/* Bubble */}
            <div className={[
              'max-w-[310px] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed',
              msg.role === 'user'
                ? 'bg-blue-600 text-white rounded-br-sm'
                : msg.isError
                  ? 'bg-red-50 border border-red-200 text-red-700 rounded-bl-sm'
                  : 'bg-white border border-gray-200 text-gray-800 rounded-bl-sm',
            ].join(' ')}>
              {/* Whitespace-preserved text */}
              <p className="whitespace-pre-wrap">{msg.content}</p>

              {/* Step preview pills */}
              {msg.steps && msg.steps.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-2">
                    Proposed sequence ({msg.steps.length} steps)
                  </p>
                  {msg.steps.map((step, si) => (
                    <StepPill key={si} step={step} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {isLoading && <TypingIndicator />}

        <div ref={bottomRef} />
      </div>

      {/* Apply banner — appears when AI has proposed steps */}
      {pendingSteps && pendingSteps.length > 0 && (
        <div className="shrink-0 mx-3 mb-3 p-3 bg-blue-50 border border-blue-200 rounded-xl flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold text-blue-900">
              {pendingSteps.length}-step sequence ready
            </p>
            <p className="text-[11px] text-blue-600 mt-0.5">
              This will replace your current sequence
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setPendingSteps(null)}
              className="px-2.5 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-100 rounded-lg transition-colors"
            >
              Dismiss
            </button>
            <button
              onClick={() => applyMutation.mutate(pendingSteps)}
              disabled={applyMutation.isPending}
              className="px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {applyMutation.isPending ? 'Applying…' : 'Apply ✓'}
            </button>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="shrink-0 px-3 pb-3">
        <div className="flex items-end gap-2 bg-white border border-gray-200 rounded-2xl px-3 py-2 focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-200 transition-all">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your sequence or ask to modify it…"
            rows={1}
            disabled={isLoading}
            className="flex-1 resize-none text-sm text-gray-800 placeholder-gray-400 focus:outline-none bg-transparent max-h-32 leading-relaxed disabled:opacity-50"
            style={{ minHeight: '24px' }}
            onInput={e => {
              const t = e.currentTarget
              t.style.height = 'auto'
              t.style.height = `${Math.min(t.scrollHeight, 128)}px`
            }}
          />
          <button
            onClick={() => void handleSend()}
            disabled={!input.trim() || isLoading}
            className="shrink-0 w-8 h-8 rounded-xl bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
        <p className="text-[10px] text-gray-400 text-center mt-2">Enter to send · Shift+Enter for new line</p>
      </div>
    </div>
  )
}
