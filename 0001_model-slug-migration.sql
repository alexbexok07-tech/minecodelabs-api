-- MineCodeLabs model-slug v1.4 migration.
-- Run once against the existing D1 database after deploying the new Worker.
-- Existing buckets are merged into the new public model IDs before old rows are removed.
INSERT INTO mcl_api_model_usage
  (key_id, model_id, bucket_start, used_tokens, reserved_tokens, request_count)
SELECT key_id,
       CASE model_id
         WHEN 'openai/gpt-oss-20b' THEN 'mclai/gpt-oss-20b'
         WHEN 'openai/gpt-oss-120b' THEN 'mclai/gpt-oss-120b'
         WHEN 'openai/gpt-oss-safeguard-20b' THEN 'mclai/gpt-oss-safeguard-20b'
         WHEN 'qwen/qwen3.6-27b' THEN 'mclai/qwen3.8-27b'
       END AS model_id,
       bucket_start,
       SUM(used_tokens),
       SUM(reserved_tokens),
       SUM(request_count)
FROM mcl_api_model_usage
WHERE model_id IN (
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-safeguard-20b',
  'qwen/qwen3.6-27b'
)
GROUP BY key_id, model_id, bucket_start
ON CONFLICT(key_id, model_id, bucket_start) DO UPDATE SET
  used_tokens = mcl_api_model_usage.used_tokens + excluded.used_tokens,
  reserved_tokens = mcl_api_model_usage.reserved_tokens + excluded.reserved_tokens,
  request_count = mcl_api_model_usage.request_count + excluded.request_count;

DELETE FROM mcl_api_model_usage
WHERE model_id IN (
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-safeguard-20b',
  'qwen/qwen3.6-27b'
);

