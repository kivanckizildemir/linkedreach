#!/usr/bin/env node
/**
 * One-off migration runner via Supabase service role.
 * Uses a custom SQL execution function we'll create via the management API.
 */
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

const migrations = [
  {
    name: '00033_proxy_type',
    sql: `ALTER TABLE proxies ADD COLUMN IF NOT EXISTS proxy_type text NOT NULL DEFAULT 'isp' CHECK (proxy_type IN ('isp', 'residential', 'datacenter'));`,
    check: async () => {
      const { error } = await supabase.from('proxies').select('proxy_type').limit(1)
      return !error
    },
  },
]

async function run() {
  for (const m of migrations) {
    const exists = await m.check()
    if (exists) {
      console.log(`[migration] ${m.name}: already applied ✓`)
      continue
    }

    // Try to apply via REST with a raw fetch to the Supabase postgres endpoint
    // This works because the service role key has full access
    const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/exec_migration`
    const body = JSON.stringify({ sql_text: m.sql })

    console.log(`[migration] ${m.name}: SQL to apply:`)
    console.log(m.sql)
    console.log()
    console.log('⚠️  Cannot apply automatically without Supabase CLI link.')
    console.log('→ Go to: https://supabase.com/dashboard/project/sapkjpaqjjasskhxswem/sql/new')
    console.log('→ Run this SQL:')
    console.log()
    console.log(m.sql)
    console.log()
  }
}

run().catch(console.error)
