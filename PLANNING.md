# LinkedReach — Full Platform Planning

## What We're Building

A full LinkedIn outreach automation platform — a better alternative to HeyReach.
Not a wrapper. A complete product: multi-account LinkedIn session management,
AI-powered lead qualification and personalisation, visual sequence builder,
unified inbox, and campaign analytics.

---

## Core Modules

### 1. LinkedIn Automation Engine
- Playwright-based browser automation (one isolated browser context per account)
- Session cookie persistence (login once, reuse session)
- Residential proxy assignment per account (one IP per LinkedIn account)
- Human behaviour simulation: random delays, typing speed variation, scroll events, profile views before connecting
- Daily limits enforced per account: ~20–25 connection requests, ~100 messages
- Gradual account warmup for new accounts
- Auto-pause on warning signals (captcha, unusual activity prompt)

### 2. Sequence Engine
- Visual sequence builder: Connect → Wait → Message → Branch
- Conditional logic: "If accepted within X days → send message A, else → skip"
- A/B testing on message variants
- Scheduling windows (no sending outside working hours)
- Per-campaign daily send limits

### 3. AI Intelligence Layer (Claude API)
- Lead qualification: score 0–100 against user-defined ICP
- Flag: Hot / Warm / Cold / Disqualify
- Personalised opening line per lead (based on title, company, industry, recent signals)
- Reply classification: Interested / Not Now / Wrong Person / Referral / Negative
- Response suggestions for positive replies
- Campaign learning: surface best-performing message variants

### 4. Lead Management
- Import from Sales Navigator Excel export (SheetJS parser)
- Lead scoring before campaign assignment
- Filter and segment by score, industry, title, location
- Deduplplication logic
- Chrome extension (Phase 2) for direct Sales Navigator scraping

### 5. Unified Inbox
- All replies across all accounts in one view
- Classified by reply intent
- Reply directly from within the app
- Snooze, tag, assign to team member
- Mark as converted

### 6. Analytics Dashboard
- Per campaign: sent / accepted / replied / positive reply rate
- Per account: health score, warning flags, daily activity
- Message variant A/B performance
- Lead source performance
- Exportable reports

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Vite + React + TypeScript | Component-based, fast |
| Styling | Tailwind CSS | Utility-first |
| Backend | Node.js + Express + TypeScript | REST API |
| Database | Supabase (PostgreSQL) | Auth included |
| Job Queue | BullMQ + Redis | Background workers, scheduling |
| Browser Automation | Playwright | Per-account isolated contexts |
| Proxies | Smartproxy or Oxylabs (residential) | One IP per LinkedIn account |
| AI | Claude API (claude-sonnet-4-20250514) | Qualification + personalisation |
| File Parsing | SheetJS | Sales Navigator Excel imports |
| Hosting — Frontend | Vercel | Static deployment |
| Hosting — Backend | Railway or Render | Persistent workers, no cold starts |
| Payments | Stripe | Subscription billing |

**Important:** Do NOT deploy the backend to Vercel. The LinkedIn session workers
are long-running processes and need Railway or Render.

---

## Database Schema

### Tables

**linkedin_accounts**
- id, user_id, linkedin_email, cookies (encrypted), proxy_id
- status: active / paused / banned / warming_up
- daily_connection_count, daily_message_count, last_active_at
- warmup_day (1–30 for new accounts)

**campaigns**
- id, user_id, name, status: draft / active / paused / completed
- icp_config (JSON — ICP scoring rules)
- daily_connection_limit, daily_message_limit
- created_at

**sequences**
- id, campaign_id, name

**sequence_steps**
- id, sequence_id, step_order, type: connect / message / wait
- message_template (with {{variables}})
- wait_days (for wait steps)
- condition (JSON — optional branching logic)

**leads**
- id, user_id, linkedin_url, first_name, last_name
- title, company, industry, location, connection_degree
- icp_score (0–100), icp_flag: hot / warm / cold / disqualified
- source: excel_import / chrome_extension / manual
- raw_data (JSON — original import row)
- created_at

**campaign_leads**
- id, campaign_id, lead_id, account_id (assigned LinkedIn account)
- status: pending / connection_sent / connected / messaged / replied / converted / stopped
- current_step, last_action_at
- reply_classification: interested / not_now / wrong_person / referral / negative / none

**messages**
- id, campaign_lead_id, direction: sent / received
- content, sent_at, linkedin_message_id

**linkedin_accounts_proxies**
- id, proxy_url, assigned_account_id, is_available

---

## Build Phases

### Phase 1 — Foundation (Weeks 1–2)
- [ ] Repo setup: monorepo with /frontend and /backend
- [ ] Supabase project + full schema migration
- [ ] BullMQ + Redis setup with basic job skeleton
- [ ] Express API scaffolding with auth middleware
- [ ] Basic React frontend with routing and auth (Supabase Auth)

### Phase 2 — LinkedIn Engine (Weeks 3–6)
- [ ] Playwright session manager: login, cookie save/load, proxy assignment
- [ ] Action executor: send connection request, send message, check inbox
- [ ] Human behaviour simulation module
- [ ] Account health monitor: detect warnings, auto-pause
- [ ] Daily limit enforcer per account
- [ ] Account warmup scheduler

### Phase 3 — Sequence Engine (Weeks 7–9)
- [ ] Campaign CRUD
- [ ] Sequence + step builder (backend logic)
- [ ] BullMQ job processor: advance leads through steps on schedule
- [ ] Conditional branching logic
- [ ] A/B variant assignment

### Phase 4 — Lead Management (Weeks 10–11)
- [ ] Excel import with SheetJS (Sales Navigator format)
- [ ] Lead deduplication
- [ ] AI qualification (Claude API): ICP scoring + flag
- [ ] AI personalisation: generate opening line per lead
- [ ] Lead dashboard with filters

### Phase 5 — Inbox + Reply Intelligence (Weeks 12–13)
- [ ] LinkedIn inbox poller (runs every X minutes per account)
- [ ] Unified inbox view in frontend
- [ ] Reply classification via Claude API
- [ ] Response suggestion drafts
- [ ] Reply-from-app functionality

### Phase 6 — Analytics + Polish (Weeks 14–15)
- [ ] Campaign analytics dashboard
- [ ] Account health dashboard
- [ ] Message variant performance
- [ ] CSV export
- [ ] Stripe billing integration
- [ ] Onboarding flow

---

## Account Safety Rules (Non-Negotiable)

These must be enforced at the worker level, not the UI level:

1. Max 25 connection requests per account per day
2. Max 100 messages per account per day
3. No actions between 11pm–7am local time for the account's timezone
4. Minimum 30-second gap between consecutive actions (randomised 30–120s)
5. New accounts: start at 5 connections/day, ramp up by 3 each week
6. If LinkedIn shows captcha or "unusual activity" → immediately pause account, alert user
7. Always view profile before sending connection request (mimics human behaviour)
8. Rotate message send times — not all at the same minute

---

## Key External API References

- HeyReach API: https://api.heyreach.io/api-documentation (for reference/inspiration)
- Claude API: https://docs.anthropic.com
- Supabase: https://supabase.com/docs
- BullMQ: https://docs.bullmq.io
- Playwright: https://playwright.dev/docs/intro

---

## Project Name

**LinkedReach** (working title — change before launch)
