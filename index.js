// Public model namespace. Upstream identifiers stay server-side and are never
// required in customer requests or SDK configuration.
export const UPSTREAM_MODEL_BY_PUBLIC_ID = Object.freeze({
  'mclai/gpt-oss-20b': 'openai/gpt-oss-20b',
  'mclai/gpt-oss-120b': 'openai/gpt-oss-120b',
  'mclai/gpt-oss-safeguard-20b': 'openai/gpt-oss-safeguard-20b',
  'mclai/qwen3.8-27b': 'qwen/qwen3.8-27b',
});

const MODELS = Object.keys(UPSTREAM_MODEL_BY_PUBLIC_ID);

// MineCodeLabs per-key ceilings. These are product-level TPM policies, not
// the upstream inference account's organization limits.
export const MODEL_MAX_TPM = Object.freeze({
  'mclai/gpt-oss-20b': 7000,
  'mclai/gpt-oss-120b': 6800,
  'mclai/gpt-oss-safeguard-20b': 6980,
  'mclai/qwen3.8-27b': 6880,
});

const LEGACY_MODEL_ALIASES = Object.freeze({
  'gpt-oss-20b': 'mclai/gpt-oss-20b',
  'openai/gpt-oss-20b': 'mclai/gpt-oss-20b',
  'gpt-oss-120b': 'mclai/gpt-oss-120b',
  'openai/gpt-oss-120b': 'mclai/gpt-oss-120b',
  'gpt-oss-safeguard-20b': 'mclai/gpt-oss-safeguard-20b',
  'openai/gpt-oss-safeguard-20b': 'mclai/gpt-oss-safeguard-20b',
  'qwen3.8-27b': 'mclai/qwen3.8-27b',
  'qwen/qwen3.8-27b': 'mclai/qwen3.8-27b',
  // Backward compatibility for the model's retired predecessor.
  'qwen3.6-27b': 'mclai/qwen3.8-27b',
  'qwen/qwen3.6-27b': 'mclai/qwen3.8-27b',
});

const RETIRED_MODEL_IDS = new Set([
  'groq/compound',
  'groq/compound-mini',
  'mclai/compound',
  'mclai/compound-mini',
  'compound',
  'compound-mini',
]);

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...headers,
  },
});

const fail = (status, code, message, extra = {}) =>
  json({ success: false, error: { code, message, ...extra } }, status);

const sha256 = async (value) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const now = () => new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
const bucket = () => `${new Date().toISOString().slice(0, 16).replace('T', ' ')}:00`;
const resetIn = () => 60 - new Date().getUTCSeconds();

function authKey(request) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return new URL(request.url).searchParams.get('key')?.trim() || null;
}

function isAdmin(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return Boolean(env.MCL_ADMIN_SECRET && token && token === env.MCL_ADMIN_SECRET);
}

export function normalizeModel(model) {
  const value = String(model || '').trim();
  return LEGACY_MODEL_ALIASES[value] || value;
}

export function upstreamModelForModel(model) {
  return UPSTREAM_MODEL_BY_PUBLIC_ID[normalizeModel(model)] || null;
}

export function isRetiredModel(model) {
  return RETIRED_MODEL_IDS.has(String(model || '').trim());
}

export async function requestWithInferenceKeys(env, payload) {
  const keys = [...new Set([
    env.MCL_INFERENCE_API_KEY,
    env.MCL_GROQ_API_KEY,       // Existing deployment secret name; retained for compatibility.
    env.MCL_GROQ_API_KEY_2,     // Optional secondary key from the previous deployment.
  ].filter((value) => typeof value === 'string' && value.trim()))];
  if (!keys.length) return { response: null, networkError: true };

  let lastResponse = null;
  let networkError = null;
  for (let i = 0; i < keys.length; i += 1) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${keys[i]}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      lastResponse = response;
      const retryable = [401, 403, 429, 500, 502, 503, 504].includes(response.status);
      if (response.ok || !retryable || i === keys.length - 1) {
        return { response, networkError: null };
      }
      try { await response.body?.cancel(); } catch { /* best effort */ }
    } catch (error) {
      networkError = error;
      if (i === keys.length - 1) return { response: null, networkError };
    }
  }
  return { response: lastResponse, networkError };
}

