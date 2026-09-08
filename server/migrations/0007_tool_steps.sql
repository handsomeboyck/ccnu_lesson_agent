-- M5.3: 消息关联工具执行轨迹（历史回看工具卡片，AI SDK 协议升级配套）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_steps_json TEXT NOT NULL DEFAULT '';
