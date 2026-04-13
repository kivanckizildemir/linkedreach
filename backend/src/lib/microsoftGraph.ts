/**
 * Microsoft Graph API client for Teams meeting creation.
 *
 * Handles:
 *  - Token refresh (access tokens expire in ~1h)
 *  - createTeamsMeeting — POST /me/onlineMeetings → returns joinWebUrl
 */

import { supabase } from './supabase'

const TENANT_ID     = process.env.MICROSOFT_TENANT_ID     ?? 'common'
const CLIENT_ID     = process.env.MICROSOFT_CLIENT_ID     ?? ''
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET ?? ''
const TOKEN_URL     = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`
const GRAPH_BASE    = 'https://graph.microsoft.com/v1.0'

// ── Token management ──────────────────────────────────────────────────────────

interface TokenRow {
  access_token:  string
  refresh_token: string
  expires_at:    string
}

async function refreshAccessToken(userId: string, refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    scope:         'OnlineMeetings.ReadWrite offline_access',
  })

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Microsoft token refresh failed: ${err.slice(0, 300)}`)
  }

  const data = await res.json() as {
    access_token:  string
    refresh_token?: string
    expires_in:    number
  }

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()

  await supabase
    .from('microsoft_connections')
    .update({
      access_token:  data.access_token,
      refresh_token: data.refresh_token ?? refreshToken,
      expires_at:    expiresAt,
    })
    .eq('user_id', userId)

  return data.access_token
}

/**
 * Returns a valid access token for the user, refreshing if needed.
 * Throws if the user has no Microsoft connection.
 */
export async function getValidToken(userId: string): Promise<string> {
  const { data, error } = await supabase
    .from('microsoft_connections')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', userId)
    .single()

  if (error || !data) {
    throw new Error(`No Microsoft connection for user ${userId}`)
  }

  const row = data as TokenRow
  const expiresAt = new Date(row.expires_at).getTime()
  const fiveMin   = 5 * 60 * 1000

  // Refresh if expired or within 5 minutes of expiry
  if (Date.now() >= expiresAt - fiveMin) {
    return refreshAccessToken(userId, row.refresh_token)
  }

  return row.access_token
}

// ── Meeting creation ──────────────────────────────────────────────────────────

export interface TeamsMeeting {
  joinWebUrl:   string
  joinMeetingId?: string
  subject:       string
}

/**
 * Create a Teams online meeting for the given user.
 * Returns the joinWebUrl to include in outreach messages.
 */
export async function createTeamsMeeting(
  userId: string,
  subject = 'Meeting',
  durationMinutes = 30
): Promise<TeamsMeeting> {
  const token = await getValidToken(userId)

  // Start 1 hour from now by default — the link is persistent regardless of time
  const startTime = new Date(Date.now() + 60 * 60 * 1000)
  const endTime   = new Date(startTime.getTime() + durationMinutes * 60 * 1000)

  const res = await fetch(`${GRAPH_BASE}/me/onlineMeetings`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      subject,
      startDateTime: startTime.toISOString(),
      endDateTime:   endTime.toISOString(),
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph API createTeamsMeeting failed: ${res.status} — ${err.slice(0, 300)}`)
  }

  const meeting = await res.json() as {
    joinWebUrl:    string
    joinMeetingId?: string
    subject:       string
  }

  return {
    joinWebUrl:    meeting.joinWebUrl,
    joinMeetingId: meeting.joinMeetingId,
    subject:       meeting.subject,
  }
}

/**
 * Check whether a user has a connected Microsoft account.
 */
export async function getMicrosoftConnectionStatus(userId: string): Promise<{ connected: boolean; ms_email: string | null }> {
  const { data } = await supabase
    .from('microsoft_connections')
    .select('ms_email')
    .eq('user_id', userId)
    .maybeSingle()

  return {
    connected: !!data,
    ms_email:  (data as any)?.ms_email ?? null,
  }
}
