/**
 * Combined entry point: starts the HTTP API server + all BullMQ workers
 * in a single process. Used in production (Railway).
 */
import dotenv from 'dotenv'
dotenv.config()

// Start HTTP server
import './index'

// Start background workers
import './workers/index'
