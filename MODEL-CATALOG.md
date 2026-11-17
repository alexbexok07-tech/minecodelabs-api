# MineCodeLabs model catalog

Public requests use only these MineCodeLabs model IDs:

| Public model ID | Upstream route | MineCodeLabs per-key TPM ceiling |
|---|---|---:|
| `mclai/gpt-oss-20b` | `openai/gpt-oss-20b` | 7,000 |
| `mclai/gpt-oss-120b` | `openai/gpt-oss-120b` | 6,800 |
| `mclai/gpt-oss-safeguard-20b` | `openai/gpt-oss-safeguard-20b` | 6,980 |
| `mclai/qwen3.8-27b` | `qwen/qwen3.8-27b` | 6,880 |
| `mclai/minimax-m2.7` | `minimaxai/minimax-m2.7` | 7,000 |
| `mclai/muse-spark-open` | `meta-models/muse-spark-open` | 7,000 |

The TPM ceilings above are MineCodeLabs API-key policy values, not upstream
provider quotas and not per-response `max_tokens` limits. Groq currently lists
MiniMax M2.7 (`minimaxai/minimax-m2.7`) and Muse Spark Open
(`meta-models/muse-spark-open`) as enterprise preview models. Groq lists their
rate limits as Contact Sales, so the 7,000 TPM figures above are only the
MineCodeLabs per-key ceilings; actual access and upstream limits depend on the
Groq organization/project entitlement.

The Worker validates API keys, applies per-key quotas, records usage, normalizes
public model IDs, and routes requests to the configured inference endpoint.
MineCodeLabs operates this API gateway and routing layer; model execution is
performed by the configured inference infrastructure. Do not describe the
underlying compute hardware as MineCodeLabs-owned LPUs unless that is factually
true and independently verifiable.

Legacy provider model IDs remain accepted for compatibility and are normalized
to `mclai/*`. The former Qwen 3.6 ID maps to its currently supported Qwen 3.8
successor. The retired Compound IDs return HTTP 410 `MODEL_RETIRED`.
