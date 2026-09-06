#!/bin/bash
# M5 沙箱验证 v3：宿主直接 curl codex 容器 IP
set -u
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ccnu_lesson_agent-codex-1)
echo "codex ip: $IP"
echo "== healthz =="
curl -sS "http://$IP:9090/healthz"; echo
echo "== exec: python 基础 + 解析库 =="
curl -sS -X POST "http://$IP:9090/exec" -H 'Content-Type: application/json' \
  --data-binary @/tmp/codex_req1.json
echo
echo "== exec: 网络隔离（应 NETWORK BLOCKED）=="
curl -sS -X POST "http://$IP:9090/exec" -H 'Content-Type: application/json' \
  --data-binary @/tmp/codex_req2.json
echo