export function parseModelLimits(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const limits = {};
  for (const [storedModel, rawLimit] of Object.entries(parsed)) {
    if (isRetiredModel(storedModel)) continue;
    const model = normalizeModel(storedModel);
    const ceiling = MODEL_MAX_TPM[model];
    const limit = Number(rawLimit);
    if (!ceiling || !Number.isSafeInteger(limit) || limit < 1 || limit > ceiling) return null;
    if (Object.hasOwn(limits, model)) limits[model] = Math.min(limits[model], limit);
    else limits[model] = limit;
  }
  return Object.keys(limits).length ? limits : null;
}

export function keyLimitForModel(key, model) {
  model = normalizeModel(model);
  if ((key.rate_limit_mode || 'fixed') !== 'per_model') {
    const limit = Number(key.rate_limit_tpm);
    return Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  }
  const limits = parseModelLimits(key.model_rate_limits_json);
  return limits ? Number(limits[model] || 0) : 0;
}

async function keyRow(env, rawKey) {
  if (!/^mcl_live_[A-Za-z0-9]+$/.test(rawKey || '')) return null;
  return env.DB.prepare('SELECT * FROM mcl_api_keys WHERE key_hash = ? LIMIT 1')
    .bind(await sha256(rawKey)).first();
}

async function readUsage(env, table, id, bucketStart, model = null) {
  const query = model
    ? env.DB.prepare(`SELECT used_tokens, reserved_tokens, request_count FROM ${table} WHERE key_id = ? AND model_id = ? AND bucket_start = ?`).bind(id, model, bucketStart)
    : env.DB.prepare(`SELECT used_tokens, reserved_tokens, request_count FROM ${table} WHERE key_id = ? AND bucket_start = ?`).bind(id, bucketStart);
  return await query.first() || { used_tokens: 0, reserved_tokens: 0, request_count: 0 };
}

/**
 * Atomically reserve tokens using one conditional SQLite upsert. A failed
 * conditional update returns no row, avoiding select-then-increment races.
 */
export async function reserveUsage(env, keyId, bucketStart, reservation, limit, model = null) {
  const amount = Math.max(0, Math.trunc(reservation));
  const table = model ? 'mcl_api_model_usage' : 'mcl_api_usage';
  if (amount > limit) {
    const current = await readUsage(env, table, keyId, bucketStart, model);
    const used = Number(current.used_tokens || 0);
    const reservedTokens = Number(current.reserved_tokens || 0);
    return { ok: false, used, reserved: reservedTokens, remaining: Math.max(0, limit - used - reservedTokens) };
  }
  const insert = model
    ? env.DB.prepare(`INSERT INTO mcl_api_model_usage
        (key_id, model_id, bucket_start, used_tokens, reserved_tokens, request_count)
        VALUES (?, ?, ?, 0, ?, 0)
        ON CONFLICT(key_id, model_id, bucket_start) DO UPDATE
        SET reserved_tokens = reserved_tokens + excluded.reserved_tokens
        WHERE used_tokens + reserved_tokens + excluded.reserved_tokens <= ?
        RETURNING used_tokens, reserved_tokens`)
      .bind(keyId, model, bucketStart, amount, limit)
    : env.DB.prepare(`INSERT INTO mcl_api_usage
        (key_id, bucket_start, used_tokens, reserved_tokens, request_count)
        VALUES (?, ?, 0, ?, 0)
        ON CONFLICT(key_id, bucket_start) DO UPDATE
        SET reserved_tokens = reserved_tokens + excluded.reserved_tokens
        WHERE used_tokens + reserved_tokens + excluded.reserved_tokens <= ?
        RETURNING used_tokens, reserved_tokens`)
      .bind(keyId, bucketStart, amount, limit);

  const reserved = await insert.first();
  if (reserved) {
    const used = Number(reserved.used_tokens || 0);
    const reservedTokens = Number(reserved.reserved_tokens || 0);
    return {
      ok: true,
      used,
      reserved: reservedTokens,
      remaining: Math.max(0, limit - used - reservedTokens),
    };
  }

  const current = await readUsage(env, table, keyId, bucketStart, model);
  const used = Number(current.used_tokens || 0);
  const reservedTokens = Number(current.reserved_tokens || 0);
  return {
    ok: false,
    used,
    reserved: reservedTokens,
    remaining: Math.max(0, limit - used - reservedTokens),
  };
}

