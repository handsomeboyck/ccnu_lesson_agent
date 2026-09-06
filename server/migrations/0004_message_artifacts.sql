-- M5.1：消息关联产物摘要（历史会话重新展示产物时用）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS artifacts_json TEXT NOT NULL DEFAULT '';
