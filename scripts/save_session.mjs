/**
 * LinkedIn session exporter — uses the already-installed Playwright from the backend.
 *
 * Usage:
 *   node scripts/save_session.mjs
 *
 * A Chrome window opens. Log in to LinkedIn normally (including any 2FA).
 * Once you're on the feed, press Enter in this terminal.
 * The full storage_state JSON is saved to scripts/linkedin_session.json
 * AND printed to the console so you can copy-paste it into the app.
 */

import { chromium } from '../backend/node_modules/playwright/index.mjs'
import { createInterface } from 'readline'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))

const browser = await chromium.launch({ headless: false })
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
})
const page = await context.newPage()

console.log('\n🔓 Opening LinkedIn login page...\n')
await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' })

const rl = createInterface({ input: process.stdin, output: process.stdout })
await new Promise(resolve => {
  rl.question(
    '👆 Log in to LinkedIn in the browser window, then press ENTER here when done: ',
    resolve
  )
})
rl.close()

console.log('\n💾 Saving session...')
const state = await context.storageState()

const outPath = join(__dir, 'linkedin_session.json')
writeFileSync(outPath, JSON.stringify(state, null, 2))

console.log(`\n✅ Saved to: ${outPath}`)
console.log('\n📋 Copy the JSON below and paste it into Quick Login:\n')
console.log('─'.repeat(60))
console.log(JSON.stringify(state))
console.log('─'.repeat(60))

await browser.close()
process.exit(0)
