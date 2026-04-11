-- Add stable browser fingerprint per LinkedIn account.
-- Generated once at account creation and reused across every Playwright session
-- so LinkedIn always sees the same device identity for a given account.

ALTER TABLE linkedin_accounts
  ADD COLUMN IF NOT EXISTS fingerprint jsonb;

COMMENT ON COLUMN linkedin_accounts.fingerprint IS
  'Stable per-account browser fingerprint injected into every Playwright session. '
  'Fields: webgl_vendor, webgl_renderer, screen_width, screen_height, platform, '
  'user_agent, timezone, locale, canvas_seed, hardware_concurrency, device_memory.';
