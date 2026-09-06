-- M5 产物库：沙箱执行产物持久化（图片/csv/文本），供「产物库」页预览与下载
CREATE TABLE IF NOT EXISTS artifacts (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL DEFAULT '',
    message_id      TEXT NOT NULL DEFAULT '',
    skill           TEXT NOT NULL DEFAULT 'execute_code',
    filename        TEXT NOT NULL,
    mime            TEXT NOT NULL DEFAULT '',
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    storage_key     TEXT NOT NULL DEFAULT '',  -- ARTIFACT_DIR 下的文件名
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_artifacts_user ON artifacts(user_id, created_at DESC);
