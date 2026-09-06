# ccnu_lesson_agent

教育版 Web 智能体（AI Tutor）：GPT 风格前端 + Go Agent 服务端，内置 Skill 编排与课程知识库 RAG。

> 架构设计见 [Agent.md](./Agent.md)

## 仓库结构

```
ccnu_lesson_agent/
├── Agent.md      # 整体架构文档
├── web/          # 前端：React 19 + Vite + TypeScript（GPT 风格）
└── server/       # 服务端：Go（Agent 内核 + REST + SSE），纯 stdlib
```

## 分支约定

- `master`：稳定分支，仅合入已验收的版本
- `develop`：开发分支，日常提交与功能合入

## 快速开始（M0）

### 服务端（默认 :8080）

```bash
cd server
# 可选：配置 LLM（不配则进入 Demo 流式模式）
# 复制 .env.example 并按需填写（如 OPENAI_API_KEY）

# 直接运行
go run ./cmd/api
# 或构建运行
go build -o bin/api.exe ./cmd/api && ./bin/api.exe
```

验证：`curl http://127.0.0.1:8080/healthz` → `{"status":"ok"}`

### 前端（默认 :5173，已配置 /v1 代理到 8080）

```bash
cd web
npm install
npm run dev
```

浏览器打开 http://localhost:5173 → 注册账号 → 开始多轮对话。

### 数据存储说明

M0 服务端使用**内存 Store**（进程重启数据丢失），接口已抽象（见 `server/internal/store`），
PostgreSQL 建表迁移已备好（`server/migrations/0001_init.sql`），阿里云部署时实现 `store.Postgres` 切换即可。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/auth/register` / `/login` / `/refresh` / `/logout` | 认证（JWT） |
| GET | `/v1/auth/me` | 当前用户 |
| GET/POST | `/v1/conversations` | 会话列表 / 新建 |
| GET/PATCH/DELETE | `/v1/conversations/{id}` | 详情 / 重命名 / 删除 |
| GET | `/v1/conversations/{id}/messages` | 历史消息（多轮续载） |
| POST | `/v1/chat` | SSE 流式对话 |

## 里程碑

- [x] **M0** 骨架打通：JWT 认证、会话管理、SSE 流式对话、登录注册 + GPT 风格多轮聊天 UI
- [x] **M1** Agent + Skill：function calling 工具循环（上限 5 轮）、Skill 框架与注册表、首批 Skill（quiz_generator / explain_topic / knowledge_retrieve 占位）、前端 Skill 面板 + 工具调用卡片
- [ ] **M2** RAG：课程知识库、文档上传/向量化/检索、引用溯源
- [ ] **M3** 教育业务：课程/班级/角色权限、测评 skill（批改、诊断）、学情统计
- [ ] **M4** 上线：阿里云部署、Postgres 接入、限流、审计、监控

### M1 试用示例

无 API key（Demo 模式）即可体验工具链路：新对话 → 选「练习测评」模式 → 发送
「生成 5 道一元二次方程练习题」，可看到 `quiz_generator` 工具调用卡片与题目流式输出。
配置 `OPENAI_API_KEY` 后由真实模型自主决定何时调用 Skill。
