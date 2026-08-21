# MineCodeLabs API — Cloudflare Worker package

## What this preserves
- Same public models and error codes.
- GET + POST API calls.
- Bearer key authentication, plus `?key=` for simple GET testing.
- D1-backed `mcl_api_keys` and `mcl_api_usage` tables.
- TPM reservation/finalization logic.
- Groq call stays server-side.

## Important migration note
Cloudflare Workers cannot use the InfinityFree MySQL database directly as a D1 database. Run the included `migrate_to_worker.php` once to copy existing key hashes and current usage from your existing MySQL into D1. Then replace `developers/api/keys.php` with `keys-cloudflare.php` only after you have verified the migration.

The old Groq credential found in the supplied archive is intentionally NOT copied into this package. Put your current/rotated credential into the Worker secret `MCL_GROQ_API_KEY`.
