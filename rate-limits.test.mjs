import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  MODEL_MAX_TPM,
  normalizeModel,
  upstreamModelForModel,
  requestWithInferenceKeys,
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

test('per-model limits parse safely and match the MineCodeLabs public catalog', () => {
  assert.deepEqual(Object.keys(MODEL_MAX_TPM), [
    'mclai/gpt-oss-20b',
    'mclai/gpt-oss-120b',
    'mclai/gpt-oss-safeguard-20b',
    'mclai/qwen3.8-27b',
    'mclai/minimax-m2.7',
    'mclai/muse-spark-open',
  ]);
  const limits = parseModelLimits(JSON.stringify(MODEL_MAX_TPM));
  assert.deepEqual(limits, MODEL_MAX_TPM);
  assert.equal(keyLimitForModel({
    rate_limit_mode: 'per_model',
    model_rate_limits_json: JSON.stringify(MODEL_MAX_TPM),
  }, 'mclai/qwen3.8-27b'), 6880);
  assert.equal(keyLimitForModel({
    rate_limit_mode: 'per_model',
    model_rate_limits_json: '{broken json',
  }, 'mclai/gpt-oss-20b'), 0);
  assert.equal(parseModelLimits({ 'mclai/gpt-oss-20b': 7001 }), null);
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

  const oss = await reserveUsage(env, 1, bucketStart, 6500, MODEL_MAX_TPM['mclai/gpt-oss-20b'], 'mclai/gpt-oss-20b');
  assert.equal(oss.ok, true);
  const ossRejected = await reserveUsage(env, 1, bucketStart, 600, MODEL_MAX_TPM['mclai/gpt-oss-20b'], 'mclai/gpt-oss-20b');
  assert.equal(ossRejected.ok, false);
  assert.equal(ossRejected.remaining, 500);

  const qwen = await reserveUsage(env, 1, bucketStart, 6500, MODEL_MAX_TPM['mclai/qwen3.8-27b'], 'mclai/qwen3.8-27b');
  assert.equal(qwen.ok, true);
  assert.equal(qwen.remaining, 380);

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


test('public model aliases map to their configured upstream IDs', () => {
  assert.equal(upstreamModelForModel('mclai/gpt-oss-20b'), 'openai/gpt-oss-20b');
  assert.equal(upstreamModelForModel('mclai/gpt-oss-120b'), 'openai/gpt-oss-120b');
  assert.equal(upstreamModelForModel('mclai/gpt-oss-safeguard-20b'), 'openai/gpt-oss-safeguard-20b');
  assert.equal(upstreamModelForModel('mclai/qwen3.8-27b'), 'qwen/qwen3.8-27b');
  assert.equal(upstreamModelForModel('mclai/minimax-m2.7'), 'minimaxai/minimax-m2.7');
  assert.equal(upstreamModelForModel('mclai/muse-spark-open'), 'meta-models/muse-spark-open');
  assert.equal(normalizeModel('minimaxai/minimax-m2.7'), 'mclai/minimax-m2.7');
  assert.equal(normalizeModel('meta-models/muse-spark-open'), 'mclai/muse-spark-open');
  assert.equal(normalizeModel('openai/gpt-oss-20b'), 'mclai/gpt-oss-20b');
  assert.equal(normalizeModel('qwen/qwen3.6-27b'), 'mclai/qwen3.8-27b');
  assert.equal(upstreamModelForModel('groq/compound'), null);
});

test('legacy per-model key limits normalize without discarding supported models', () => {
  const limits = parseModelLimits({
    'openai/gpt-oss-20b': 6500,
    'openai/gpt-oss-120b': 6400,
    'groq/compound': 64000,
    'groq/compound-mini': 68000,
    'openai/gpt-oss-safeguard-20b': 6500,
    'qwen/qwen3.6-27b': 6400,
  });
  assert.deepEqual(limits, {
    'mclai/gpt-oss-20b': 6500,
    'mclai/gpt-oss-120b': 6400,
    'mclai/gpt-oss-safeguard-20b': 6500,
    'mclai/qwen3.8-27b': 6400,
  });
});


test('inference request uses the upstream slug and retries with the secondary configured key', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, authorization: options.headers.authorization, body: JSON.parse(options.body) });
    if (calls.length === 1) return new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  try {
    const publicModel = 'mclai/gpt-oss-120b';
    const mappedModel = upstreamModelForModel(publicModel);
    assert.equal(mappedModel, 'openai/gpt-oss-120b');
    const result = await requestWithInferenceKeys({
      MCL_GROQ_API_KEY: 'primary-test-key',
      MCL_GROQ_API_KEY_2: 'secondary-test-key',
    }, { model: mappedModel, messages: [{ role: 'user', content: 'test' }] });
    assert.equal(result.response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].authorization, 'Bearer primary-test-key');
    assert.equal(calls[1].authorization, 'Bearer secondary-test-key');
    assert.equal(calls[1].body.model, 'openai/gpt-oss-120b');
    assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('model-slug migration aggregates old usage into public aliases and is safe to rerun', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  const insert = database.prepare(`INSERT INTO mcl_api_model_usage
    (key_id, model_id, bucket_start, used_tokens, reserved_tokens, request_count)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run(1, 'openai/gpt-oss-20b', '2026-11-17 10:00:00', 20, 3, 1);
  insert.run(1, 'mclai/gpt-oss-20b', '2026-11-17 10:00:00', 5, 1, 1);
  insert.run(1, 'groq/compound', '2026-11-17 10:00:00', 9, 0, 1);
  const migration = fs.readFileSync(path.join(root, 'model-slug-migration.sql'), 'utf8');
  database.exec(migration);
  database.exec(migration);
  const rows = database.prepare('SELECT model_id, used_tokens, reserved_tokens, request_count FROM mcl_api_model_usage ORDER BY model_id').all();
  assert.equal(rows.length, 2);
  const migrated = rows.find((row) => row.model_id === 'mclai/gpt-oss-20b');
  const retired = rows.find((row) => row.model_id === 'groq/compound');
  assert.equal(Number(migrated.used_tokens), 25);
  assert.equal(Number(migrated.reserved_tokens), 4);
  assert.equal(Number(migrated.request_count), 2);
  assert.equal(Number(retired.used_tokens), 9);
});
