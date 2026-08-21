CREATE TABLE IF NOT EXISTS mcl_api_keys (
  id INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  rate_limit_tpm INTEGER NOT NULL DEFAULT 500,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcl_owner ON mcl_api_keys(owner_id);
CREATE INDEX IF NOT EXISTS idx_mcl_prefix ON mcl_api_keys(key_prefix);
CREATE TABLE IF NOT EXISTS mcl_api_usage (
  key_id INTEGER NOT NULL,
  bucket_start TEXT NOT NULL,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(key_id,bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_mcl_bucket ON mcl_api_usage(bucket_start);
