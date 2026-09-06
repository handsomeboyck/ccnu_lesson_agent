-- 0006_conversation_attachments: 会话关联文件（多轮附件记忆）
-- 附件上传即入库 documents（资料库），再在此登记"哪个会话用过哪些文件"，
-- 供该会话后续轮次自动检索注入（无需每次重传/点名文件）。
CREATE TABLE IF NOT EXISTS conversation_attachments (
    conv_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conv_id, doc_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_attach_doc ON conversation_attachments (doc_id);
