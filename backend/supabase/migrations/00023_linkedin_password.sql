-- Store LinkedIn password so the keep-alive worker can auto-reconnect
-- when the session expires (requires TOTP secret for fully-automatic 2FA).
ALTER TABLE linkedin_accounts ADD COLUMN IF NOT EXISTS linkedin_password text;
