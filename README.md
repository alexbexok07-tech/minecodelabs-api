# MineCodeLabs Cloudflare Worker — release 1.3.0

This folder contains the matching Cloudflare Worker source for the website bundle. It updates the live `/api/text` route, the `/_mcl_admin/*` key-sync routes, and D1 usage accounting for the expanded API-key TPM controls.

## What changed

- Fixed keys keep one shared per-key minute bucket and accept the configured TPM value up to 8,000. Existing lower-limit keys (including old 500 TPM keys) remain valid.
- `Max As Per Model` keys use separate D1 minute buckets for each model. Requests on one model do not consume another model's quota.
- The Worker validates stored model limits against the MineCodeLabs ceilings below and fails closed when a model limit is missing or malformed.
- Reservations use a conditional SQLite upsert before the provider request, preventing concurrent requests from reserving beyond the active bucket's remaining TPM.
- The admin create/update routes sync `rate_limit_mode` and `model_rate_limits_json` into D1.
- `/_mcl_admin/list` returns live per-model usage for the key manager, and `/_mcl_admin/health` checks the D1 schema.

## MineCodeLabs per-model ceilings

| Model ID | Maximum TPM |
|---|---:|
| `openai/gpt-oss-20b` | 7,000 |
| `openai/gpt-oss-120b` | 6,800 |
| `groq/compound` | 64,000 |
| `groq/compound-mini` | 68,000 |
| `openai/gpt-oss-safeguard-20b` | 6,980 |
| `qwen/qwen3.6-27b` | 6,880 |

These values are MineCodeLabs API-key ceilings, not Groq organization-level limits and not the per-response `max_tokens` setting. `max_tokens` remains a separate response setting, clamped by the existing API to 1–1,024.

## Upgrade an existing Worker

1. Back up/export the existing Cloudflare D1 database.
2. From the existing Worker project, run the D1 migration against the same remote database configured by your existing `DB` binding:

   ```bash
   npx wrangler d1 execute YOUR_EXISTING_D1_DATABASE_NAME --remote --file=worker-upgrade/D1-migration.sql
   ```

   Run this migration **once only** on the existing database. Do not run it if you have already applied the two column additions and created `mcl_api_model_usage`.
3. Replace the Worker entrypoint configured in your existing `wrangler.jsonc` with the included `index.js`. Keep your existing `wrangler.jsonc`, account/database identifiers, routes, and D1 binding unchanged; the binding name must remain `DB`.
4. Preserve the existing Worker secrets. Required secrets are `MCL_ADMIN_SECRET` and `MCL_GROQ_API_KEY` (plus any other secrets your deployment already uses). Do not put secret values in this ZIP or commit them to source control.
5. Deploy from the existing Worker project directory:

   ```bash
   npx wrangler deploy
   ```
6. Verify the Worker and upgraded D1 schema. The health endpoint is admin-protected:

   ```bash
   curl -X POST "https://api.mclab.workers.dev/_mcl_admin/health" \
     -H "Authorization: Bearer $MCL_ADMIN_SECRET" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```

   A successful result contains `"success":true` and `"database_connected":true`.
7. Upload the updated website `developers/` directory. The PHP key manager automatically adds the required MySQL columns and table. Keep `db_config.php` and `mcl_api_config.php` outside the uploaded archive.
8. Open the API key manager and create a new test key. Test both a fixed key and a `Max As Per Model` key using the documented `/api/text` endpoint.

For a brand-new D1 database, use `schema.sql` instead of `D1-migration.sql`.

## Compatibility

- Existing D1 key rows receive `rate_limit_mode = 'fixed'` from the migration default. Existing key hashes, IDs, expiry, revoke state and usage rows are preserved.
- Fixed keys continue to use `mcl_api_usage`; per-model keys use `mcl_api_model_usage`.
- The six model IDs and the public text endpoint remain unchanged.
- The Worker does not increase Groq's upstream organization limits. Groq may still return its own provider rate-limit error even when a MineCodeLabs key has quota remaining.

## Local checks

From the Developer Hub root:

```bash
node --check worker-upgrade/index.js
node --test worker-upgrade/test/*.test.mjs
npm test
```

The local tests exercise the D1 SQL against SQLite and check the per-model quota isolation. They do not replace a live Cloudflare deployment test.
