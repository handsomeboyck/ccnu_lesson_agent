# 阿里云部署指南（ccnu_lesson_agent）

> 目标：单台阿里云 ECS 上以 Docker Compose 运行 **go-app（API + 前端静态）+ PostgreSQL**，单端口对外。

## 0. 整体拓扑

```
公网用户 ──▶ 阿里云 SLB / ECS 公网IP:8080（安全组放行）
                 │
                 ▼
            ECS 上 Docker Compose
            ├── app :8080   # Go：/v1/* API + 前端静态资源（SPA）
            └── db  :5432   # postgres:16（仅内网）
```

## 1. ECS 准备

- 系统：Ubuntu 22.04/24.04（或 Alibaba Cloud Linux 3）
- 规格：2C4G 起步（数十并发足够）
- 安全组放行：`8080`（或 80/443，若挂域名+TLS 则用 SLB/Nginx）
- 安装 Docker + Compose：
  ```bash
  curl -fsSL https://get.docker.com | bash
  docker --version && docker compose version
  ```

## 2. 一键部署

```bash
# 在 ECS 上执行（自动 clone develop → 生成 .env → compose up）
bash <(curl -fsSL https://raw.githubusercontent.com/handsomeboyck/ccnu_lesson_agent/develop/deploy/deploy_aliyun.sh)
# 或手动:
#   git clone -b develop https://github.com/handsomeboyck/ccnu_lesson_agent.git /opt/ccnu_lesson_agent
#   cd /opt/ccnu_lesson_agent && vim .env && docker compose up -d --build
```

⚠️ **首次务必编辑 `/opt/ccnu_lesson_agent/.env`**：
- `POSTGRES_PASSWORD`、`JWT_SECRET` 改为强随机值
- `OPENAI_API_KEY` 填入真实模型密钥（当前模板 DeepSeek）
- `OPENAI_MODEL` / `OPENAI_BASE_URL` 按需

## 3. 验证

```bash
curl http://127.0.0.1:8080/healthz     # {"status":"ok"}
# 浏览器访问 http://<ECS公网IP>:8080 → 注册/登录 → 对话（含 /命令、ask_user）
docker compose logs -f app             # 查看服务日志
docker compose ps
```

## 4. 数据持久化

- 数据落在 Docker volume `pgdata`，重启/重建容器不丢。
- **备份**：`docker compose exec db pg_dump -U agent lesson_agent > backup.sql`
- **升级代码**：`cd /opt/ccnu_lesson_agent && git pull origin develop && docker compose up -d --build`
- 迁移自动执行（应用启动时按需建表，幂等）；如需升迁云数据库 RDS：把 `DATABASE_URL` 指向 RDS 连接串，应用重启即切换。

## 5. 生产加固（上线前必做清单）

- [ ] `.env`：强 `JWT_SECRET` / `POSTGRES_PASSWORD`；禁止默认值
- [ ] HTTPS：SLB/Nginx 终结 TLS → 转发 8080；`CORS_ORIGINS` 设为你的域名
- [ ] 安全组仅放行必要端口；Postgres 不对外
- [ ] 模型 key 权限最小化；日志脱敏（不打印 Authorization）
- [ ] 监控：容器日志采集、healthz 探活、OpenAI 用量统计（后续接入 Prometheus 可参考架构文档 M4）
- [ ] 备份策略：每日 pg_dump + 保留 N 份（crontab 或云 RDS 自动备份）
- [ ] 内容安全与教育合规（敏感词/低龄保护）评审后开启

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| app 起不来，日志报 `postgres init failed` | db 尚未就绪/密码不符；确认 `.env` 与 compose 一致，`docker compose up -d db` 后重试 |
| 改了 `.env` 不生效 | `docker compose up -d`（env 变更需 recreate：`docker compose up -d --force-recreate`） |
| 前端 404 / 空白 | 确认构建产物存在（`docker compose exec app ls /app/web/dist`）；浏览器强刷 |
| 想换内存模式（不推荐） | 清空 `DATABASE_URL` 后重启（仅临时演示） |

## 7. 分支与发布流程

- 日常开发提交到 `develop`；验证稳定后：
  ```bash
  git checkout master && git merge develop && git push origin master
  ```
- ECS 拉取与升级默认跟踪 `develop`；正式发布建议切到 `master` tag 后部署。
