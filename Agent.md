# 教育版 Web 智能体（AI Tutor）整体架构

> 版本：v0.3（实现快照：M0/M1 完成，Postgres 落库 + 阿里云部署准备中）
> 定位：面向教育场景的 ChatGPT 风格 Web 智能体。前端参考 GPT 交互形态，服务端为单一 Agent 内核 + 可插拔 Skill 编排，支持 **自然对话自动触发** 与 **`/命令` 主动唤起** Skill，具备 **ask_user 向学生提问**能力，OpenAI 兼容模型接入。

---

## 1. 项目定位与范围

**一句话**：一个"学伴 / 练习测评 / 教师辅助"三种模式共存的单 Agent Web 应用。用户在对话中自然唤起 Skill（由模型自觉），也可输入 `/命令` 强制唤起；Agent 信息不足时会通过 `ask_user` 提问澄清，而不是臆测参数。

### 1.1 目标用户与场景

| 角色 | 典型场景 | 涉及 Skill |
|---|---|---|
| 学生（学伴答疑） | 学科答疑、概念讲解、追问、基于课程资料作答 | `explain_topic`、`knowledge_retrieve`、`ask_user` |
| 学生（练习测评） | 生成练习、作答批改、错题诊断、掌握度分析 | `quiz_generator`、`answer_grader`（规划）、`mistake_diagnosis`（规划） |
| 教师（教师辅助） | 教案生成、作业布置、批量批改、学情汇总 | `lesson_plan`（规划）、批改类、学情类（规划） |

### 1.2 非目标（本期不做）
- 多 Agent 协同、复杂编排工作流（预留扩展位）
- 音视频、多模态输入
- 大规模 SaaS / 多租户计费（按小规模在线服务设计）

---

## 2. 技术选型（现状）

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | React 19 + Vite 8 + TypeScript | GPT 风格 SPA；`web/`；react-markdown 渲染、Zustand 状态、React Router |
| 后端 | Go 1.27（`net/http` 1.22+ 方法路由），stdlib 为主 + pgx 驱动 | Agent 服务端；`server/` |
| 实时通信 | SSE（Server-Sent Events） | 事件协议见 §6.2 |
| LLM 接入 | OpenAI Chat Completions + function calling | `OPENAI_*` 三件套配置，兼容 DeepSeek/OpenAI/通义等；本地当前启用 DeepSeek `deepseek-chat`；无 key 时 Demo 模式可无网联调 |
| Embedding | （规划）OpenAI Embedding API 1536 维 | 供 M2 RAG 使用 |
| 数据库 | PostgreSQL（pgx/v5） | 生产权威数据源；本地未配 `DATABASE_URL` 时回退内存 store（仅开发演示） |
| 配置 | `.env` 文件（服务端启动自动加载，系统环境变量优先） | 模板见 `server/.env.example` |
| 部署 | Docker Compose 于阿里云 ECS，Go 单进程托管 API + 前端静态资源 | 单端口对外，见 §7 |
| 认证 | 自研 JWT（access + refresh，refresh 轮换） | 角色 student/teacher/admin；不做学校 SSO |

---

## 3. 总体架构

### 3.1 架构图

```
┌──────────────────────────────────────────────────────────────┐
│                     浏览器 (Web UI)                            │
│ 登录/注册 · GPT 风格聊天 · /命令菜单 · ask 等待 · Skill 卡片 · 流式 │
└──────────────┬──────────────────────────────┬────────────────┘
               │ REST(会话/消息/技能清单)       │ SSE(POST /v1/chat)
               ▼                              ▼
┌──────────────────────────────────────────────────────────────┐
│                    Go Agent 服务端（单进程）                    │
│ ┌───────────┐ ┌────────────┐ ┌─────────────────────────────┐ │
│ │ Gateway   │ │ Auth/JWT   │ │ 静态资源托管（web/dist，生产） │ │
│ │ REST+SSE  │ │ + 角色      │ └─────────────────────────────┘ │
│ └─────┬─────┘ └─────┬──────┘                                  │
│       ▼             ▼                                         │
│  ┌────────────────────────────────────────────────────────┐   │
│  │                 Agent Core（单 Agent，双路径）            │   │
│  │  路径A 自然对话：LLM推理 ⇄ tool_call ⇄ Skill（轮次≤5）     │   │
│  │  路径B /命令： 直接执行 Skill → 流式返回                  │   │
│  │  ask_user 触发 → 暂停等待学生回答 → 下轮自动续接           │   │
│  └───────┬──────────────────────────────┬─────────────────┘   │
│          ▼                              ▼                     │
│  ┌────────────────┐            ┌────────────────────┐         │
│  │ Skill Registry │            │ Model Provider     │         │
│  │ 4 内置 Skill   │            │ OpenAI 兼容 / Demo │         │
│  │ + CommandProvider            │ Chat(stream+tools)│         │
│  └────────┬───────┘            └─────────┬──────────┘         │
└───────────┼───────────────────────────────┼───────────────────┘
            ▼                               ▼
   ┌─────────────┐   DATABASE_URL    ┌──────────────┐
   │ Store 接口   │ ────────────────▶ │ PostgreSQL   │
   │  memory(dev)│◀──(无 DATABASE_URL)│ (docker/云)   │
   └─────────────┘                   └──────────────┘
```

