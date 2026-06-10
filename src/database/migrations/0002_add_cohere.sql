-- ============================================================================
-- Migration 0002 — add the Cohere adapter type
--
-- This is the canonical ADDITIVE migration example referenced by the spec. It
-- demonstrates two patterns every additive migration must follow:
--
--   1. Enum extension. New enum values are appended, never reordered or removed,
--      so existing rows and indexes stay valid. ALTER TYPE ... ADD VALUE is the
--      only safe way to grow an enum.
--
--   2. Idempotency. The migration is guarded so re-running it (e.g. a partial
--      prior apply) is a no-op rather than an error.
--
-- NOTE: in PostgreSQL, `ALTER TYPE ... ADD VALUE` cannot run inside a
-- transaction block that later USES the new value. scripts/migrate.ts detects
-- the `-- migrate:no-transaction` directive on the first line and applies this
-- file OUTSIDE a transaction so the new enum label is committed before any
-- statement references it.
-- migrate:no-transaction
-- ============================================================================

ALTER TYPE adapter_type ADD VALUE IF NOT EXISTS 'cohere';

-- After this migration, the application's Cohere adapter (shipped Day 1) can be
-- wired to real provider rows. Example (commented — real credentials are added
-- via the admin API or seed script, never committed):
--
--   INSERT INTO providers (name, base_url, adapter_type, encrypted_api_key)
--   VALUES ('cohere-primary', 'https://api.cohere.com', 'cohere', '<ciphertext>');
