/**
 * Combined entry point: starts the HTTP API server + all BullMQ workers
 * in a single process. Used in production (Railway).
 *
 * HTTP server starts first so the healthcheck passes immediately.
 * Workers start 3 seconds later in the background — a Redis hiccup at
 * boot won't crash the server or fail the healthcheck.
 */
import dotenv from 'dotenv'
dotenv.config()

// Start HTTP server first — healthcheck must pass before workers load
import './index'

// Start workers after a short delay so the HTTP server is fully up
setTimeout(() => {
  import('./workers/index').catch((err) => {
    console.error('[Workers] Failed to start:', err)
  })
}, 3_000)