### 3.2 两条对话路径与时序

**路径 A · 自然对话（模型自觉触发 Skill）**
```
User ──POST /v1/chat {conversation_id, content}──▶ Gateway
  ├─ 持久化 user message → 载入历史 → Agent.Run
  ├─ LLM 流式推理（tools=当前模式 Skill schema）
  ├─ SSE: meta → delta* | tool_call → tool_result →（继续推理）→ done
  └─ ask_user 被调用时：SSE ask{question,options} → 问题落库 → 结束
      学生下条消息回答 → 历史含"自己问过什么" → 模型续接原任务
```

**路径 B · `/命令` 强制唤起**
```
User: /quiz 3道一元二次方程困难题
  ├─ Agent 解析命令 → 注册表查找（支持别名：/quiz /出题 /quiz_gen）
  ├─ 参数启发式抽取 {topic, count, difficulty} → Skill.Execute
  ├─ SSE: tool_call → tool_result{summary} → delta*（结果全文流式）→ done
  └─ 未知名命令 → delta 列出可用命令帮助
```

---

## 4. 核心模块设计

### 4.1 前端（`web/`）—— 参考 GPT 交互

**基础能力**：
- **账号**：登录/注册页；JWT access 自动附带，401 用 refresh 静默续期后重试一次，失败跳登录；路由守卫。
- **多轮对话**：会话列表/新建/重命名/删除/续载；消息即时落库，刷新可恢复；防重复提交 + 停止生成（Abort）。
- **错误与边界**：登录失效、断线、异常均有反馈。

**交互能力**：
- **`/` 命令菜单**：输入框键入 `/` 弹出 Skill 命令列表（继续输入过滤，Tab/点击补全为 `"/cmd "`）。
- **ask_user 交互**：收到 SSE `ask` → 助手气泡显示问题 + 「等待回答」横幅 + 快捷选项按钮；学生回答后自动继续原任务。
- **Skill 调用卡片**：流式中展示 `⚙调用中 → ✓完成(摘要)`。
- **流式渲染**：Markdown + 打字机光标（注意：delta 追加必须是**纯 updater**，避免 StrictMode 双调导致逐字重复——已修复）。
- **模式切换**：学伴/练习/教师；新会话选模式，历史会话沿用其模式。
- **Skill 面板**（新对话时）：顶部胶囊列出 `/命令`，点击自动填入。

**页面**：`/login` `/register`（公共）；`/` 聊天主界面（未登录重定向）。`/library` 课程资料库（M2 起）、设置页为规划。

### 4.2 Agent 内核（`server/internal/agent`，单 Agent 双路径）

- **路径 A 工具循环**：OpenAI function calling 驱动；模型只做意图/参数/语言组织，动作经 Skill。
  - 组装上下文：模式系统提示词（含"信息不足用 ask_user、答完上轮提问续接任务"行为准则）+ 历史 + tools。
  - 循环：`ChatStream` → 有 `tool_calls` 则逐个执行 Skill → `role:tool` 回填 → 继续；无调用即结束。轮次上限 `MaxToolRounds=5`。
  - **ask 中断**：某 Skill 返回 `Result.Ask`（如 `ask_user`）→ 发 `ask` 事件并**暂停**，不再臆测继续；问题作为助手消息落库。
- **路径 B `/命令`**：识别历史最后一条 user 消息以 `/` 开头 → 经 `Registry.LookupCommand`（支持别名与 skill 名）→ `CommandArgs(rawText)` 启发式抽参 → 直接 Execute → 结果全文流式返回（不消耗额外推理轮）。
- 会话模式（mode）是同一 Agent 的**配置切面**：仅影响系统提示词与可用 Skill 集合。

### 4.3 Skill 体系（`server/internal/skill/`）

**目录**：
```
skill/
├── registry.go            # 框架：Skill 接口 / Registry / Ask 载荷 / AskFor 构造器
├── builtin.go             # ★ 注册入口 RegisterDefaults + 文本数量解析
├── commands.go            # 各 Skill 的 /命令 别名 + 自然语言参数启发式
├── quiz_generator.go      # 出题
├── explain_topic.go       # 结构化讲解
├── knowledge_retrieve.go  # 课程知识库检索（M2 接通，现为占位）
└── ask_user.go            # 向学生提问
```

