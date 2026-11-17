# MineCodeLabs model catalog

Public requests use only these MineCodeLabs model IDs:

| Public model ID | Upstream route | MineCodeLabs per-key TPM ceiling |
|---|---|---:|
| `mclai/gpt-oss-20b` | `openai/gpt-oss-20b` | 7,000 |
| `mclai/gpt-oss-120b` | `openai/gpt-oss-120b` | 6,800 |
| `mclai/gpt-oss-safeguard-20b` | `openai/gpt-oss-safeguard-20b` | 6,980 |
| `mclai/qwen3.8-27b` | `qwen/qwen3.8-27b` | 6,880 |

The TPM ceilings above are MineCodeLabs API-key policy values, not upstream
provider quotas and not per-response `max_tokens` limits.

The Worker validates API keys, applies per-key quotas, records usage, normalizes
public model IDs, and routes requests to the configured inference endpoint.
MineCodeLabs operates this API gateway and routing layer; model execution is
performed by the configured inference infrastructure. Do not describe the
underlying compute hardware as MineCodeLabs-owned LPUs unless that is factually
true and independently verifiable.

Legacy active model IDs remain accepted for compatibility and are normalized to
`mclai/*`. The retired Compound IDs return HTTP 410 `MODEL_RETIRED`. The former
Qwen 3.6 ID maps to its currently supported Qwen 3.8 successor.
