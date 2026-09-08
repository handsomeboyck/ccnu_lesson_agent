-- M6: 消息关联思考链全文（历史回看思考卡片）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reasoning TEXT NOT NULL DEFAULT '';
