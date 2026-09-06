#!/bin/bash
# 线上对话数据导出（含用户名），输出 UTF-8 CSV 到 /tmp/export/
set -e
cd /opt/ccnu_lesson_agent
OUT=/tmp/export
mkdir -p "$OUT"

PSQL="docker compose exec -T db psql -U agent -d lesson_agent"

echo "== users =="
$PSQL -c "COPY (SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at) TO STDOUT WITH (FORMAT csv, HEADER);" > "$OUT/users.csv"

echo "== conversations (含用户名) =="
$PSQL -c "COPY (
  SELECT c.id, u.username AS owner, c.title, c.mode, c.course_id, c.created_at, c.updated_at
  FROM conversations c JOIN users u ON u.id = c.user_id
  ORDER BY c.created_at
) TO STDOUT WITH (FORMAT csv, HEADER);" > "$OUT/conversations.csv"

echo "== messages (含用户名与会话标题) =="
$PSQL -c "COPY (
  SELECT m.id AS message_id, c.id AS conversation_id, c.title AS conversation_title,
         u.username AS owner, m.role, m.content, m.model, m.created_at
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  JOIN users u ON u.id = c.user_id
  ORDER BY m.created_at, m.id
) TO STDOUT WITH (FORMAT csv, HEADER);" > "$OUT/messages.csv"

echo "== 行数 =="
wc -l "$OUT"/users.csv "$OUT"/conversations.csv "$OUT"/messages.csv
echo "== 完成: $OUT =="
