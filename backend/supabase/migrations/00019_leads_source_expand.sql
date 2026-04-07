-- Expand leads.source check constraint to include sales_nav_import and linkedin_import
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_source_check;
ALTER TABLE leads ADD CONSTRAINT leads_source_check
  CHECK (source IN ('excel_import', 'chrome_extension', 'manual', 'sales_nav_import', 'linkedin_import'));
