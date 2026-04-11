-- Add country field to proxies table for BrightData residential IP targeting.
-- When an account has a proxy assigned, the country comes from the proxy record
-- rather than the linkedin_accounts.proxy_country field (which is now deprecated).

ALTER TABLE proxies ADD COLUMN IF NOT EXISTS country text;

-- Comment: ISO 3166-1 alpha-2 code, lowercase (e.g. 'gb', 'us', 'de').
-- Used to append -country-XX to BrightData CDP username for geo-targeting.
