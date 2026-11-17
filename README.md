# MineCodeLabs API Worker

Cloudflare Worker for the MineCodeLabs API gateway. It authenticates
`mcl_live_` keys against D1, enforces per-key token-per-minute limits, records
usage, maps public MineCodeLabs model IDs to the configured upstream model
IDs, and returns a stable MineCodeLabs response contract.

## Public endpoint

`POST https://api.mclab.workers.dev/api/text`

```json
{
  "prompt": "Explain DNS in two sentences.",
  "model": "mclai/gpt-oss-20b",
  "max_tokens": 128,
  "temperature": 0.7
}
```

Authorization: `Bearer mcl_live_...`

## Public model IDs

| Model ID | MineCodeLabs per-key ceiling |
|---|---:|
| `mclai/gpt-oss-20b` | 7,000 TPM |
| `mclai/gpt-oss-120b` | 6,800 TPM |
| `mclai/gpt-oss-safeguard-20b` | 6,980 TPM |
| `mclai/qwen3.8-27b` | 6,880 TPM |
| `mclai/minimax-m2.7` | 7,000 TPM (MCL cap; Groq enterprise access) |
| `mclai/muse-spark-open` | 7,000 TPM (MCL cap; Groq enterprise access) |

See [MODEL-CATALOG.md](MODEL-CATALOG.md) for routing and compatibility details.

## Deployment

1. Keep the existing Cloudflare D1 database and binding named `DB` from
   `wrangler.jsonc`.
2. Keep the existing Worker admin secret `MCL_ADMIN_SECRET` unchanged.
3. Keep the existing inference secret(s) unchanged. `MCL_GROQ_API_KEY` remains
   accepted as the existing primary secret; `MCL_GROQ_API_KEY_2` is optional.
   A generic `MCL_INFERENCE_API_KEY` may be configured as the preferred primary.
4. Deploy this Worker using your existing Wrangler project.
5. Apply the included D1 migration once with `npx wrangler d1 migrations apply minecodelabs-api --remote`. This migrates historic per-model usage buckets while preserving accumulated usage.
6. Run `npm test` before deployment.

No API key values, admin secret values, or database passwords are stored in this
repository. MineCodeLabs owns and operates the API gateway, key validation,
quota policy, accounting, and routing layer. Actual model execution uses the
configured inference infrastructure; this repository does not claim that the
underlying accelerator hardware is MineCodeLabs-owned.

## Compatibility

Old active public IDs are normalized to the corresponding `mclai/*` ID.
`qwen/qwen3.6-27b` normalizes to `mclai/qwen3.8-27b`. MiniMax M2.7 and Muse
Spark Open are enterprise preview models on Groq; their upstream rate quotas
are account-specific and not published as public TPM values. Retired Compound
IDs return `410 MODEL_RETIRED`, because their upstream service has been shut down.

## Tests

```sh
npm test
```

## Infrastructure disclosure

MineCodeLabs operates the API gateway, authentication, request validation,
rate-limit enforcement, usage accounting, and public model-ID routing. The
current Worker sends inference requests to Groq's OpenAI-compatible API using
server-side credentials. The MineCodeLabs model IDs are stable public aliases;
they do not mean the underlying model weights or accelerator hardware are
owned by MineCodeLabs. Do not market the current setup as MineCodeLabs-owned
LPUs or proprietary inference hardware.