**接口（真实签名）**：
```go
type Skill interface {
    Name() string                // 唯一标识，如 "quiz_generator"
    Description() string         // 给 LLM 看：何时用、做什么
    Parameters() map[string]any  // JSON Schema
    Modes() []string             // 可用模式（空=全部）
    Execute(ctx, env *Env, args json.RawMessage) (*Result, error)
}
type Env struct { UserID, CourseID, Mode string; Store store.Store; Model model.Provider; ModelName string }

type Result struct {
    Content   string   // 回复内容（markdown）
    Summary   string   // 工具卡片摘要
    Artifacts []any    // 结构化产物（题目 JSON 等）
    Done      bool     // true=无需模型再总结
    Ask       *Ask     // 非空=需提问并等待
}
type Ask struct { Question string; Options []string }

// CommandProvider 可选接口：实现后支持 "/命令" 直接唤起
type CommandProvider interface {
    Commands() []string                // 别名，如 ["quiz","出题"]
    CommandArgs(rawText string) map[string]any
}
```

**内置 Skill 现状**：

| Skill | /命令 | 说明 | 模式 | 状态 |
|---|---|---|---|---|
| `quiz_generator` | `/quiz` `/出题` | 按主题/数量/难度出题，内部调模型生成结构化题目 JSON 再渲染 | practice/teacher | ✅ |
| `explain_topic` | `/explain` `/讲解` | 定义→例子→分步→易错→小结 讲解 | companion/practice | ✅ |
| `knowledge_retrieve` | `/search` `/检索` | 课程知识库检索 | 全部 | ⏳ 占位（M2 接 RAG） |
| `ask_user` | `/ask` `/提问` | 提问并等待学生回答 | 全部 | ✅ |
| `answer_grader` / `mistake_diagnosis` / `lesson_plan` / `student_progress` | - | 批改/诊断/教案/学情（Agent.md 规划） | - | ⛔ 未实现（M3） |

**如何扩展**：新增 Skill = ①新建 `.go` 文件实现接口 → ②`builtin.go` 的 `RegisterDefaults` 注册（删除注册行即移除）→ ③可选在 `commands.go` 实现 `CommandProvider` 加 `/命令` → ④`go build` 重启。前端自动从 `/v1/skills` 拉取，无需改动。

### 4.4 模型接入（`server/internal/model`）

- OpenAI Chat Completions 流式：文本 delta 实时、tool_calls 分片聚合（wire 格式：`type=function` + arguments 为 JSON 字符串——曾踩坑修复）。
- `Provider.ChatStream`（工具循环用）与 `Provider.Complete`（Skill 内部非流式二次调用用）。
- 无 `OPENAI_API_KEY` 时启用 DemoProvider（可模拟 quiz 触发与结构化回填），保证本地无网可联调。

### 4.5 RAG 课程知识库（M2，暂缓）

占位 Skill `knowledge_retrieve` 已就位；M2 接入文档上传→解析→分块→向量化（pgvector）→检索→引用溯源（前端 citation 卡片）。

---

## 5. 数据模型（PostgreSQL）

实现以迁移文件为准：`server/migrations/0001_init.sql`，启动时自动执行（幂等 `IF NOT EXISTS`）。

```
users(id, username unique, password_hash, display_name, role, created_at)
refresh_tokens(hash pk, user_id FK, expires_at)
conversations(id, user_id FK, title, mode, course_id, created_at, updated_at)
messages(id, conversation_id FK, role, content, model, usage_json, created_at)
```

> 存储架构：`store.Store` 接口 + 两个实现：`memory.go`（无 DATABASE_URL 时的开发回退，重启丢数据）与 `postgres.go`（生产）。后续 M2 增加 `document_chunks(embedding vector(1536))`；审计 `skill_runs` 表为规划（M4）。

---

## 6. API 设计

### 6.1 REST（JSON）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/auth/register` `/login` `/refresh` `/logout` | 认证 |
| GET | `/v1/auth/me` | 当前用户 |
| GET/POST | `/v1/conversations` | 列表 / 新建 |
| GET/PATCH/DELETE | `/v1/conversations/{id}` | 详情 / 重命名 / 删除 |
| GET | `/v1/conversations/{id}/messages` | 历史消息 |
| POST | `/v1/chat` | SSE 流式对话（支持 `/命令`） |
| GET | `/v1/skills` | `{skills:[], commands:[...]}` 供面板与 `/` 菜单 |
| GET | `/healthz` | 健康检查 |

