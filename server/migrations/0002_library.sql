-- M2 文件知识库：用户级资料库（上传解析 + 关键词检索）
CREATE TABLE IF NOT EXISTS documents (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    ext        TEXT NOT NULL DEFAULT '',
    size_bytes BIGINT NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'parsing', -- parsing | ready | failed
    error      TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, created_at DESC);

-- 分块文本（解析产物）：检索单元，对话注入按块引用
CREATE TABLE IF NOT EXISTS document_chunks (
    id          TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    seq         INT  NOT NULL DEFAULT 0,
    content     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id, seq);
