-- Backfill campaign_leads.account_id from their campaign's account_id
-- for leads that were added before account assignment was enforced
UPDATE campaign_leads cl
SET    account_id = c.account_id
FROM   campaigns c
WHERE  cl.campaign_id = c.id
  AND  cl.account_id  IS NULL
  AND  c.account_id   IS NOT NULL;
