-- Add notifications to the realtime publication so the frontend can
-- subscribe to new rows via websocket instead of polling GET /notifications
-- every few seconds. RLS still applies to realtime subscriptions (Supabase
-- Realtime authorizes each change against the subscriber's RLS policies),
-- so this only exposes rows the notifications_select_self policy already
-- allows — no new data exposure, just a push channel for existing access.
alter publication supabase_realtime add table public.notifications;
