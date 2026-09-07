#!/bin/bash
# cleanup_docker.sh —— 每次部署/例行维护后回收 Docker 磁盘（只清 dangling/缓存，不动运行中镜像与数据卷）。
# 用法: bash deploy/cleanup_docker.sh
# 建议：部署后执行一次；也可加 crontab 每日执行（见文件尾注释）。
set -e

echo "== [1/3] 回收 dangling 镜像（docker image prune -f） =="
docker image prune -f

echo "== [2/3] 回收 buildkit 构建缓存（docker builder prune -f） =="
docker builder prune -f

echo "== [3/3] 清理已退出的容器与无用网络 =="
docker container prune -f
docker network prune -f

echo
echo "== 清理后磁盘 =="
df -h /

echo
echo "提示：请勿执行 'docker system prune -a' —— 它会把未打标签但在用的沙箱/构建镜像一并删除，"
echo "曾因误执行导致 ccnu-codex:latest 被删、需重建 10 分钟。本脚本刻意避免 -a。"

: <<'CRON'
# 每日 03:30 自动执行（root crontab -e）：
# 30 3 * * * bash /opt/ccnu_lesson_agent/deploy/cleanup_docker.sh >> /var/log/ccnu_docker_clean.log 2>&1
CRON
