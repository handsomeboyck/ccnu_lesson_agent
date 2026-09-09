-- 0009: 指标表增加 LLM 前缀缓存命中统计（DeepSeek prompt_cache_hit/miss）
ALTER TABLE metric_events ADD COLUMN IF NOT EXISTS cache_hit_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE metric_events ADD COLUMN IF NOT EXISTS cache_miss_tokens BIGINT NOT NULL DEFAULT 0;
