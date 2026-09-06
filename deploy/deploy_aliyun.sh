#!/usr/bin/env bash
# ccnu_lesson_agent 阿里云部署脚本（在 ECS 上执行）
# 前置：ECS 已安装 Docker + Docker Compose plugin；安全组放行 8080（或 80/443）。
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ccnu_lesson_agent}"

echo "==> 1/4 准备目录 ${APP_DIR}"
mkdir -p "${APP_DIR}"
cd "${APP_DIR}"

echo "==> 2/4 拉取代码（develop 分支）"
if [ ! -d .git ]; then
  git clone -b develop https://github.com/handsomeboyck/ccnu_lesson_agent.git .
else
  git fetch origin && git checkout develop && git pull origin develop
fi

echo "==> 3/4 配置环境变量（如未提供 .env，将使用默认值，仅用于演示！）"
if [ ! -f .env ]; then
  cat > .env <<'EOF'
# ⚠️ 生产务必修改以下值！
POSTGRES_PASSWORD=change-me-to-a-strong-password
JWT_SECRET=change-me-to-a-long-random-secret-32b+
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat
# 若用域名/HTTPS，填写前端访问源（可留空=不限同源由网关处理）
CORS_ORIGINS=
EOF
fi

echo "==> 4/4 构建并启动"
docker compose up -d --build

echo "==> 完成。服务已启动，健康检查："
sleep 3
curl -fsS http://127.0.0.1:8080/healthz && echo
echo "查看日志：docker compose -f ${APP_DIR}/docker-compose.yml logs -f app"
