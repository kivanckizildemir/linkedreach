import type { Page } from 'playwright'
import { supabase } from '../lib/supabase'

export interface EnrichedProfile {
  about: string | null
  experience_description: string | null
  skills: string[]
  recent_posts: string[]
  _resolvedUrl?: string    // set when a Sales Nav URL was resolved to a /in/ URL
  _sessionExpired?: boolean // set when session is dead mid-batch → enrichLeads stops
}

export interface LeadToEnrich {
  id: string
  linkedin_url: string
  first_name: string
  last_name: string
}

export async function scrapeLinkedInProfile(page: Page, linkedinUrl: string): Promise<EnrichedProfile> {
  const result: EnrichedProfile = { about: null, experience_description: null, skills: [], recent_posts: [] }

  try {
    let profileUrl = linkedinUrl.split('?')[0].replace(/\/$/, '')

    // Sales Nav URLs (/sales/lead/...) — intercept API responses to extract the
    // real /in/ profile URL. The Sales Nav UI renders the "View LinkedIn profile"
    // button via JS with no <a href>, so DOM scanning doesn't work.
    if (profileUrl.includes('/sales/lead/') || profileUrl.includes('/sales/people/')) {
      // Helper: one attempt to navigate to Sales Nav and intercept the /in/ URL.
      // Returns the resolved /in/ URL or null.
      const tryResolveSalesNav = async (): Promise<string | null> => {
        let resolved: string | null = null
        const handler = async (response: import('playwright').Response) => {
          if (resolved) return
          const url = response.url()
          if (!url.includes('/sales-api/') && !url.includes('/voyager/api/')) return
          try {
            const body = await response.text()
            const re = /linkedin\.com\/in\/([a-zA-Z0-9_%-]{3,})/g
            let m: RegExpExecArray | null
            while ((m = re.exec(body)) !== null) {
              const candidate = `https://www.linkedin.com/in/${m[1]}`
              if (!candidate.includes('/in/me')) {
                resolved = candidate.split('?')[0].replace(/\/$/, '')
                break
              }
            }
          } catch { /* ignore unreadable responses */ }
        }
        page.on('response', handler)
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => null)
        await page.waitForTimeout(2000)
        page.off('response', handler)

        const landed = page.url()
        if (landed.includes('/in/')) return landed.split('?')[0].replace(/\/$/, '')
        return resolved
      }

      let firstAttempt = await tryResolveSalesNav()
      const landedAfterFirst = page.url()

      // If Sales Nav redirected to its own login page, the li_a session is not
      // established yet. Warm up on the regular LinkedIn feed (li_at is still
      // valid) — this triggers LinkedIn to issue a fresh li_a — then retry once.
      if (
        landedAfterFirst.includes('/sales/login') ||
        (!firstAttempt && (
          landedAfterFirst.includes('/login') ||
          landedAfterFirst.includes('/checkpoint') ||
          landedAfterFirst.includes('/uas/login')
        ))
      ) {
        console.log(`[enrich] Sales Nav session not ready (${landedAfterFirst.split('?')[0]}) — warming up on feed and retrying...`)
        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null)
        await page.waitForTimeout(3000)

        const feedUrl = page.url()
        if (feedUrl.includes('/login') || feedUrl.includes('/uas/login') || feedUrl.includes('/checkpoint')) {
          console.log(`[enrich] li_at session also expired — account needs reconnect, skipping`)
          return { ...result, _sessionExpired: true }
        }

        console.log(`[enrich] Feed loaded (${feedUrl.substring(0, 60)}) — retrying Sales Nav URL...`)
        firstAttempt = await tryResolveSalesNav()
        const landedAfterRetry = page.url()

        if (landedAfterRetry.includes('/sales/login') || landedAfterRetry.includes('/login')) {
          console.log(`[enrich] Still on login after warm-up retry — li_a expired, skipping`)
          return { ...result, _sessionExpired: true }
        }
      } else if (
        landedAfterFirst.includes('/login') ||
        landedAfterFirst.includes('/checkpoint') ||
        landedAfterFirst.includes('/uas/login')
      ) {
        console.log(`[enrich] Session expired — redirected to login, skipping`)
        return { ...result, _sessionExpired: true }
      }

      const resolvedInUrl = firstAttempt
      const landedUrl = page.url()

      // Redirect straight to /in/ (rare but possible)
      if (landedUrl.includes('/in/')) {
        profileUrl = landedUrl.split('?')[0].replace(/\/$/, '')
        console.log(`[enrich] Redirected to /in/ URL: ${profileUrl}`)
        result._resolvedUrl = profileUrl
      } else if (resolvedInUrl) {
        console.log(`[enrich] Resolved via API intercept → ${resolvedInUrl}`)
        profileUrl = resolvedInUrl
        result._resolvedUrl = resolvedInUrl
      } else {
        console.log(`[enrich] Could not resolve /in/ URL for ${profileUrl} — skipping`)
        return result
      }
    }

    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => null)
    await page.waitForTimeout(2000)

    const currentUrl = page.url()
    if (
      currentUrl.includes('/login') ||
      currentUrl.includes('/checkpoint') ||
      currentUrl.includes('/authwall') ||
      currentUrl.includes('/uas/login')
    ) {
      console.log(`[enrich] Session expired or authwall — landed on ${currentUrl} — account needs reconnect`)
      return { ...result, _sessionExpired: true }
    }

    console.log(`[enrich] Landed on: ${currentUrl}`)

    // Scroll to trigger lazy-loaded sections (about, experience, skills)
    // NOTE: All page.evaluate calls use STRING form to avoid tsx/esbuild __name() helper injection
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight / 2)')
    await page.waitForTimeout(1500)
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
    await page.waitForTimeout(1500)
    await page.evaluate('window.scrollTo(0, 0)')
    await page.waitForTimeout(800)

    // LinkedIn removed #about / #experience / #skills anchor IDs.
    // Sections are now found by their h2 heading text.
    // Click all "see more" / "show more" buttons first to expand truncated text.
    await page.evaluate(`(function() {
      var sections = Array.from(document.querySelectorAll('section'));
      for (var i = 0; i < sections.length; i++) {
        var s = sections[i];
        var h2el = s.querySelector('h2');
        var h2 = h2el ? h2el.textContent.trim() : '';
        if (['About','Experience','Skills','Education'].some(function(n) { return h2.indexOf(n) !== -1; })) {
          s.querySelectorAll('button').forEach(function(btn) {
            var t = btn.textContent ? btn.textContent.trim() : '';
            if (t.indexOf('more') !== -1 || t.indexOf('More') !== -1 || t.indexOf('\u2026') !== -1) btn.click();
          });
        }
      }
    })()`)
    await page.waitForTimeout(600)

    // Diagnostic: log which profile sections are present
    const sectionDiag = await page.evaluate(`(function() {
      var keywords = ['About','Experience','Skills','Education'];
      var found = Array.from(document.querySelectorAll('section'))
        .map(function(s) { var h = s.querySelector('h2'); return h ? h.textContent.trim() : ''; })
        .filter(function(h) { return h && keywords.some(function(n) { return h.indexOf(n) !== -1; }); });
      return { found: found };
    })()`).catch(() => ({ found: [] as string[] })) as { found: string[] }
    console.log(`[enrich] Sections found: ${sectionDiag.found.join(', ') || 'none'}`)

    // Extract profile data — string form bypasses tsx/esbuild __name() injection
    const profileData = await page.evaluate(`(function() {
      function getText(el) {
        return (el && el.textContent ? el.textContent : '').replace(/\\s+/g, ' ').trim();
      }
      function findSection(keyword) {
        return Array.from(document.querySelectorAll('section')).find(function(s) {
          var h2 = s.querySelector('h2');
          return h2 && h2.textContent.trim().indexOf(keyword) !== -1;
        }) || null;
      }

      // About — try multiple selectors; LinkedIn uses different layouts
      var about = null;
      var aboutSection = findSection('About');
      if (aboutSection) {
        // Approach 1: <p> element (most common in 2024-2025 layout)
        var p = aboutSection.querySelector('p');
        if (p) {
          var text = getText(p).replace(/\\u2026\\s*more$/i, '').trim();
          if (text.length > 20) about = text.slice(0, 1200);
        }
        // Approach 2: span[aria-hidden="true"] (older layout)
        if (!about) {
          var spans = Array.from(aboutSection.querySelectorAll('span[aria-hidden="true"]'));
          var spanText = spans.map(function(s) { return getText(s); }).filter(function(t) { return t.length > 30; }).join(' ');
          if (spanText) about = spanText.slice(0, 1200);
        }
        // Approach 3: full section text minus heading and button labels
        if (!about) {
          var h2el = aboutSection.querySelector('h2');
          var heading = h2el ? h2el.textContent : '';
          var btnTexts = Array.from(aboutSection.querySelectorAll('button')).map(function(b) { return b.textContent || ''; }).join(' ');
          var raw = getText(aboutSection).replace(heading, '').replace(btnTexts, '').replace(/\\u2026\\s*more/gi, '').replace(/see less/gi, '').trim();
          if (raw.length > 20) about = raw.slice(0, 1200);
        }
      }

      // Experience — first job's description from <li> items
      var experience_description = null;
      var expSection = findSection('Experience');
      if (expSection) {
        var firstItem = expSection.querySelector('li');
        if (firstItem) {
          var descP = Array.from(firstItem.querySelectorAll('p'))
            .map(function(p2) { return getText(p2); })
            .filter(function(t) { return t.length > 40 && t.indexOf('\\u00b7') === -1 && !/^\\d/.test(t); });
          if (descP.length > 0) {
            experience_description = descP[0].slice(0, 600);
          } else {
            var descSpans = Array.from(firstItem.querySelectorAll('span[aria-hidden="true"]'))
              .map(function(s2) { return getText(s2); })
              .filter(function(t) { return t.length > 40 && t.indexOf('\\u00b7') === -1 && !/^\\d/.test(t); });
            if (descSpans.length > 0) {
              experience_description = (descSpans[descSpans.length - 1] || '').slice(0, 600) || null;
            }
          }
        }
      }

      // Skills — list of skill names
      var skills = [];
      var skillsSection = findSection('Skills');
      if (skillsSection) {
        var items = Array.from(skillsSection.querySelectorAll('li')).slice(0, 8);
        items.forEach(function(item) {
          var p3 = item.querySelector('p');
          if (p3) {
            var t = getText(p3);
            if (t.length > 1 && t.length < 60) { skills.push(t); return; }
          }
          var allSpans = Array.from(item.querySelectorAll('span[aria-hidden="true"]'));
          var span = allSpans.find(function(s3) {
            var t2 = getText(s3);
            return t2.length > 1 && t2.length < 60 && t2.indexOf('endorsement') === -1;
          });
          if (span) skills.push(getText(span));
        });
      }

      return { about: about, experience_description: experience_description, skills: skills };
    })()`).catch((evalErr: unknown) => {
      console.warn(`[enrich] page.evaluate error: ${(evalErr as Error)?.message ?? String(evalErr)}`)
      return { about: null, experience_description: null, skills: [] as string[] }
    }) as { about: string | null; experience_description: string | null; skills: string[] }

    result.about = profileData.about
    result.experience_description = profileData.experience_description
    result.skills = profileData.skills

    try {
      const activityUrl = `${profileUrl}/recent-activity/all/`
      await page.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      await page.waitForTimeout(2500)

      const posts = await page.evaluate(`(function() {
        var selectors = [
          '.feed-shared-update-v2__description span[dir]',
          '.attributed-text-segment-list__content',
          '[data-urn*="activity"] .break-words',
          '.feed-shared-text span[aria-hidden="true"]'
        ];
        var found = [];
        for (var i = 0; i < selectors.length; i++) {
          if (found.length >= 3) break;
          document.querySelectorAll(selectors[i]).forEach(function(el) {
            if (found.length >= 3) return;
            var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (text.length > 30 && found.indexOf(text) === -1) found.push(text.slice(0, 300));
          });
        }
        return found;
      })()`).catch(() => [] as string[])

      result.recent_posts = posts as string[]
    } catch {
      // non-fatal
    }
  } catch (err) {
    console.warn(`[enrich] Profile visit failed for ${linkedinUrl}: ${(err as Error).message}`)
  }

  return result
}

