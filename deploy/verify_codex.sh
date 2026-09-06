#!/bin/bash
# M5 沙箱验证
echo "== codex worker healthz =="
docker compose -f /opt/ccnu_lesson_agent/docker-compose.yml exec -T codex wget -qO- http://127.0.0.1:9090/healthz 2>/dev/null || \
  docker compose -f /opt/ccnu_lesson_agent/docker-compose.yml exec -T codex sh -c "wget -qO- http://127.0.0.1:9090/healthz" 2>&1 | head -2
echo
echo "== app 日志（确认 codex enabled）=="
docker compose -f /opt/ccnu_lesson_agent/docker-compose.yml logs app 2>&1 | grep -i codex | tail -3
echo "== 直接调 codex /exec（绕模型）=="
# 用 app 容器内无 curl？直接宿主 curl codex 容器 ip 或经 docker network
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ccnu_lesson_agent-codex-1)
echo "codex ip: $IP"
curl -sS -X POST "http://$IP:9090/exec" -H 'Content-Type: application/json' \
  -d '{"code":"import platform,sys\nprint(\"hello from sandbox\", platform.python_version())\nprint(sys.executable)"}' | head -c 400
echo
