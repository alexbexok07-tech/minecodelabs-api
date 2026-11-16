-- Run once against the existing Cloudflare D1 database bound as DB.
-- Export/backup the D1 database before applying this migration.
ALTER TABLE mcl_api_keys ADD COLUMN rate_limit_mode TEXT NOT NULL DEFAULT 'fixed';
ALTER TABLE mcl_api_keys ADD COLUMN model_rate_limits_json TEXT;

CREATE TABLE IF NOT EXISTS mcl_api_model_usage (
  key_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(key_id, model_id, bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_mcl_api_model_usage_bucket
  ON mcl_api_model_usage(model_id, bucket_start);
