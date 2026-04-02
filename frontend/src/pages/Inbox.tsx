import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchInbox,
  fetchThread,
  updateClassification,
  replyToConversation,
  type ReplyClassification,
} from '../api/inbox'

const FILTERS: { label: string; value: string }[] = [
  { label: 'All',          value: '' },
  { label: 'Interested',   value: 'interested' },
  { label: 'Not Now',      value: 'not_now' },
  { label: 'Wrong Person', value: 'wrong_person' },
  { label: 'Referral',     value: 'referral' },
  { label: 'Negative',     value: 'negative' },
]

const CLASS_COLORS: Record<string, string> = {
  interested:   'bg-green-100 text-green-700',
  not_now:      'bg-yellow-100 text-yellow-700',
  wrong_person: 'bg-gray-100 text-gray-600',
  referral:     'bg-blue-100 text-blue-700',
  negative:     'bg-red-100 text-red-700',
  none:         'bg-gray-100 text-gray-500',
}

const CLASS_LABELS: Record<string, string> = {
  interested:   'Interested',
  not_now:      'Not Now',
  wrong_person: 'Wrong Person',
  referral:     'Referral',
  negative:     'Negative',
  none:         'Unclassified',
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function Inbox() {
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [replyError, setReplyError] = useState('')
  const threadEndRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  const { data: messages = [], isLoading } = useQuery({
    queryKey: ['inbox', filter],
    queryFn: () => fetchInbox(filter || undefined),
  })

  const selectedMsg = messages.find(m => m.campaign_lead_id === selectedId)

  const { data: thread = [], isLoading: threadLoading } = useQuery({
    queryKey: ['thread', selectedId],
    queryFn: () => fetchThread(selectedId!),
    enabled: !!selectedId,
  })

  // Scroll to bottom when thread loads or updates
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [thread.length])

  const classifyMutation = useMutation({
    mutationFn: ({ id, cls }: { id: string; cls: ReplyClassification }) =>
      updateClassification(id, cls),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
      void queryClient.invalidateQueries({ queryKey: ['thread', selectedId] })
    },
  })

  const replyMutation = useMutation({
    mutationFn: ({ id, msg }: { id: string; msg: string }) =>
      replyToConversation(id, msg),
    onSuccess: () => {
      setReplyText('')
      setReplyError('')
      void queryClient.invalidateQueries({ queryKey: ['thread', selectedId] })
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    },
    onError: (err: Error) => {
      setReplyError(err.message)
    },
  })

  return (
    <div className="flex h-full">
      {/* Left sidebar — conversation list */}
      <div className="w-80 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div className="px-4 py-4 border-b border-gray-200">
          <h1 className="text-lg font-bold text-gray-900">Inbox</h1>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {FILTERS.map(({ label, value }) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={[
                  'px-2.5 py-1 text-xs rounded-full border transition-colors',
                  filter === value
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="py-10 text-center text-sm text-gray-400">Loading…</div>
          ) : messages.length === 0 ? (
            <div className="py-16 text-center px-4">
              <p className="text-sm text-gray-500">No replies yet</p>
              <p className="mt-1 text-xs text-gray-400">Replies from your campaigns will appear here</p>
            </div>
          ) : (
            messages.map(msg => {
              const lead = msg.campaign_lead.lead
              const cls = msg.campaign_lead.reply_classification
              const isSelected = msg.campaign_lead_id === selectedId
              return (
                <button
                  key={msg.id}
                  onClick={() => setSelectedId(msg.campaign_lead_id)}
                  className={[
                    'w-full text-left px-4 py-3.5 border-b border-gray-100 transition-colors',
                    isSelected ? 'bg-blue-50' : 'hover:bg-gray-50',
                  ].join(' ')}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">
                        {lead.first_name} {lead.last_name}
                      </p>
                      <p className="text-xs text-gray-400 truncate">{lead.title ?? ''} {lead.company ? `· ${lead.company}` : ''}</p>
                    </div>
                    <span className="text-[10px] text-gray-400 shrink-0 mt-0.5">{timeAgo(msg.sent_at)}</span>
                  </div>
                  <p className="mt-1.5 text-xs text-gray-500 line-clamp-2">{msg.content}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${CLASS_COLORS[cls] ?? CLASS_COLORS.none}`}>
                      {CLASS_LABELS[cls] ?? 'Unclassified'}
                    </span>
                    <span className="text-[10px] text-gray-400">{msg.campaign_lead.campaign.name}</span>
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* Right pane — thread */}
      <div className="flex-1 flex flex-col bg-gray-50">
        {!selectedMsg ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-gray-400 text-sm">Select a conversation to view</p>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-start justify-between">
              <div>
                <p className="text-base font-semibold text-gray-900">
                  {selectedMsg.campaign_lead.lead.first_name} {selectedMsg.campaign_lead.lead.last_name}
                </p>
                <p className="text-sm text-gray-500">
                  {selectedMsg.campaign_lead.lead.title ?? ''}
                  {selectedMsg.campaign_lead.lead.company ? ` · ${selectedMsg.campaign_lead.lead.company}` : ''}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{selectedMsg.campaign_lead.campaign.name}</p>
              </div>
              {/* Classification picker */}
              <div className="flex flex-col items-end gap-2">
                <p className="text-xs text-gray-500">Classification</p>
                <select
                  value={selectedMsg.campaign_lead.reply_classification}
                  onChange={e =>
                    classifyMutation.mutate({
                      id: selectedMsg.campaign_lead_id,
                      cls: e.target.value as ReplyClassification,
                    })
                  }
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {(['interested', 'not_now', 'wrong_person', 'referral', 'negative', 'none'] as const).map(cls => (
                    <option key={cls} value={cls}>{CLASS_LABELS[cls]}</option>
                  ))}
                </select>
                <a
                  href={selectedMsg.campaign_lead.lead.linkedin_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:underline"
                >
                  Open LinkedIn profile ↗
                </a>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              {threadLoading ? (
                <div className="text-center text-sm text-gray-400 py-8">Loading…</div>
              ) : (
                thread.map(msg => (
                  <div
                    key={msg.id}
                    className={['flex', msg.direction === 'sent' ? 'justify-end' : 'justify-start'].join(' ')}
                  >
                    <div
                      className={[
                        'max-w-sm rounded-2xl px-4 py-3 text-sm',
                        msg.direction === 'sent'
                          ? 'bg-blue-600 text-white rounded-br-sm'
                          : 'bg-white border border-gray-200 text-gray-900 rounded-bl-sm',
                      ].join(' ')}
                    >
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                      <p className={['text-[10px] mt-1.5', msg.direction === 'sent' ? 'text-blue-200' : 'text-gray-400'].join(' ')}>
                        {new Date(msg.sent_at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))
              )}
              <div ref={threadEndRef} />
            </div>

            {/* Reply composer */}
            <div className="bg-white border-t border-gray-200 px-4 py-3">
              {replyError && (
                <p className="text-xs text-red-500 mb-2">{replyError}</p>
              )}
              <div className="flex gap-2 items-end">
                <textarea
                  value={replyText}
                  onChange={e => { setReplyText(e.target.value); setReplyError('') }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && replyText.trim() && !replyMutation.isPending) {
                      replyMutation.mutate({ id: selectedMsg!.campaign_lead_id, msg: replyText.trim() })
                    }
                  }}
                  placeholder="Type a reply… (⌘+Enter to send)"
                  rows={3}
                  className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={() => {
                    if (replyText.trim() && selectedMsg && !replyMutation.isPending) {
                      replyMutation.mutate({ id: selectedMsg.campaign_lead_id, msg: replyText.trim() })
                    }
                  }}
                  disabled={!replyText.trim() || replyMutation.isPending}
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                  {replyMutation.isPending ? (
                    <span className="flex items-center gap-1.5">
                      <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3"/>
                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                      </svg>
                      Sending…
                    </span>
                  ) : 'Send'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
