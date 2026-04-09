-- Enable Supabase Realtime on the leads table so the frontend
-- receives row-level push events when scores are written by the qualify worker.
ALTER PUBLICATION supabase_realtime ADD TABLE leads;
