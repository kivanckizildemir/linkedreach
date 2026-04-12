-- Migration 00033: Add proxy_type column to proxies table
-- Distinguishes ISP/static proxies (same IP every session) from
-- rotating residential proxies (different IP each connection).
-- ISP proxies are required for LinkedIn session stability.

alter table proxies
  add column if not exists proxy_type text not null default 'isp'
  check (proxy_type in ('isp', 'residential', 'datacenter'));

comment on column proxies.proxy_type is
  'isp = static dedicated IP (preferred for LinkedIn), residential = rotating IP, datacenter = datacenter IP';