export async function releaseUsage(env, keyId, bucketStart, reservation, model = null) {
  const amount = Math.max(0, Math.trunc(reservation));
  if (model) {
    await env.DB.prepare(`UPDATE mcl_api_model_usage
      SET reserved_tokens = MAX(0, reserved_tokens - ?)
      WHERE key_id = ? AND model_id = ? AND bucket_start = ?`)
      .bind(amount, keyId, model, bucketStart).run();
    return;
  }
  await env.DB.prepare(`UPDATE mcl_api_usage
    SET reserved_tokens = MAX(0, reserved_tokens - ?)
    WHERE key_id = ? AND bucket_start = ?`)
    .bind(amount, keyId, bucketStart).run();
}

export async function finalizeUsage(env, keyId, bucketStart, reservation, actual, model = null) {
  const statements = [];
  const reserved = Math.max(0, Math.trunc(reservation));
  const used = Math.max(0, Math.trunc(actual));
  if (model) {
    statements.push(env.DB.prepare(`UPDATE mcl_api_model_usage
      SET reserved_tokens = MAX(0, reserved_tokens - ?),
          used_tokens = used_tokens + ?, request_count = request_count + 1
      WHERE key_id = ? AND model_id = ? AND bucket_start = ?`)
      .bind(reserved, used, keyId, model, bucketStart));
  } else {
    statements.push(env.DB.prepare(`UPDATE mcl_api_usage
      SET reserved_tokens = MAX(0, reserved_tokens - ?),
          used_tokens = used_tokens + ?, request_count = request_count + 1
      WHERE key_id = ? AND bucket_start = ?`)
      .bind(reserved, used, keyId, bucketStart));
  }
  statements.push(env.DB.prepare('UPDATE mcl_api_keys SET last_used_at = ? WHERE id = ?').bind(now(), keyId));
  await env.DB.batch(statements);
}

async function rateLimitState(env, key, model, bucketStart) {
  const perModel = (key.rate_limit_mode || 'fixed') === 'per_model';
  const limit = keyLimitForModel(key, model);
  const usage = await readUsage(
    env,
    perModel ? 'mcl_api_model_usage' : 'mcl_api_usage',
    key.id,
    bucketStart,
    perModel ? model : null,
  );
  const used = Number(usage.used_tokens || 0);
  const reserved = Number(usage.reserved_tokens || 0);
  return {
    mode: perModel ? 'per_model' : 'fixed',
    model,
    limit,
    used,
    reserved,
    remaining: Math.max(0, limit - used - reserved),
    reset_in: resetIn(),
  };
}

