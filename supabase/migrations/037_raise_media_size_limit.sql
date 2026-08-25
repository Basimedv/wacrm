-- ============================================================
-- 037_raise_media_size_limit.sql
--
-- Raises the `file_size_limit` on the `flow-media` and `chat-media`
-- Storage buckets from 16 MB to 50 MB, so video uploads up to 50 MB
-- are accepted by Supabase Storage (previously blocked at the bucket
-- layer before the app's own TS validation even ran).
--
-- NOTE: bucket `file_size_limit` is a single value per bucket, not
-- per-mime-type — this raises the ceiling for every file kind in
-- both buckets (images, documents, audio), not just video. Per-kind
-- limits (e.g. images capped at 5 MB) are still enforced client-side
-- via MEDIA_MAX_BYTES_BY_KIND in src/lib/storage/upload-media.ts.
--
-- IMPORTANT: Meta's WhatsApp Cloud API still hard-caps VIDEO sends at
-- 16 MB regardless of this change. Videos between 16 MB and 50 MB
-- will now upload successfully to Storage but will be REJECTED by
-- Meta when the app attempts to send them via WhatsApp. Send-side
-- error handling for that case is separate follow-up work.
--
-- Idempotent — safe to re-run.
-- ============================================================

UPDATE storage.buckets
SET file_size_limit = 52428800 -- 50 MB
WHERE id IN ('flow-media', 'chat-media');
