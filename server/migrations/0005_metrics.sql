-- 0005_metrics: Agent 运行指标（监控）
-- 每次对话/工具调用/沙箱执行追加一行，供 admin 监控聚合。
CREATE TABLE IF NOT EXISTS metric_events (
    id               BIGSERIAL PRIMARY KEY,
    ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind             TEXT NOT NULL,             -- chat | tool | codex
    mode             TEXT NOT NULL DEFAULT '',   -- companion/practice/teacher
    status           TEXT NOT NULL DEFAULT '',   -- ok | error | ask | ...
    skill            TEXT NOT NULL DEFAULT '',   -- kind=tool 时：execute_code/knowledge_retrieve...
    prompt_tokens    BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    duration_ms      BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_metric_events_ts ON metric_events (ts);