### 6.2 SSE 事件（POST /v1/chat）
```
event: meta        {conversation_id}              # 新会话时返回 id
event: delta       {text}                         # 流式文本
event: tool_call   {id, name, arguments}          # Skill 开始（卡片 ⚙）
event: tool_result {name, summary}                # Skill 完成（卡片 ✓）
event: ask         {question, options}            # ask_user：等待学生回答
event: done        {message_id, usage, duration_ms}
event: error       {code, message}
```

---

## 7. 部署架构（阿里云，准备中）

```
阿里云 ECS (Ubuntu) ── Docker Compose
├── go-app      单进程：API + 前端静态资源（单端口对外，无需 Nginx 转发 API）
│               环境变量注入：DATABASE_URL / JWT_SECRET / OPENAI_* / PORT
└── postgres:16 数据卷持久化（生产建议升迁云数据库 RDS PostgreSQL）
Nginx/SLB 仅做 TLS 443 → go-app（可选）
前端构建产物 web/dist 打进镜像，由 Go 以 http.FileServer + SPA fallback 托管
```

构建与运行文件（仓库根）：
- `Dockerfile`：多阶段（node 构建 web → go 构建 server → alpine 运行）
- `docker-compose.yml`：app + postgres 编排
- `server/.env.example`：配置模板（生产用环境变量覆盖）

上线前清单见 §9 M4。

---

## 8. 仓库结构（现状）

```
sfh_workplace/（= ccnu_lesson_agent）
├── Agent.md                # 本文档
├── README.md               # 快速开始 / API 摘要
├── Dockerfile              # 多阶段构建（部署）
├── docker-compose.yml      # app + postgres（部署）
├── web/                    # React 19 + Vite + TS
│   └── src/{pages,api,store,types.ts,index.css}
└── server/                 # Go 1.27
    ├── cmd/api/main.go     # 入口：配置/存储选择/静态托管
    ├── internal/
    │   ├── agent/          # 工具循环 + /命令 + ask 中断
    │   ├── auth/           # JWT/PBKDF2/注册登录刷新
    │   ├── config/         # .env 加载 + 配置
    │   ├── gateway/        # REST + SSE + CORS + 日志
    │   ├── model/          # OpenAI 兼容 / Demo Provider
    │   ├── skill/          # Skill 框架 + 4 内置 Skill
    │   └── store/          # Store 接口 + memory + postgres
    ├── migrations/         # SQL 迁移（go:embed 自动执行）
    ├── .env(.example)      # 本地配置（不提交 .env）
    └── go.mod
```

---

## 9. 里程碑（状态）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0 骨架** | monorepo；JWT 认证；会话 CRUD；SSE 流式；登录/注册 + GPT 风格多轮聊天 | ✅ 完成 |
| **M1 Agent+Skill** | function calling 循环（≤5 轮）；Skill 框架；quiz/explain/knowledge_retrieve；调用卡片 UI | ✅ 完成 |
| **M1.5 交互增强** | `/命令` 强制唤起（CommandProvider）；`ask_user` 提问等待续接；Skill 面板 / 菜单；真实 DeepSeek 模型链路与 wire 格式修复；StrictMode 重复修复 | ✅ 完成 |
| **M2 RAG** | 课程知识库文档上传/向量化/检索/引用溯源 | ⏸ 暂缓（占位已留） |
| **M3 教育业务** | 课程/班级/角色权限；answer_grader、mistake_diagnosis、lesson_plan 等 Skill；学情统计；教师端 | ⛔ 未开始 |
| **M4 上线** | Postgres 落库（进行中）；Docker 化 + compose；阿里云部署/运维文档；限流、审计(skill_runs)、监控 | 🔄 进行中 |

分支约定：`master` 稳定分支仅合入已验收版本；日常开发在 `develop`（当前 = 804b7c4 + 部署冲刺提交）。

---

## 10. 已定决策 / 待定风险

**已定**：
- ✅ 模型：OpenAI 架构 Chat Completions；生产供应商可配（现 DeepSeek）；Embedding 1536 维（M2 用）。
- ✅ 账号：自研 JWT（PBKDF2-SHA256 存密码，refresh 轮换），不接 SSO。
- ✅ Skill：单 Agent + 注册表；双触发路径（模型自觉 / `/命令`）。
- ✅ 存储：Postgres 为生产权威源；接口抽象支持内存回退。
- ✅ 部署：Docker Compose + Go 单进程托管前端；阿里云 ECS。

**待定 / 风险**：
1. 对话模型型号与配额/限流策略（上线前定）。
2. 内容安全：敏感词/低龄保护/输出审查（教育合规）。
3. 主观题批改仅辅助，UI 需明示"仅供参考"。
4. 课程资料版权边界。
5. Postgres 连接池与迁移在真实实例上的验收（部署冲刺内完成）。
6. 上线 TLS（Nginx/SLB 证书）与日志监控接入。

---

*本文档随代码演进维护；与实现不一致时以代码为准并回更本文档。*
