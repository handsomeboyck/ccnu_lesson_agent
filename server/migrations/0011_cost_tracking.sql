-- 0011: metric_events 增加 user_id / conversation_id，支持按用户/会话统计成本
ALTER TABLE metric_events ADD COLUMN IF NOT EXISTS user_id          TEXT NOT NULL DEFAULT '';
ALTER TABLE metric_events ADD COLUMN IF NOT EXISTS conversation_id TEXT NOT NULL DEFAULT '';