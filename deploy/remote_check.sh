#!/bin/bash
# 部署功能验证脚本（上传到 ECS 后执行）
set -u
BASE=http://127.0.0.1:8080

echo "== 1. register =="
curl -sS -X POST "$BASE/v1/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"username":"deploy_check4","password":"password123","display_name":"部署验证"}' ; echo

echo "== 2. login (extract token) =="
LOGIN=$(curl -sS -X POST "$BASE/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"deploy_check4","password":"password123"}')
TOKEN=$(echo "$LOGIN" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
echo "token_len=${#TOKEN}"

echo "== 3. chat (DeepSeek real model) — event summary =="
curl -sS -N --max-time 120 -X POST "$BASE/v1/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d '{"content":"请用一句话介绍什么是二次函数","mode":"companion"}' \
  | grep -oE '^event: [a-z_]+' | sort | uniq -c

echo "== 4. conversations after chat =="
curl -sS -X GET "$BASE/v1/conversations" -H "Authorization: Bearer $TOKEN"; echo

echo "== done =="
