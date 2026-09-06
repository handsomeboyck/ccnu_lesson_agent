#!/bin/bash
# M5 沙箱端到端验证（在 ECS 上执行）
set -u
echo "== 1. codex worker health (经 app 网络) =="
docker compose -f /opt/ccnu_lesson_agent/docker-compose.yml exec -T app \
  sh -c 'curl -sS http://codex:9090/healthz' && echo " <- app→codex OK"

echo "== 2. 直接执行简单 python（经 worker）=="
docker compose -f /opt/ccnu_lesson_agent/docker-compose.yml exec -T app \
  sh -c 'curl -sS -X POST http://codex:9090/exec -H "Content-Type: application/json" -d @/tmp/codex_req1.json'

echo "== 3. 沙箱隔离验证：尝试访问宿主机网络（应失败）=="
docker compose -f /opt/ccnu_lesson_agent/docker-compose.yml exec -T app \
  sh -c 'curl -sS -X POST http://codex:9090/exec -H "Content-Type: application/json" -d @/tmp/codex_req2.json'
