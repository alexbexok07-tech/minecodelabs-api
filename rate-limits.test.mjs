import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  MODEL_MAX_TPM,
  keyLimitForModel,
  parseModelLimits,
  reserveUsage,
  releaseUsage,
  finalizeUsage,
} from '../index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    this.params = params;
    return this;
  }
  first() {
    return this.database.prepare(this.sql).get(...this.params) ?? null;
  }
  all() {
    return { results: this.database.prepare(this.sql).all(...this.params) };
  }
  run() {
    const result = this.database.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class D1Database {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  }
  prepare(sql) {
    return new D1Statement(this.sqlite, sql);
  }
  batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

function environment() {
  const DB = new D1Database();
  DB.prepare(`INSERT INTO mcl_api_keys
    (id, owner_id, name, key_prefix, key_hash, rate_limit_tpm, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(1, 'owner', 'test key', 'mcl_live_test', 'hash', 500, '2026-01-01 00:00:00').run();
  return { DB };
}

test('per-model limits parse safely and match the six published ceilings', () => {
  assert.deepEqual(Object.keys(MODEL_MAX_TPM), [
    'openai/gpt-oss-20b',
    'openai/gpt-oss-120b',
    'groq/compound',
    'groq/compound-mini',
    'openai/gpt-oss-safeguard-20b',
    'qwen/qwen3.6-27b',
  ]);
  const limits = parseModelLimits(JSON.stringify(MODEL_MAX_TPM));
  assert.deepEqual(limits, MODEL_MAX_TPM);
  assert.equal(keyLimitForModel({
    rate_limit_mode: 'per_model',
    model_rate_limits_json: JSON.stringify(MODEL_MAX_TPM),
  }, 'groq/compound-mini'), 68000);
  assert.equal(keyLimitForModel({
    rate_limit_mode: 'per_model',
    model_rate_limits_json: '{broken json',
  }, 'openai/gpt-oss-20b'), 0);
  assert.equal(parseModelLimits({ 'openai/gpt-oss-20b': 7001 }), null);
  assert.equal(keyLimitForModel({ rate_limit_mode: 'per_model', model_rate_limits_json: JSON.stringify(MODEL_MAX_TPM) }, 'model-not-configured'), 0);
});

test('fixed TPM reservations are shared, atomic and released/settled correctly', async () => {
  const env = environment();
  const first = await reserveUsage(env, 1, '2026-11-16 12:00:00', 300, 500);
  assert.equal(first.ok, true);
  assert.equal(first.remaining, 200);

  const rejected = await reserveUsage(env, 1, '2026-11-16 12:00:00', 250, 500);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.remaining, 200);

  await releaseUsage(env, 1, '2026-11-16 12:00:00', 100);
  const accepted = await reserveUsage(env, 1, '2026-11-16 12:00:00', 300, 500);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.remaining, 0);

  await finalizeUsage(env, 1, '2026-11-16 12:00:00', 300, 120);
  const usage = await env.DB.prepare('SELECT used_tokens, reserved_tokens FROM mcl_api_usage WHERE key_id = ? AND bucket_start = ?')
    .bind(1, '2026-11-16 12:00:00').first();
  assert.equal(Number(usage.used_tokens), 120);
  assert.equal(Number(usage.reserved_tokens), 200);
});

test('per-model reservations use independent buckets and enforce each model cap', async () => {
  const env = environment();
  const bucketStart = '2026-11-16 12:01:00';

  const oss = await reserveUsage(env, 1, bucketStart, 6500, MODEL_MAX_TPM['openai/gpt-oss-20b'], 'openai/gpt-oss-20b');
  assert.equal(oss.ok, true);
  const ossRejected = await reserveUsage(env, 1, bucketStart, 600, MODEL_MAX_TPM['openai/gpt-oss-20b'], 'openai/gpt-oss-20b');
  assert.equal(ossRejected.ok, false);
  assert.equal(ossRejected.remaining, 500);

  const compound = await reserveUsage(env, 1, bucketStart, 6500, MODEL_MAX_TPM['groq/compound'], 'groq/compound');
  assert.equal(compound.ok, true);
  assert.equal(compound.remaining, 57500);

  const noAllowance = await reserveUsage(env, 1, bucketStart, 1, 0, 'model-not-configured');
  assert.equal(noAllowance.ok, false);
});

test('one-time D1 migration upgrades an existing schema without dropping key or usage rows', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE mcl_api_keys (
    id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
    key_prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
    rate_limit_tpm INTEGER NOT NULL DEFAULT 500, expires_at TEXT,
    revoked_at TEXT, created_at TEXT NOT NULL, last_used_at TEXT
  );
  CREATE TABLE mcl_api_usage (
    key_id INTEGER NOT NULL, bucket_start TEXT NOT NULL,
    used_tokens INTEGER NOT NULL DEFAULT 0,
    reserved_tokens INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(key_id, bucket_start)
  );
  INSERT INTO mcl_api_keys (id, owner_id, name, key_prefix, key_hash, rate_limit_tpm, created_at)
    VALUES (7, 'owner', 'legacy', 'mcl_live_old', 'oldhash', 500, '2026-01-01 00:00:00');
  INSERT INTO mcl_api_usage (key_id, bucket_start, used_tokens, reserved_tokens, request_count)
    VALUES (7, '2026-11-16 12:00:00', 123, 0, 1);`);

  database.exec(fs.readFileSync(path.join(root, 'D1-migration.sql'), 'utf8'));
  const key = database.prepare('SELECT id, rate_limit_tpm, rate_limit_mode, model_rate_limits_json FROM mcl_api_keys WHERE id = 7').get();
  const usage = database.prepare('SELECT used_tokens FROM mcl_api_usage WHERE key_id = 7').get();
  const modelUsageTable = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcl_api_model_usage'").get();

  assert.equal(Number(key.id), 7);
  assert.equal(Number(key.rate_limit_tpm), 500);
  assert.equal(key.rate_limit_mode, 'fixed');
  assert.equal(key.model_rate_limits_json, null);
  assert.equal(Number(usage.used_tokens), 123);
  assert.equal(modelUsageTable.name, 'mcl_api_model_usage');
});