async function text(request, env) {
  if (!env.DB || !(env.MCL_INFERENCE_API_KEY || env.MCL_GROQ_API_KEY || env.MCL_GROQ_API_KEY_2)) {
    return fail(503, 'AI_CONFIGURATION_ERROR', 'MineCodeLabs AI is not configured yet.');
  }

  const rawKey = authKey(request);
  if (!rawKey) return fail(401, 'MISSING_API_KEY', 'Provide your MineCodeLabs API key as a Bearer token or ?key=.');

  const key = await keyRow(env, rawKey);
  if (!key) return fail(401, 'INVALID_API_KEY', 'The API key is invalid or has been revoked.');
  if (key.revoked_at) return fail(401, 'KEY_REVOKED', 'This API key has been revoked.');
  if (key.expires_at && Date.parse(`${key.expires_at}Z`) <= Date.now()) {
    return fail(401, 'KEY_EXPIRED', 'This API key has expired.');
  }

  let prompt = '';
  let model = '';
  let maxTokens = 256;
  let temperature = null;
  const url = new URL(request.url);

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch {
      return fail(400, 'INVALID_JSON', 'Request body must contain valid JSON.');
    }
    prompt = String(body.prompt || '').trim();
    model = String(body.model || '').trim();
    if (body.max_tokens !== undefined) maxTokens = Number(body.max_tokens);
    if (body.temperature !== undefined && body.temperature !== null) temperature = Number(body.temperature);
  } else {
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    const match = path.match(/(?:^|\/)text\/(.*?)\/model\/(.+)$/);
    if (match) {
      prompt = decodeURIComponent(match[1]);
      model = decodeURIComponent(match[2]);
    }
    if (!prompt) prompt = url.searchParams.get('prompt') || '';
    if (!model) model = url.searchParams.get('model') || '';
    if (url.searchParams.has('max_tokens')) maxTokens = Number(url.searchParams.get('max_tokens'));
    if (url.searchParams.has('temperature')) temperature = Number(url.searchParams.get('temperature'));
  }

  prompt = prompt.trim();
  const requestedModel = model.trim() || 'mclai/gpt-oss-20b';
  if (isRetiredModel(requestedModel)) {
    return fail(410, 'MODEL_RETIRED', 'This model is no longer available. Select one of the currently supported MineCodeLabs models.', { available_models: MODELS });
  }
  model = normalizeModel(requestedModel);
  if (!prompt) return fail(400, 'INVALID_PROMPT', 'A prompt is required.');
  if (prompt.length > 20000) return fail(413, 'PROMPT_TOO_LARGE', 'The prompt is too large for this endpoint.');
  if (!MODELS.includes(model)) {
    return fail(400, 'INVALID_MODEL', 'That model is not available through the MineCodeLabs API.', { available_models: MODELS });
  }

  if (!Number.isFinite(maxTokens)) maxTokens = 256;
  maxTokens = Math.max(1, Math.min(1024, Math.trunc(maxTokens) || 256));
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    return fail(400, 'INVALID_TEMPERATURE', 'Temperature must be between 0 and 2.');
  }

  const perModel = (key.rate_limit_mode || 'fixed') === 'per_model';
  if (!['fixed', 'per_model'].includes(key.rate_limit_mode || 'fixed')) {
    return fail(403, 'KEY_CONFIGURATION_ERROR', 'This API key has an unsupported rate-limit mode.');
  }
  const limit = keyLimitForModel(key, model);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return fail(403, 'MODEL_NOT_ALLOWED_FOR_KEY', 'This API key has no valid TPM allowance configured for the selected model.');
  }

  const bucketStart = bucket();
  const estimatedPromptTokens = Math.max(1, Math.ceil(prompt.length / 4));
  const reservation = estimatedPromptTokens + maxTokens;
  const reserved = await reserveUsage(env, key.id, bucketStart, reservation, limit, perModel ? model : null);
  if (!reserved.ok) {
    return fail(429, 'RATE_LIMITED', 'Rate limit reached.', {
      mode: perModel ? 'per_model' : 'fixed',
      model,
      limit,
      used: reserved.used,
      remaining: reserved.remaining,
      reset_in: resetIn(),
    });
  }

  const upstreamModel = upstreamModelForModel(model);
  if (!upstreamModel) {
    await releaseUsage(env, key.id, bucketStart, reservation, perModel ? model : null);
    return fail(400, 'INVALID_MODEL', 'That model is not available through the MineCodeLabs API.', { available_models: MODELS });
  }

  let providerResponse;
  try {
    const result = await requestWithInferenceKeys(env, {
      model: upstreamModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      ...(temperature !== null ? { temperature } : {}),
    });
    providerResponse = result.response;
    if (!providerResponse) throw result.networkError || new Error('No inference response');
  } catch {
    await releaseUsage(env, key.id, bucketStart, reservation, perModel ? model : null);
    return fail(502, 'AI_PROVIDER_UNAVAILABLE', 'MineCodeLabs AI is temporarily unavailable. Please try again later.');
  }

  let provider;
  try { provider = await providerResponse.json(); } catch {
    await releaseUsage(env, key.id, bucketStart, reservation, perModel ? model : null);
    return fail(502, 'AI_PROVIDER_ERROR', 'MineCodeLabs AI returned an unexpected response.');
  }

  if (!providerResponse.ok) {
    await releaseUsage(env, key.id, bucketStart, reservation, perModel ? model : null);
    const message = String(provider?.error?.message || '').toLowerCase();
    if (providerResponse.status === 429 || message.includes('rate limit') || message.includes('rate_limit')) {
      return fail(502, 'AI_PROVIDER_RATE_LIMITED', 'MineCodeLabs AI is temporarily busy. Please try again later.', {
        provider_status: 429,
        retry_after: provider?.error?.retry_after ?? null,
      });
    }
    if (providerResponse.status === 401 || providerResponse.status === 403) {
      return fail(502, 'AI_CONFIGURATION_ERROR', 'MineCodeLabs AI could not authenticate its inference request.');
    }
    if (providerResponse.status === 400) {
      return fail(400, 'AI_REQUEST_REJECTED', 'MineCodeLabs AI could not process this request.', {
        provider_code: provider?.error?.code || null,
      });
    }
    return fail(502, 'AI_PROVIDER_ERROR', 'MineCodeLabs AI is temporarily unavailable. Please try again later.');
  }

  const output = String(provider?.choices?.[0]?.message?.content || '');
  if (!output) {
    await releaseUsage(env, key.id, bucketStart, reservation, perModel ? model : null);
    return fail(502, 'EMPTY_AI_RESPONSE', 'MineCodeLabs AI returned an empty response.');
  }

  const providerUsage = provider?.usage || {};
  const actualTokens = Number(providerUsage.total_tokens) ||
    estimatedPromptTokens + Number(providerUsage.completion_tokens || 0);
  await finalizeUsage(env, key.id, bucketStart, reservation, actualTokens, perModel ? model : null);
  const state = await rateLimitState(env, key, model, bucketStart);

  return json({
    success: true,
    model,
    response: output,
    usage: {
      prompt_tokens: Number(providerUsage.prompt_tokens) || estimatedPromptTokens,
      completion_tokens: Number(providerUsage.completion_tokens) || 0,
      total_tokens: actualTokens,
    },
    rate_limit: {
      mode: state.mode,
      model: state.model,
      limit: state.limit,
      used: state.used,
      remaining: state.remaining,
      reset_in: state.reset_in,
    },
  }, 200, {
    'X-MineCodeLabs-RateLimit-Limit': String(state.limit),
    'X-MineCodeLabs-RateLimit-Remaining': String(state.remaining),
    'X-MineCodeLabs-RateLimit-Reset': String(state.reset_in),
  });
}

