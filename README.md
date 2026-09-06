# ccnu_lesson_agent

教育版 Web 智能体（AI Tutor）：GPT 风格前端 + Go Agent 服务端。
单 Agent 内核 + 可插拔 Skill 编排；支持自然对话自动触发与 **`/命令` 主动唤起** Skill，
具备 **ask_user 向学生提问**能力，提供 **Python 代码沙箱（execute_code）+ 产物库**；
OpenAI 兼容模型接入（DeepSeek/OpenAI/通义…）。

> 架构文档见 [Agent.md](./Agent.md) ｜ 阿里云部署见 [deploy/DEPLOY_ALIYUN.md](./deploy/DEPLOY_ALIYUN.md)

## 仓库结构

```
├── Agent.md / README.md
├── Dockerfile / Dockerfile.codex      # app 镜像 / 沙箱+codex-worker 镜像
├── docker-compose.yml                 # app + postgres + codex + 卷(pgdata/skills/uploads/artifacts)
├── deploy/                            # 阿里云部署脚本与文档
├── web/                               # React 19 + Vite + TS（GPT 风格）
└── server/                            # Go 1.27 Agent 服务端
    ├── cmd/api/                       # 主服务入口（含沙箱健康轮询）
    ├── cmd/codex/                     # codex-worker（沙箱执行服务）
    ├── internal/{agent,codex,auth,config,gateway,ingest,model,skill,store}
    ├── migrations/                    # SQL 迁移（自动执行）
    └── .env.example
```

## 分支约定

- `master`：稳定分支，仅合入已验收版本
- `develop`：开发分支，日常提交与功能合入

## 快速开始（本地开发）

### 服务端（默认 :8080）
```bash
cd server
cp .env.example .env     # 编辑：模型 key（DeepSeek 等）；不配 key 则 Demo 模式
go run ./cmd/api         # 无 DATABASE_URL → 内存存储（重启丢数据）
# 验证: curl http://127.0.0.1:8080/healthz
```

### 前端（默认 :5173，代理 /v1 → 8080）
```bash
cd web && npm install && npm run dev
# 浏览器 http://localhost:5173
```

### 持久化模式（Postgres）
```bash
# 任意方式起 Postgres 后:
# Windows PowerShell: $env:DATABASE_URL="postgres://agent:pass@127.0.0.1:5432/lesson_agent?sslmode=disable"
export DATABASE_URL="postgres://agent:pass@127.0.0.1:5432/lesson_agent?sslmode=disable"
go run ./cmd/api          # 启动时自动建表
```

> 💡 代码沙箱需要 Docker + 配置 `CODEX_URL`（生产见 compose 的 `codex` 服务）；
> 未配置时 `execute_code` 自动隐藏，其余功能不受影响（挂件式降级）。

## 玩什么（当前现状）

- **自然对话**：问「帮我出点题」→ 信息不足会 ask_user 提问；「根据我上传的讲义…」→ 自动检索资料库带出处作答。
- **Python 代码沙箱**：让 AI「用 python 画个图 / 读我上传的 xlsx 算平均分」→ 沙箱容器真实执行 → 对话内即时预览图表 + 自动存入产物库。
- **🗂️ 产物库**：所有沙箱生成的图片/CSV/文本自动保存，可网格浏览、放大预览、下载、删除；历史会话消息中也能回看产物。
- **`/` 命令**：`/quiz 5道一元二次方程` · `/explain 什么是导数` · `/ask 你想练哪种题？` · `/search 检索资料库`（自加技能即出现新命令）。
- **Skill = SKILL.md**（Claude 风格）：对话技能由文档驱动——在 **🧩 技能管理**页（或 `server/skills/<name>/SKILL.md`）写 markdown 即生效，无需改代码重启。
- **📚 我的资料库**：上传 pdf/docx/xlsx/txt → 自动解析建索引 → 对话引用（带 `[出处：文件名]`）。
- **模式**：学伴 / 练习测评 / 教师辅助。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/auth/register|login|refresh|logout` | 认证（JWT） |
| GET | `/v1/auth/me` | 当前用户 |
| GET/POST | `/v1/conversations`；GET/PATCH/DELETE `/{id}`；GET `/{id}/messages` | 会话与消息 |
| POST | `/v1/chat` | SSE 流式对话（含 `/命令`） |
| GET | `/v1/skills`；GET/PUT/DELETE `/v1/skills/{name}` | Skill/命令清单 + 文档技能管理（teacher/admin） |
| GET/POST/DELETE | `/v1/library/files` | 资料库（上传解析/列表/删除） |
| GET | `/v1/artifacts`；GET `/v1/artifacts/{id}/raw`；DELETE `/v1/artifacts/{id}` | 产物库（列表/字节流下载/删除） |

SSE 事件：`meta` `delta` `tool_call` `tool_result`(含 `artifacts`) `ask` `done` `error`

## 里程碑

- [x] M0 骨架：JWT 认证、会话管理、SSE 流式、GPT 风格登录/聊天 UI
- [x] M1 Agent+Skill：function calling 工具循环、调用卡片、真实模型链路
- [x] M1.5 交互增强：`/命令`、ask_user 提问等待续接
- [x] Skill v2：SKILL.md 文档驱动（Claude 风格）+ 技能管理页（运行时热加载）
- [x] 文件知识库：资料库上传(pdf/docx/xlsx/txt)解析 + 关键词检索 + 出处引用
- [x] M5 代码沙箱：execute_code（Docker 隔离、禁网、产物收集、挂件式自愈）
- [x] M5.1 产物库：产物持久化 + `/artifacts` 页 + 历史消息产物回看
- [ ] M2 增强：向量检索、doc(.doc) 支持
- [ ] M3 教育业务：课程/班级权限、批改诊断 Skill、学情统计
- [x] M4 上线：Docker 化 + Postgres + 阿里云 ECS（https://www.ccnu.chat）

## 生产部署

```bash
# ECS（阿里云）上一条命令，详见 deploy/DEPLOY_ALIYUN.md
bash <(curl -fsSL https://raw.githubusercontent.com/handsomeboyck/ccnu_lesson_agent/develop/deploy/deploy_aliyun.sh)
# 沙箱服务（首次需构建镜像）：
docker compose build codex-sandbox && docker compose up -d --build
```
