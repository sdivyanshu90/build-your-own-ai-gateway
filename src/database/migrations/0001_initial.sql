-- ============================================================================
-- Migration 0001 — initial schema
--
-- Applied transactionally by scripts/migrate.ts (do NOT add BEGIN/COMMIT here;
-- the runner wraps each file in a single transaction and records it).
--
-- Contents:
--   • adapter_type enum (cohere is added later by 0002 — the additive example)
--   • api_keys, providers, provider_models, provider_health
--   • request_logs: RANGE-partitioned by created_at, with a DEFAULT partition
--     as a safety net and a helper to create monthly partitions
--   • triggers: updated_at maintenance; auto-create provider_health on insert
--   • indexes: FK columns, hot-path partial indexes, (key, created_at) composites
--   • monthly_usage: materialised view refreshed hourly by the cronjob
-- ============================================================================

-- gen_random_uuid() is built into PostgreSQL core (>=13); no extension needed.

-- ── Enum ─────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'adapter_type') THEN
    CREATE TYPE adapter_type AS ENUM ('openai', 'anthropic', 'gemini', 'mistral');
  END IF;
END
$$;

-- ── Shared trigger functions ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION create_provider_health_row() RETURNS trigger AS $$
BEGIN
  INSERT INTO provider_health (provider_id, status, checked_at)
  VALUES (NEW.id, 'unknown', now())
  ON CONFLICT (provider_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── api_keys ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash           text NOT NULL UNIQUE,
  name               text,
  owner_id           uuid,
  is_active          boolean NOT NULL DEFAULT true,
  expires_at         timestamptz,
  monthly_budget_usd numeric(10,4),
  allowed_models     text[],
  rpm_limit          integer NOT NULL DEFAULT 60,
  tpm_limit          integer NOT NULL DEFAULT 100000,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_active_key_hash_idx
  ON api_keys (key_hash) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS api_keys_owner_idx ON api_keys (owner_id);

DROP TRIGGER IF EXISTS api_keys_set_updated_at ON api_keys;
CREATE TRIGGER api_keys_set_updated_at
  BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── providers ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL UNIQUE,
  base_url          text NOT NULL,
  adapter_type      adapter_type NOT NULL,
  encrypted_api_key text NOT NULL,
  weight            integer NOT NULL DEFAULT 1,
  priority          integer NOT NULL DEFAULT 1,
  is_active         boolean NOT NULL DEFAULT true,
  health_check_url  text,
  timeout_ms        integer NOT NULL DEFAULT 60000,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS providers_active_idx ON providers (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS providers_priority_idx ON providers (priority);

DROP TRIGGER IF EXISTS providers_set_updated_at ON providers;
CREATE TRIGGER providers_set_updated_at
  BEFORE UPDATE ON providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS providers_create_health ON providers;
CREATE TRIGGER providers_create_health
  AFTER INSERT ON providers
  FOR EACH ROW EXECUTE FUNCTION create_provider_health_row();

-- ── provider_models ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_models (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id         uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id            text NOT NULL,
  display_name        text,
  context_window      integer,
  max_output_tokens   integer,
  input_price_per_1k  numeric(10,6),
  output_price_per_1k numeric(10,6),
  supports_streaming  boolean NOT NULL DEFAULT true,
  supports_tools      boolean NOT NULL DEFAULT false,
  supports_vision     boolean NOT NULL DEFAULT false,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_models_provider_model_unique UNIQUE (provider_id, model_id)
);

CREATE INDEX IF NOT EXISTS provider_models_provider_idx ON provider_models (provider_id);
CREATE INDEX IF NOT EXISTS provider_models_model_active_idx
  ON provider_models (model_id) WHERE is_active = true;

-- ── provider_health ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_health (
  provider_id   uuid PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'unknown',
  latency_ms    integer,
  error_message text,
  checked_at    timestamptz NOT NULL DEFAULT now()
);

-- ── request_logs (RANGE-partitioned by created_at) ───────────────────────────
-- A partitioned parent requires the partition key in its primary key, hence the
-- composite (id, created_at).
CREATE TABLE IF NOT EXISTS request_logs (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  api_key_id       uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  provider_id      uuid REFERENCES providers(id) ON DELETE SET NULL,
  model_id         text,
  prompt_tokens    integer,
  completion_tokens integer,
  total_tokens     integer,
  cost_usd         numeric(10,6),
  latency_ms       integer,
  status_code      integer,
  cache_hit        boolean NOT NULL DEFAULT false,
  failover_count   integer NOT NULL DEFAULT 0,
  error_message    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Parent-level indexes propagate to every current and future partition.
CREATE INDEX IF NOT EXISTS request_logs_api_key_created_idx
  ON request_logs (api_key_id, created_at);
CREATE INDEX IF NOT EXISTS request_logs_provider_created_idx
  ON request_logs (provider_id, created_at);

-- Helper: create a monthly partition idempotently. Used here for the current and
-- next month, and on a schedule by scripts/create-partition.ts / the cronjob.
CREATE OR REPLACE FUNCTION create_request_logs_partition(p_year int, p_month int)
RETURNS void AS $$
DECLARE
  start_date     date := make_date(p_year, p_month, 1);
  end_date       date := (make_date(p_year, p_month, 1) + interval '1 month')::date;
  partition_name text := format('request_logs_%s', to_char(make_date(p_year, p_month, 1), 'YYYY_MM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF request_logs FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;

-- DEFAULT partition: a safety net so an insert never fails if the dated
-- partition is missing. The partition-creation job keeps it near-empty.
CREATE TABLE IF NOT EXISTS request_logs_default PARTITION OF request_logs DEFAULT;

-- Pre-create the current and next month's partitions.
SELECT create_request_logs_partition(
  EXTRACT(YEAR FROM now())::int, EXTRACT(MONTH FROM now())::int
);
SELECT create_request_logs_partition(
  EXTRACT(YEAR FROM (now() + interval '1 month'))::int,
  EXTRACT(MONTH FROM (now() + interval '1 month'))::int
);

-- ── monthly_usage (materialised view) ────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS monthly_usage AS
SELECT
  api_key_id,
  to_char(date_trunc('month', created_at), 'YYYY-MM') AS year_month,
  count(*)::bigint                            AS total_requests,
  coalesce(sum(total_tokens), 0)::bigint      AS total_tokens,
  coalesce(sum(cost_usd), 0)::numeric(14,6)   AS total_cost_usd
FROM request_logs
WHERE api_key_id IS NOT NULL
GROUP BY api_key_id, date_trunc('month', created_at)
WITH NO DATA;

-- Unique index is required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS monthly_usage_pk
  ON monthly_usage (api_key_id, year_month);

-- Populate once so the hourly CONCURRENTLY refresh has a base to diff against.
REFRESH MATERIALIZED VIEW monthly_usage;
