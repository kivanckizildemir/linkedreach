import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { fetchUnreadCount } from '../api/inbox'
import { supabase } from '../lib/supabase'

const PAGE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/campaigns': 'Campaigns',
  '/leads': 'Leads',
  '/inbox': 'Inbox',
  '/accounts': 'Accounts',
  '/blacklist': 'Blacklist',
  '/settings': 'Settings',
}

// Extension ID — must match the installed extension.
// In production the extension is loaded unpacked (developer mode) so the ID is
// generated from the key field or auto-assigned. We try to send; if the extension
// isn't installed the chrome API call just fails silently.
declare const chrome: {
  runtime?: {
    sendMessage: (extId: string | undefined, msg: unknown, cb?: (r: unknown) => void) => void
    lastError?: { message?: string }
  }
} | undefined

async function pushTokenToExtension(token: string, user: { id: string; email?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) { resolve(false); return }
    try {
      // undefined extId = send to self (works when page IS the extension popup;
      // for externally_connectable web pages Chrome routes it to the extension).
      chrome.runtime.sendMessage(undefined, { type: 'RECEIVE_AUTH_TOKEN', token, user }, (res) => {
        if (chrome?.runtime?.lastError) { resolve(false); return }
        resolve(!!(res as { ok?: boolean })?.ok)
      })
    } catch { resolve(false) }
  })
}

export function Layout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [extLinkState, setExtLinkState] = useState<'idle' | 'linking' | 'done' | 'error'>('idle')

  useEffect(() => {
    const base = location.pathname.split('/').slice(0, 2).join('/') || '/'
    const title = PAGE_TITLES[base] ?? 'LinkedReach'
    document.title = `${title} | LinkedReach`
  }, [location.pathname])

  const { data: unreadCount = 0 } = useQuery({
    queryKey: ['inbox-unread'],
    queryFn: fetchUnreadCount,
    refetchInterval: 30_000,
  })

  const navItems = [
    { to: '/', label: 'Dashboard', icon: DashboardIcon, end: true },
    { to: '/campaigns', label: 'Campaigns', icon: CampaignIcon },
    { to: '/leads', label: 'Leads', icon: LeadsIcon },
    { to: '/inbox', label: 'Inbox', icon: InboxIcon, badge: unreadCount > 0 ? unreadCount : undefined },
    { to: '/accounts', label: 'Accounts', icon: AccountsIcon },
    { to: '/blacklist', label: 'Blacklist', icon: BlacklistIcon },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ]

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  async function handleLinkExtension() {
    setExtLinkState('linking')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('No session')
      const ok = await pushTokenToExtension(session.access_token, {
        id: session.user.id,
        email: session.user.email,
      })
      setExtLinkState(ok ? 'done' : 'error')
      setTimeout(() => setExtLinkState('idle'), 3000)
    } catch {
      setExtLinkState('error')
      setTimeout(() => setExtLinkState('idle'), 3000)
    }
  }

  return (
    <div className="flex h-screen bg-gray-50">
      <aside className="w-60 shrink-0 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-6 py-5 border-b border-gray-200">
          <span className="text-lg font-bold text-blue-600 tracking-tight">LinkedReach</span>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map(({ to, label, icon: Icon, end, badge }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                [
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                ].join(' ')
              }
            >
              <Icon />
              <span className="flex-1">{label}</span>
              {badge !== undefined && (
                <span className="ml-auto min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="px-3 py-4 border-t border-gray-200 space-y-1">
          <div className="px-3 mb-2">
            <p className="text-xs text-gray-400 truncate">{user?.email}</p>
          </div>

          {/* Link Chrome Extension — one-click auth push */}
          <button
            onClick={handleLinkExtension}
            disabled={extLinkState === 'linking'}
            title="Send your login session to the Chrome extension — no password needed in the extension"
            className={[
              'flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors',
              extLinkState === 'done'
                ? 'bg-green-50 text-green-700'
                : extLinkState === 'error'
                  ? 'bg-red-50 text-red-600'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
            ].join(' ')}
          >
            {extLinkState === 'linking' ? (
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            ) : extLinkState === 'done' ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 14v6m-3-3h6M6 10h2a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v2a2 2 0 002 2zm10 0h2a2 2 0 002-2V6a2 2 0 00-2-2h-2a2 2 0 00-2 2v2a2 2 0 002 2zM6 20h2a2 2 0 002-2v-2a2 2 0 00-2-2H6a2 2 0 00-2 2v2a2 2 0 002 2z"/>
              </svg>
            )}
            {extLinkState === 'done' ? 'Extension linked!' : extLinkState === 'error' ? 'Extension not found' : 'Link Extension'}
          </button>

          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
          >
            <SignOutIcon />
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}

function DashboardIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  )
}

function CampaignIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
    </svg>
  )
}

function LeadsIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}

function InboxIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
    </svg>
  )
}

function AccountsIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function BlacklistIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}

function SignOutIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
    </svg>
  )
}
