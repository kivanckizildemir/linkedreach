/**
 * extensionHub — WebSocket hub for Chrome extension connections.
 *
 * Each user's extension connects here with their Supabase JWT.
 * The backend can then push LinkedIn action jobs to the extension
 * and await results, instead of spinning up a remote Playwright browser.
 *
 * Flow:
 *   1. Extension connects: GET /ws/extension?token=<jwt>
 *   2. Hub validates JWT, stores socket keyed by userId
 *   3. Worker calls sendActionToExtension(userId, job) → returns result or throws
 *   4. Extension sends { type:'result', jobId, success, data, error }
 *   5. Hub resolves the pending promise
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import type { Server } from 'http'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExtensionJob {
  jobId:          string
  action:         'view_profile' | 'connect' | 'message' | 'follow' | 'react_post' | 'export_session'
  accountId:      string
  profileUrl:     string
  note?:          string   // connection note
  message?:       string   // DM content
  reaction?:      string   // for react_post: like/celebrate/love/insightful/curious
}

interface PendingJob {
  resolve: (data: unknown) => void
  reject:  (err: Error)   => void
  timer:   ReturnType<typeof setTimeout>
}

interface ExtensionClient {
  ws:          WebSocket
  userId:      string
  connectedAt: Date
  pending:     Map<string, PendingJob>
}

// ── State ─────────────────────────────────────────────────────────────────────

const clients = new Map<string, ExtensionClient>()  // userId → client

// ── JWT decode (no verification — Supabase verifies on every API call anyway) ─
function decodeJwt(token: string): { sub?: string } | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string }
  } catch {
    return null
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export function setupExtensionHub(server: Server): void {
  const wss = new WebSocketServer({ noServer: true })

  // Handle HTTP → WS upgrade on path /ws/extension
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname !== '/ws/extension') {
      socket.destroy()
      return
    }

    const token = url.searchParams.get('token')
    if (!token) { socket.destroy(); return }

    const payload = decodeJwt(token)
    const userId  = payload?.sub
    if (!userId) { socket.destroy(); return }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, userId)
    })
  })

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, userId: string) => {
    console.log(`[ExtHub] Extension connected: ${userId}`)

    // Evict any stale connection for this user
    const prev = clients.get(userId)
    if (prev) {
      prev.ws.terminate()
      rejectAllPending(prev, new Error('Extension reconnected — old connection evicted'))
    }

    const client: ExtensionClient = {
      ws, userId, connectedAt: new Date(), pending: new Map(),
    }
    clients.set(userId, client)

    // Send a welcome ping so the extension knows it's live
    safeSend(ws, { type: 'connected', userId })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; jobId?: string; success?: boolean; data?: unknown; error?: string }

        if (msg.type === 'result' && msg.jobId) {
          const pending = client.pending.get(msg.jobId)
          if (!pending) return
          clearTimeout(pending.timer)
          client.pending.delete(msg.jobId)
          if (msg.success) pending.resolve(msg.data ?? {})
          else pending.reject(new Error(msg.error ?? 'Extension action failed'))
        }

        if (msg.type === 'ping') {
          safeSend(ws, { type: 'pong' })
        }
      } catch {
        // malformed message — ignore
      }
    })

    ws.on('close', () => {
      console.log(`[ExtHub] Extension disconnected: ${userId}`)
      rejectAllPending(client, new Error('Extension disconnected'))
      clients.delete(userId)
    })

    ws.on('error', (err) => {
      console.error(`[ExtHub] WS error for ${userId}:`, err.message)
    })
  })

  console.log('[ExtHub] WebSocket hub ready on /ws/extension')
}

// ── Public API ────────────────────────────────────────────────────────────────

/** True if the user's extension is currently connected. */
export function isExtensionOnline(userId: string): boolean {
  const c = clients.get(userId)
  return !!c && c.ws.readyState === WebSocket.OPEN
}

/** Returns all userIds with an active extension connection. */
export function onlineUsers(): string[] {
  return [...clients.entries()]
    .filter(([, c]) => c.ws.readyState === WebSocket.OPEN)
    .map(([uid]) => uid)
}

/**
 * Send a LinkedIn action job to the user's extension and await the result.
 * Throws if the extension is offline, the action fails, or it times out.
 */
export async function sendActionToExtension(
  userId:    string,
  job:       ExtensionJob,
  timeoutMs: number = 90_000,
): Promise<unknown> {
  const client = clients.get(userId)
  if (!client || client.ws.readyState !== WebSocket.OPEN) {
    throw new Error('Extension not connected')
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.pending.delete(job.jobId)
      reject(new Error(`Extension action timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    client.pending.set(job.jobId, { resolve, reject, timer })
    safeSend(client.ws, { type: 'job', job })
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeSend(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function rejectAllPending(client: ExtensionClient, err: Error): void {
  for (const [, pending] of client.pending) {
    clearTimeout(pending.timer)
    pending.reject(err)
  }
  client.pending.clear()
}