function validateKeyPayload(key) {
  if (!key || typeof key !== 'object' || !key.key_hash || !key.owner_id || !key.name) {
    return { ok: false, error: 'Missing required key data.' };
  }
  const mode = key.rate_limit_mode || 'fixed';
  if (!['fixed', 'per_model'].includes(mode)) return { ok: false, error: 'Invalid rate-limit mode.' };

  if (mode === 'fixed') {
    const limit = Number(key.rate_limit_tpm);
    // Existing legacy keys (e.g. 500 TPM) remain valid; the manager now offers
    // choices from 428 through 8,000 TPM for newly-created keys.
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8000) {
      return { ok: false, error: 'Fixed TPM must be between 1 and 8,000.' };
    }
    return { ok: true, mode, limit, modelLimitsJson: null };
  }

  const limits = parseModelLimits(key.model_rate_limits_json);
  if (!limits) return { ok: false, error: 'Per-model TPM configuration is missing or invalid.' };
  return {
    ok: true,
    mode,
    limit: Math.max(...Object.values(limits)),
    modelLimitsJson: JSON.stringify(limits),
  };
}

async function readLiveKeyUsage(env, key, bucketStart) {
  if ((key.rate_limit_mode || 'fixed') !== 'per_model') {
    const usage = await readUsage(env, 'mcl_api_usage', key.id, bucketStart);
    const limit = Number(key.rate_limit_tpm);
    const used = Number(usage.used_tokens || 0);
    const reserved = Number(usage.reserved_tokens || 0);
    return {
      mode: 'fixed',
      limit,
      used,
      reserved,
      remaining: Math.max(0, limit - used - reserved),
      reset_in: resetIn(),
    };
  }

  const limits = parseModelLimits(key.model_rate_limits_json) || {};
  const rows = await env.DB.prepare(`SELECT model_id, used_tokens, reserved_tokens, request_count
    FROM mcl_api_model_usage WHERE key_id = ? AND bucket_start = ?`)
    .bind(key.id, bucketStart).all();
  const usageByModel = {};
  for (const row of rows.results || []) {
    usageByModel[row.model_id] = row;
  }

  const models = {};
  for (const [model, limit] of Object.entries(limits)) {
    const usage = usageByModel[model] || { used_tokens: 0, reserved_tokens: 0 };
    const used = Number(usage.used_tokens || 0);
    const reserved = Number(usage.reserved_tokens || 0);
    models[model] = {
      limit,
      used,
      reserved,
      remaining: Math.max(0, limit - used - reserved),
    };
  }
  return { mode: 'per_model', models, reset_in: resetIn() };
}

