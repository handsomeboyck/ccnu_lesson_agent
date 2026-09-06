# ccnu_lesson_agent

教育版 Web 智能体（AI Tutor）：GPT 风格前端 + Go Agent 服务端。
单 Agent 内核 + 可插拔 Skill 编排；支持自然对话自动触发与 **`/命令` 主动唤起** Skill，
具备 **ask_user 向学生提问**能力；OpenAI 兼容模型接入（DeepSeek/OpenAI/通义…）。

> 架构文档见 [Agent.md](./Agent.md) ｜ 阿里云部署见 [deploy/DEPLOY_ALIYUN.md](./deploy/DEPLOY_ALIYUN.md)

## 仓库结构

```
├── Agent.md / README.md
├── Dockerfile / docker-compose.yml    # 生产部署（Go 单端口托管前端 + Postgres）
├── deploy/                            # 阿里云部署脚本与文档
├── web/                               # React 19 + Vite + TS（GPT 风格）
└── server/                            # Go 1.27 Agent 服务端
    ├── cmd/api/                       # 入口
    ├── internal/{agent,auth,config,gateway,model,skill,store}
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

## 玩什么（M1 现状）

- **自然对话**：问「帮我出点题」→ 模型信息不足会 ask_user 提问，回答后续接出题。
- **`/` 命令**：输入框键入 `/` 选命令，或直接发：
  `/quiz 5道一元二次方程` · `/explain 什么是导数` · `/ask 你想练哪种题？` · `/search …`（RAG 待 M2）
- **模式**：学伴（答疑引导）/ 练习测评 / 教师辅助（同 Agent 不同提示词与 Skill 集）

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/auth/register|login|refresh|logout` | 认证（JWT） |
| GET | `/v1/auth/me` | 当前用户 |
| GET/POST | `/v1/conversations`；GET/PATCH/DELETE `/{id}`；GET `/{id}/messages` | 会话与消息 |
| POST | `/v1/chat` | SSE 流式对话（含 `/命令`） |
| GET | `/v1/skills` | Skill 清单 + 命令清单 |

SSE 事件：`meta` `delta` `tool_call` `tool_result` `ask` `done` `error`

## 里程碑

- [x] M0 骨架：JWT 认证、会话管理、SSE 流式、GPT 风格登录/聊天 UI
- [x] M1 Agent+Skill：function calling 工具循环、Skill 框架与调用卡片
- [x] M1.5 交互增强：`/命令` 主动唤起、ask_user 提问等待续接、真实模型链路
- [ ] M2 RAG 课程知识库（暂缓，占位已留）
- [ ] M3 教育业务：课程/班级权限、批改诊断 Skill、学情统计
- [ ] M4 上线：Docker 化 + Postgres（进行中）→ 阿里云部署

## 生产部署

```bash
# ECS（阿里云）上一条命令，详见 deploy/DEPLOY_ALIYUN.md
bash <(curl -fsSL https://raw.githubusercontent.com/handsomeboyck/ccnu_lesson_agent/develop/deploy/deploy_aliyun.sh)
```
