#!/bin/bash
# ECS 部署后验证（新版本：Skill v2 + 资料库）
B=http://127.0.0.1:8080
echo "== healthz =="
curl -sS "$B/healthz"; echo

echo "== login =="
LOGIN=$(curl -sS -X POST "$B/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"deploy_check4","password":"password123"}')
TOKEN=$(echo "$LOGIN" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
echo "token_len=${#TOKEN}"

echo "== skills (doc/primitive) =="
curl -sS "$B/v1/skills" -H "Authorization: Bearer $TOKEN" | python3 -c '
import sys,json
d=json.load(sys.stdin)
for s in d["skills"]:
    print(" ", s["name"], "doc" if s.get("doc") else "prim", s["description"][:40])
' 2>/dev/null || curl -sS "$B/v1/skills" -H "Authorization: Bearer $TOKEN" | head -c 500

echo
echo "== skills/{name} detail =="
curl -sS "$B/v1/skills/quiz_generator" -H "Authorization: Bearer $TOKEN" | head -c 200; echo

echo "== library list =="
curl -sS "$B/v1/library/files" -H "Authorization: Bearer $TOKEN"; echo
echo "== done =="
