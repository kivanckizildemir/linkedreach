-- Add TOTP secret key for Infinite Login (auto-generate 2FA codes)
ALTER TABLE linkedin_accounts ADD COLUMN IF NOT EXISTS totp_secret text;