export async function enrichLeads(
  page: Page,
  leads: LeadToEnrich[],
  user_id: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ sessionExpired: boolean }> {
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i]
    if (!lead.linkedin_url) {
      onProgress?.(i + 1, leads.length)
      continue
    }

    try {
      console.log(`[enrich] (${i + 1}/${leads.length}) ${lead.first_name} ${lead.last_name}`)
      const enriched = await scrapeLinkedInProfile(page, lead.linkedin_url)

      // Session died — stop the entire batch, don't hammer more profiles
      if (enriched._sessionExpired) {
        console.warn(`[enrich] Session expired mid-batch — stopping at lead ${i + 1}/${leads.length}`)
        onProgress?.(i + 1, leads.length)
        return { sessionExpired: true }
      }

      const hasData = enriched.about || enriched.experience_description || enriched.skills.length > 0 || enriched.recent_posts.length > 0
      if (hasData) {
        const { error: updateErr } = await supabase
          .from('leads')
          .update({
            ...(enriched.about ? { about: enriched.about } : {}),
            ...(enriched.experience_description ? { experience_description: enriched.experience_description } : {}),
            ...(enriched.skills.length > 0 ? { skills: enriched.skills } : {}),
            ...(enriched.recent_posts.length > 0 ? { recent_posts: enriched.recent_posts } : {}),
          })
          .eq('id', lead.id)
          .eq('user_id', user_id)

        if (updateErr) {
          console.warn(`[enrich] DB update failed for ${lead.first_name} ${lead.last_name}: ${updateErr.message}`)
        } else {
          console.log(`[enrich] ✓ ${lead.first_name} ${lead.last_name}: about=${!!enriched.about} skills=${enriched.skills.length} posts=${enriched.recent_posts.length}`)
        }

        // If we resolved a /in/ URL, save it back so future ops use the direct URL
        if (enriched._resolvedUrl && enriched._resolvedUrl !== lead.linkedin_url) {
          await supabase.from('leads').update({ linkedin_url: enriched._resolvedUrl }).eq('id', lead.id).eq('user_id', user_id)
        }
      } else {
        console.log(`[enrich] No data scraped for ${lead.first_name} ${lead.last_name} (${lead.linkedin_url})`)
      }
    } catch (err) {
      console.warn(`[enrich] Failed for ${lead.linkedin_url}: ${(err as Error).message}`)
    }

    onProgress?.(i + 1, leads.length)

    if (i < leads.length - 1) {
      // 0.5–3 second randomised gap — human-like paging speed
      const delay = 500 + Math.random() * 2500
      console.log(`[enrich] Waiting ${(delay / 1000).toFixed(1)}s before next lead…`)
      await page.waitForTimeout(delay)
    }
  }
  return { sessionExpired: false }
}