async function admin(request, env) {
  if (!isAdmin(request, env)) return fail(403, 'FORBIDDEN', 'Admin authorization failed.');
  const path = new URL(request.url).pathname;
  let body = {};
  try { body = await request.json(); } catch { /* empty object for routes without a body */ }

  if (path.endsWith('/health')) {
    try {
      const tableNames = ['mcl_api_keys', 'mcl_api_usage', 'mcl_api_model_usage'];
      const found = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)`)
        .bind(...tableNames).all();
      const tables = new Set((found.results || []).map((row) => row.name));
      const columnsResult = await env.DB.prepare('PRAGMA table_info(mcl_api_keys)').all();
      const columns = new Set((columnsResult.results || []).map((row) => row.name));
      const missingTables = tableNames.filter((name) => !tables.has(name));
      const missingColumns = ['rate_limit_mode', 'model_rate_limits_json'].filter((name) => !columns.has(name));
      if (missingTables.length || missingColumns.length) {
        return fail(503, 'D1_SCHEMA_NOT_READY', 'Apply the MineCodeLabs Worker schema migration first.', {
          database_connected: true,
          missing_tables: missingTables,
          missing_columns: missingColumns,
        });
      }
      return json({ success: true, database_connected: true, schema_version: '1.4.0' });
    } catch {
      return fail(503, 'D1_UNAVAILABLE', 'The Worker could not query its D1 database.');
    }
  }

  if (path.endsWith('/list')) {
    const owner = String(body.owner_id || '');
    const result = await env.DB.prepare('SELECT * FROM mcl_api_keys WHERE owner_id = ? ORDER BY created_at DESC')
      .bind(owner).all();
    const keys = [];
    for (const key of result.results || []) {
      keys.push({
        ...key,
        live_usage: await readLiveKeyUsage(env, key, bucket()),
      });
    }
    return json({ success: true, keys });
  }

  if (path.endsWith('/create')) {
    const key = body.key;
    const validated = validateKeyPayload(key);
    if (!validated.ok) return fail(400, 'INVALID_KEY', validated.error);
    await env.DB.prepare(`INSERT INTO mcl_api_keys
      (id, owner_id, name, key_prefix, key_hash, rate_limit_tpm, rate_limit_mode,
       model_rate_limits_json, expires_at, revoked_at, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner_id = excluded.owner_id,
        name = excluded.name,
        key_prefix = excluded.key_prefix,
        key_hash = excluded.key_hash,
        rate_limit_tpm = excluded.rate_limit_tpm,
        rate_limit_mode = excluded.rate_limit_mode,
        model_rate_limits_json = excluded.model_rate_limits_json,
        expires_at = excluded.expires_at,
        revoked_at = excluded.revoked_at,
        last_used_at = excluded.last_used_at`)
      .bind(
        key.id ?? null,
        key.owner_id,
        key.name,
        key.key_prefix,
        key.key_hash,
        validated.limit,
        validated.mode,
        validated.modelLimitsJson,
        key.expires_at ?? null,
        key.revoked_at ?? null,
        key.created_at || now(),
        key.last_used_at ?? null,
      ).run();
    return json({ success: true });
  }

  if (path.endsWith('/update')) {
    const key = body.key;
    if (!key?.id || !key?.owner_id) return fail(400, 'INVALID_KEY', 'Missing key ID or owner.');
    const validated = validateKeyPayload({
      ...key,
      key_hash: 'existing-key-hash',
      key_prefix: 'existing',
    });
    if (!validated.ok) return fail(400, 'INVALID_KEY', validated.error);
    await env.DB.prepare(`UPDATE mcl_api_keys SET
      name = ?, rate_limit_tpm = ?, rate_limit_mode = ?, model_rate_limits_json = ?,
      expires_at = ?, revoked_at = ?
      WHERE id = ? AND owner_id = ?`)
      .bind(
        key.name,
        validated.limit,
        validated.mode,
        validated.modelLimitsJson,
        key.expires_at ?? null,
        key.revoked_at ?? null,
        key.id,
        key.owner_id,
      ).run();
    return json({ success: true });
  }

  if (path.endsWith('/usage')) {
    const usage = body.usage;
    if (!usage) return fail(400, 'INVALID_USAGE', 'Missing usage data.');
    await env.DB.prepare(`INSERT INTO mcl_api_usage
      (key_id, bucket_start, used_tokens, reserved_tokens, request_count)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key_id, bucket_start) DO UPDATE SET
        used_tokens = excluded.used_tokens,
        reserved_tokens = excluded.reserved_tokens,
        request_count = excluded.request_count`)
      .bind(
        usage.key_id,
        usage.bucket_start,
        usage.used_tokens,
        usage.reserved_tokens,
        usage.request_count,
      ).run();
    return json({ success: true });
  }

  return fail(404, 'NOT_FOUND', 'Unknown admin endpoint.');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'Content-Type, Authorization',
        },
      });
    }

    const path = new URL(request.url).pathname;
    if (path.startsWith('/_mcl_admin/')) {
      if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Use POST for admin endpoints.');
      return admin(request, env);
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return fail(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
    }
    return text(request, env);
  },
};
