# MineCodeLabs API — Cloudflare Worker (dual Groq-key failover)

Worker URL: `https://api.mclab.workers.dev`

## Dual-key failover

The Worker supports two independent Groq API keys:

- `MCL_GROQ_API_KEY` — primary key
- `MCL_GROQ_API_KEY_2` — secondary key

The Worker tries the primary first. It tries the secondary only after a retryable provider failure:
- HTTP 401 / 403 (credential or permission failure)
- HTTP 429 (provider rate limit)
- HTTP 5xx (provider/server failure)
- Network/fetch failure

It does **not** retry HTTP 400 or 404: those normally indicate an invalid request or unavailable model, which a second credential cannot fix.

On success, the API response keeps the existing shape and includes `failover_used: true|false`. API users do not need to change their requests.

The Worker never returns or logs either key. Keep both values in Cloudflare Worker Secrets, never in GitHub, `index.js`, `wrangler.jsonc`, PHP, or browser code. Using two keys from different Groq organisations may reduce shared-organisation quota contention, but provider/model-level limits can still apply.

## 1. D1 database

`wrangler.jsonc` binds D1 as `DB` and references database ID
`cf2ef7f6-a574-45ad-a838-739e85b5e5d9`. Confirm that this database exists in the
Cloudflare account you deploy from. If the ID is not yours, create/select the
correct `minecodelabs-api` database and update `database_id`.

Apply `schema.sql` to the intended remote database:

```bash
npx wrangler d1 execute minecodelabs-api --remote --file=./schema.sql
```

Do not create a duplicate database if the configured one already holds your
production API key records.

## 2. Add Worker secrets

Cloudflare Dashboard → Workers & Pages → `api` → Settings → Variables and Secrets
→ Add → Secret.

Create these three secrets:

| Secret name | Value |
|---|---|
| `MCL_GROQ_API_KEY` | Primary Groq API key (organisation 1) |
| `MCL_GROQ_API_KEY_2` | Secondary Groq API key (different organisation) |
| `MCL_ADMIN_SECRET` | Long random secret shared only with the PHP website |

You can also add them using Wrangler from this repository directory:

```bash
npx wrangler secret put MCL_GROQ_API_KEY
npx wrangler secret put MCL_GROQ_API_KEY_2
npx wrangler secret put MCL_ADMIN_SECRET
```

For the admin secret, generate a random value (for example `openssl rand -hex 32`)
and put exactly the same value in the website's private `mcl_api_config.php`.

### Finding the previous Groq key values in the original website archive

In the **original `htdocs.zip` supplied before the Cloudflare update**:
- The Developer API's former Groq key was in root `mcl_api_config.php`, on the
  `MCL_GROQ_API_KEY` definition.
- The AI Scanner's separate Groq key was in `plugins/ai-scanner/config.php`,
  on the `groq_api_key` entry.

These were different application configurations. Do not assume the AI Scanner
key is still valid or suitable as the Developer API's secondary key. The old
credentials were included in an uploaded archive; treat them as exposed. Create
new keys in the two respective Groq organisations and use those newly generated
values for the Cloudflare secrets. Do not commit either value to this repository.

## 3. Deploy

```bash
npm install
npx wrangler deploy
```

If GitHub auto-deploy is configured, push/commit the repository contents and
wait for the deployment to complete. Confirm Worker name `api` and account
Workers subdomain `mclab`.

## 4. Website configuration

In the website document root, edit private `mcl_api_config.php`:

```php
<?php
define('MCL_WORKER_URL', 'https://api.mclab.workers.dev');
define('MCL_ADMIN_SECRET', 'PASTE_THE_EXACT_SAME_RANDOM_SECRET_HERE');
define('MCL_GROQ_API_KEY', '');
```

The PHP site does not need either Groq key for the Worker-backed Developer API.
Do not put `MCL_GROQ_API_KEY_2` in PHP. The two Groq credentials belong only in
Cloudflare Worker Secrets. Keep `mcl_api_config.php` private and out of GitHub.

## 5. Migrate existing API keys

After the Worker, D1 schema, and matching admin secret are configured, run the
one-time migration endpoint:

`https://YOUR-WEBSITE-HOST/developers/api/migrate_to_worker.php?secret=YOUR_MCL_ADMIN_SECRET`

Confirm every key and usage row reports success, then delete
`developers/api/migrate_to_worker.php` from the live website.

New key creation, revocation, and rate-limit changes use the existing website
sync integration.

## 6. Test

A request to the Worker root without an API key should return `MISSING_API_KEY`.
Then send a normal API request:

```bash
curl -X POST "https://api.mclab.workers.dev/api/text" \
  -H "Authorization: Bearer mcl_live_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"hello","model":"openai/gpt-oss-20b","max_tokens":150}'
```

A successful response contains `success: true`, `response`, `usage`,
`rate_limit`, and `failover_used`.

To test failover safely, temporarily set the primary secret to an invalid
test value, deploy/restart the Worker as required, and make a test request while
the secondary secret is valid. Restore the primary secret immediately after
testing. Do not intentionally overload either organisation's quota.
