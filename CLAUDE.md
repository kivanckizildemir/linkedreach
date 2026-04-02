# CLAUDE.md — LinkedReach

This file is read automatically by Claude Code at the start of every session.
Always follow these conventions. Always check PLANNING.md for the full roadmap.

---

## Project Overview

LinkedReach is a LinkedIn outreach automation platform. A full HeyReach competitor.
It manages multiple LinkedIn accounts, runs automated sequences, qualifies leads
with AI, and aggregates replies into a unified inbox.

---

## Monorepo Structure

```
/linkedreach
  /frontend        → Vite + React + TypeScript
  /backend         → Node.js + Express + TypeScript
  /shared          → Shared types and interfaces
  PLANNING.md      → Full roadmap and architecture
  CLAUDE.md        → This file
```

---

## Stack

- **Frontend:** Vite, React, TypeScript, Tailwind CSS
- **Backend:** Node.js, Express, TypeScript
- **Database:** Supabase (PostgreSQL) — use the Supabase client, not raw SQL where possible
- **Job Queue:** BullMQ + Redis
- **Browser Automation:** Playwright
- **AI:** Claude API — model: `claude-sonnet-4-20250514`
- **File Parsing:** SheetJS
- **Auth:** Supabase Auth

---

## Backend Conventions

- All routes in `/backend/src/routes/`
- One file per resource: `accounts.ts`, `campaigns.ts`, `leads.ts`, `inbox.ts`
- All BullMQ workers in `/backend/src/workers/`
- All Playwright logic in `/backend/src/linkedin/`
- All Claude API calls in `/backend/src/ai/`
- Use `async/await` — no `.then()` chains
- All errors caught and returned as `{ error: string }` with appropriate HTTP status
- Use TypeScript interfaces for all request/response shapes — keep them in `/shared/types/`
- Never hardcode credentials — always use `process.env`
- All env vars documented in `.env.example`

---

## Frontend Conventions

- All pages in `/frontend/src/pages/`
- All reusable components in `/frontend/src/components/`
- All API calls in `/frontend/src/api/` (one file per resource)
- Use React Query for data fetching and caching
- Tailwind for all styling — no separate CSS files unless necessary
- No inline styles
- All form state with React Hook Form

---

## Database Conventions

- All Supabase migrations in `/backend/supabase/migrations/`
- Table names: snake_case, plural (e.g., `linkedin_accounts`, `campaign_leads`)
- Always include `id` (uuid), `created_at`, `updated_at` on every table
- Use Row Level Security (RLS) on all tables — users only see their own data
- Soft deletes where appropriate (`deleted_at` timestamp)

---

## LinkedIn Automation Rules (Enforce Always)

The workers MUST enforce these — never let UI bypass them:

- Max **25 connection requests** per account per day
- Max **100 messages** per account per day
- No actions between **11pm–7am** (account's local timezone)
- Minimum **30–120 second randomised gap** between actions
- Always **view profile** before sending connection request
- New accounts: start at 5/day, ramp +3/week (use `warmup_day` field)
- On any LinkedIn warning/captcha: **immediately pause account**

---

## AI (Claude API) Usage

- Model: `claude-sonnet-4-20250514`
- Lead qualification prompt lives in: `/backend/src/ai/qualify.ts`
- Personalisation prompt lives in: `/backend/src/ai/personalise.ts`
- Reply classification prompt lives in: `/backend/src/ai/classify.ts`
- Always return structured JSON from AI calls — prompt the model to respond in JSON only
- Strip markdown fences before parsing JSON responses

---

## Current Phase

> **Check PLANNING.md for the full phase breakdown.**
> Update this line when moving to a new phase.

**Currently on: Phase 1 — Foundation**

- [ ] Repo + monorepo structure
- [ ] Supabase schema
- [ ] BullMQ + Redis skeleton
- [ ] Express API scaffolding
- [ ] Basic frontend with auth

---

## Environment Variables

Always use `.env` locally. Never commit secrets. Keep `.env.example` up to date.

```
# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# Redis
REDIS_URL=

# Claude API
ANTHROPIC_API_KEY=

# Proxies
PROXY_USERNAME=
PROXY_PASSWORD=
PROXY_HOST=

# App
PORT=3001
NODE_ENV=development
```

---

## Important Reminders

- The backend CANNOT be deployed to Vercel — use Railway or Render (persistent workers)
- Playwright requires a non-serverless environment
- Always test LinkedIn actions locally with a test account before production
- When in doubt about LinkedIn detection risk, be MORE conservative, not less
