# 教育版 Web 智能体（AI Tutor）整体架构

> 版本：v0.2（架构草案，关键决策已定，待评审进入 M0）
> 定位：面向教育场景的 ChatGPT 风格 Web 智能体。前端参考 GPT 交互形态，服务端为单一 Agent 内核 + 可插拔 Skill 编排，内置 RAG 课程知识库，支持流式输出。

---

## 1. 项目定位与范围

**一句话**：一个"学伴 / 教师 / 测评"三种模式共存的单 Agent Web 应用，用户在对话中自然唤起内置 Skill（出题、批改、讲解、教案生成、知识库检索等）。

### 1.1 目标用户与场景

| 角色 | 典型场景 | 涉及 Skill |
|---|---|---|
| 学生（智能学伴） | 学科答疑、错题讲解、概念追问、基于课程资料作答 | 知识库检索、讲解、出题 |
| 学生（练习测评） | 生成练习、自动批改、错题诊断、知识点掌握度分析 | 出题、批改、学情分析 |
| 教师（教师辅助） | 教案/课件生成、作业布置、批量批改、学情汇总 | 教案生成、批改、学情分析 |

### 1.2 非目标（本期不做）
- 多 Agent 协同、复杂编排工作流（预留扩展位，但不实现）
- 音视频、多模态输入
- 大规模 SaaS 化 / 多租户计费（按小规模在线服务设计，保留升级空间）

---

## 2. 技术选型

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | React 18 + Vite + TypeScript | GPT 风格单页应用；`web/` 目录 |
| 后端 | Go（1.22+，`net/http` 或 chi/gin） | Agent 服务端；`server/` 目录 |
| 实时通信 | SSE（Server-Sent Events） | 流式 token、工具调用事件、状态事件；REST 承载读写 |
| LLM 接入 | OpenAI 架构：Chat Completions + function calling | 主供应商 OpenAI（如 gpt-4o-mini 级按预算选）；协议层允许替换为任意 OpenAI 兼容端点（base_url 可配），便于后期在阿里云侧接入通义等备选 |
| Embedding | OpenAI Embedding API（text-embedding-3-small） | 向量维度固定 **1536**；pgvector 建表以其为准 |
| 数据库 | PostgreSQL + pgvector | 业务数据 + 向量检索（RAG） |
| 缓存/限流 | Redis | 会话状态、限流令牌桶、幂等、可选任务队列 |
| 文件存储 | 本地磁盘卷（可切阿里云 OSS） | 上传的课程文档原文件 |
| 部署 | Docker Compose 于阿里云 ECS | Nginx/SLB 做 TLS 与静态资源 |
| 认证 | 自研账号体系（JWT） | 用户名密码 + 角色（student/teacher/admin），含 refresh token；不做学校 SSO 对接 |

---

## 3. 总体架构

### 3.1 架构图

```
┌───────────────────────────────────────────────────────────────┐
│                        浏览器 (Web UI)                          │
│  ChatGPT 风格聊天页 · 登录/注册 · 多轮会话 · Skill 面板 · 引用溯源 · 打字机流式  │
└───────────────┬───────────────────────────────┬───────────────┘
                │ REST (会话/消息/文档/用户管理)   │ SSE (POST /v1/chat → 事件流)
                ▼                               ▼
┌───────────────────────────────────────────────────────────────┐
│                        Go Agent 服务端                          │
│ ┌────────────┐  ┌─────────────┐  ┌──────────────────────────┐ │
│ │ Gateway    │  │ Auth / RBAC │  │ 会话与上下文管理            │ │
│ │ REST + SSE │  │ JWT + 角色   │  │ conversation / message   │ │
│ └─────┬──────┘  └──────┬──────┘  └────────────┬─────────────┘ │
│       ▼                ▼                       ▼              │
│ ┌─────────────────────────────────────────────────────────┐   │
│ │                  Agent Core（单 Agent 循环）               │   │
│ │  接收用户消息 → 组装上下文(+RAG) → LLM 推理(stream)        │   │
│ │    → 模型请求 tool_call → Skill 执行 → 结果回填           │   │
│ │    → 继续推理直至回复完成（工具轮次上限 N=5）               │   │
│ └───────┬───────────────────────────────────┬────────────┘   │
│         ▼                                   ▼                │
│ ┌──────────────┐                  ┌─────────────────────┐    │
│ │ Skill 注册表   │                  │ RAG 服务             │    │
│ │ registry +    │                  │ 文档解析→分块→向量化   │    │
│ │ 内置 Skill 集  │                  │ 检索→拼装引用上下文    │    │
│ └──────────────┘                  └──────────┬──────────┘    │
│                                              │               │
│  ┌────────────────── Model Provider 抽象层 ────┘               │
│  │  Chat(stream+tools) · Embedding · 可配置多供应商/密钥轮换     │
│  └──────────────┬───────────────────────────────────────────┘ │
└─────────────────┼──────────────────────────────────────────────┘
                  ▼
   ┌──────────────┴────────────────────────────┐
   │ PostgreSQL (+pgvector)     Redis          │
   │ 用户/会话/消息/文档/chunk   缓存/限流/队列  │
   │ Skill 运行审计 / 学情记录                  │
   └───────────────────────────────────────────┘
```

### 3.2 一次对话的端到端时序（含工具调用）

```
User ──POST /v1/chat {conversation_id, content}──▶ Gateway
Gateway ──(鉴权/限流/持久化 user message)──▶ Agent Core
Agent Core: 1. 载入会话历史
           2. (可选)调用 RAG.retrieve(query) 拿课程知识片段
           3. 组装 messages + tools[]（当前模式可用 Skill 的 JSON Schema）
           4. LLM 流式推理
SSE 事件:  ├─ event:tool_call  (模型请求调用 skill_x, args…)
           ├─ Agent 执行 Skill（写库+审计）
           ├─ event:tool_result (结果摘要/引用)
           ├─ 再次 LLM 推理 → 循环直至无 tool_call
           └─ event:delta → event:done (完整 assistant 消息落库)
```

---

## 4. 核心模块设计

### 4.1 前端（`web/`）—— 参考 GPT 交互

**基础能力（首版必须包含）**：

- **账号体系（登录/注册）**：登录页、注册页（用户名+密码，注册默认 student 角色）；JWT access token 存内存/`localStorage`，axios 请求拦截器自动附带；401 时用 refresh token 静默续期，失败跳转登录页；前端路由守卫按登录态与角色（student/teacher/admin）控制访问。
- **多轮对话**：新建会话、会话列表（按更新时间倒序，支持标题）、继续历史对话（消息记录分页加载）、删除/重命名会话；每轮 user/assistant 消息即时落库，页面刷新后可恢复完整上下文；发送中禁止重复提交，支持手动「停止生成」。
- **错误与边界处理**：登录态失效、网络断连（SSE 自动重连）、模型/服务异常均有可见反馈与重试入口。

**界面与交互（参考 GPT）**：

- **布局**：左侧会话历史列表；主区消息流 + 底部输入框；对话中可折叠展示 **Skill 调用卡片**（skill 名、参数、结果摘要、耗时），类似 ChatGPT 工具执行展示。
- **模式切换**：顶部/设置中选择「学伴｜练习｜教师」，决定会话的 `mode`，进而决定可用 Skill 与系统提示词。
- **流式渲染**：基于 SSE `delta` 打字机输出；Markdown + 数学公式（KaTeX）+ 代码高亮（针对学科答疑）。
- **引用溯源**：RAG 引用以角标卡片展示（`[1] 出自《课程讲义》第2章 P3`），点击查看原文片段，教育场景要求"答案有出处"。
- **Skill 面板**：展示当前模式可用 Skill 及说明，点击可预填指令（如"生成5道一元二次方程练习题"）；对话自然命中时也可自动触发。
- **路由/状态**：React Router + 轻量状态管理（Zustand）；SSE 客户端封装、断线重连、请求中断（AbortController 用于停止生成）。

关键页面：
1. `/login`、`/register`（账号认证，公共路由）
2. `/chat`（默认，GPT 风格聊天；未登录重定向到 `/login`）
3. `/conversations` / 会话历史管理
4. `/library`（课程资料库：上传文档、查看分块与检索命中）
5. 设置页（模型供应商配置仅管理员可见、个人偏好）

### 4.2 Agent 内核（Go，单 Agent 循环）

- 以 **OpenAI function calling（tools）协议** 驱动：模型能力只做"意图理解 + 工具参数生成 + 语言组织"，所有外部动作经 Skill 完成。
- 循环流程（带轮次上限，防死循环）：
  1. 组装上下文：系统提示词（按 mode）+ 历史 + RAG 命中片段 + 当前可用 Skill 的 tool schema。
  2. `Model.ChatStream(messages, tools)`。
  3. 若响应含 `tool_calls` → 逐个执行 Skill → 把 `role:tool` 结果追加 → 回到 2。
  4. 否则助手文本完成 → 结束。
- 关键约束：
  - 每轮工具调用次数与总轮数设上限（默认 max_tool_rounds=5）。
  - 每轮把 token 用量与耗时写入审计（`skill_runs` 表），供学情与成本分析。
  - 流式：LLM 的 SSE 增量统一转换为业务 SSE 事件下行。
- 会话模式（mode）不是多个 Agent，而是同一 Agent 的**配置切面**：

| 配置 | 学伴模式 | 练习模式 | 教师模式 |
|---|---|---|---|
| 系统提示词 | 苏格拉底式引导、不直接给答案倾向 | 出题/批改纪律、评分标准 | 教案结构、教学目标对齐 |
| 默认可用 Skill | 知识库检索、讲解 | +出题、批改、学情分析 | +教案生成、批量批改 |
| RAG 强度 | 高（引用课程资料） | 中 | 中 |

### 4.3 Skill 体系（内置 Skill 调用）

**Skill 接口（Go）**：每个 Skill 实现统一接口：

```go
type Skill interface {
    Name() string                                    // 如 "quiz_generator"
    Description() string                             // 给 LLM 看，说明何时用、做什么
    Schema() map[string]any                          // JSON Schema，注册为 tool
    Modes() []Mode                                   // 哪些模式可用
    Execute(ctx context.Context, args json.RawMessage) (*SkillResult, error)
}
type SkillResult struct {
    Content   string      // 回填给模型的文本结果
    Artifacts []Artifact  // 结构化产物（如题目 JSON / 批改报告），可持久化
    Citations []Citation  // 引用的知识库片段
    Cost      Usage
}
```

**内置 Skill 清单（v0.1 起步，按优先级实现）**：

| Skill | 说明 | 场景 |
|---|---|---|
| `knowledge_retrieve` | 检索当前课程知识库（RAG 内部调用 + 可被模型直接触发） | 学伴 |
| `explain_topic` | 针对概念做分步讲解（结构化：定义→例子→易错点→小测） | 学伴 |
| `quiz_generator` | 按知识点/难度/题型出题，产出结构化题目 JSON | 练习/教师 |
| `answer_grader` | 按参考答案+评分标准批改，产出批改报告与得分 | 练习/教师 |
| `mistake_diagnosis` | 结合错题分析薄弱知识点（写入学情） | 练习 |
| `lesson_plan` | 生成教案/讲义草稿（大纲→目标→活动→作业） | 教师 |
| `student_progress` | 查询/汇总学生学情统计，供教师看板 | 教师 |

注册与审计：启动时注册进 `registry`；每次执行写 `skill_runs`（谁、哪个会话、参数、结果摘要、耗时、成功与否），失败自动纳入模型可见的错误信息重试或兜底回答。

### 4.4 RAG 课程知识库

- **入库管线**（教师端上传）：文档 → 解析（txt/md/docx/pdf）→ 分块（按标题层级/段落，单块 ≤ 800 tokens，保留重叠）→ Embedding → 写入 `document_chunks(chunk, embedding vector, source_ref)`。
- **检索**：问题（或 Agent 提炼的 query）向量化 → pgvector `<=>` 余弦相似 Top-K → 按课程/班级隔离过滤 → 组装带出处引用片段注入上下文。
- **溯源**：每条引用携带 `source_ref`（文档 id/章节/页码），模型回答要求标注引用角标，前端渲染成可点击卡片。
- 异步化：上传解析+向量化在 Go 内部 worker 队列执行，SSE/轮询返回处理状态。

### 4.5 模型接入抽象（Model Provider，OpenAI 架构）

- 协议以 **OpenAI Chat Completions** 为准：`messages + tools(function calling) + stream`，Embedding 走 OpenAI Embedding API（text-embedding-3-small，1536 维）。
- 抽象接口解耦供应商：

```go
type ChatRequest struct { Messages, Tools, Stream bool, ... }
type Model interface {
    ChatStream(ctx, ChatRequest) (<-chan StreamEvent, error) // text_delta | tool_calls | usage
    Embed(ctx, []string) ([][]float32, error)
}
```

- 供应商 = 配置项（base_url + api_key + model 名），默认 OpenAI，密钥存服务端环境，绝不下发前端。
- 预留降级：主供应商超时/限流 → 备用 OpenAI 兼容端点（如通义），M2 后可置。

---

## 5. 数据模型（PostgreSQL 核心表草案）

```
users(id, username unique, password_hash, display_name, role[student|teacher|admin],
      refresh_token_hash?, created_at)
courses(id, name, subject, grade, teacher_id, created_at)          -- 课程
course_members(id, course_id, user_id, role)                        -- 班级/成员
conversations(id, user_id, course_id?, mode, title, system_seed?, created_at)
messages(id, conversation_id, role[user|assistant|tool], content,
         tool_calls jsonb, skill_result jsonb?, citations jsonb?,
         model, usage jsonb, created_at)
documents(id, course_id, uploader_id, filename, content_type,
          storage_key, status[parsing|ready|failed], chunk_count, created_at)
document_chunks(id, document_id, seq, content, source_ref,
                embedding vector(1536), created_at)                 -- pgvector
skill_runs(id, conversation_id, message_id?, user_id, skill_name,
           args jsonb, result_summary, status, duration_ms, usage jsonb, created_at)
progress_stats(id, user_id, course_id, skill_point, stats jsonb, updated_at) -- 学情
```

> 索引：`conversations(user_id, updated_at desc)`、`messages(conversation_id, seq)`、`document_chunks(document_id)`、HNSW 索引于 embedding；Redis 仅存临时态（限流/幂等/队列），不存权威数据。

---

## 6. API 设计草案

### REST（JSON）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/auth/register` | 注册（用户名/密码，默认 role=student） |
| POST | `/v1/auth/login` | 登录，下发 access token + refresh token |
| POST | `/v1/auth/refresh` | 用 refresh token 换新 access token |
| POST | `/v1/auth/logout` | 注销（服务端吊销 refresh token） |
| GET | `/v1/auth/me` | 当前用户信息（含角色） |
| GET/POST | `/v1/conversations` | 会话列表 / 新建（带 mode、course_id） |
| GET/PATCH/DELETE | `/v1/conversations/{id}` | 详情 / 重命名 / 删除会话 |
| GET | `/v1/conversations/{id}/messages` | 历史消息（游标分页，多轮对话续载） |
| GET/POST/DELETE | `/v1/courses`, `/v1/courses/{id}/documents` | 课程与资料管理 |
| GET | `/v1/documents/{id}/chunks` | 查看分块（调试/溯源） |
| GET | `/v1/skills` | 当前可用的 Skill 清单（前端面板渲染） |
| GET | `/v1/skill_runs` | 运行审计查询（教师/管理员） |

### SSE 对话（核心）
```
POST /v1/chat            body: {conversation_id, content, mode?, course_id?}
→ text/event-stream，自定义事件：
  event: meta        数据:{conversation_id, message_id}
  event: tool_call   数据:{name, arguments}          # 开始执行 skill
  event: tool_result 数据:{name, summary, citations}
  event: delta       数据:{text}
  event: citation    数据:[{doc, section, snippet}]  # RAG 命中
  event: done        数据:{message_id, usage, duration_ms}
  event: error       数据:{code, message}
前端可用 EventSource/fetch reader；支持 AbortController 停止生成。
```

---

## 7. 部署架构（阿里云）

```
阿里云 ECS (Ubuntu) ── Docker Compose
├── nginx        TLS 443 → 前端静态资源 + 反向代理 /v1 → go-app
├── go-app       Agent 服务端（多副本横向扩展时 SSE 经 SLB；首版单副本）
├── postgres     + pgvector（数据卷持久化；后期可迁云数据库 RDS PG）
└── redis        （可选云 Redis）
文档原文件 → 挂载数据卷（后期迁 OSS + 预签名上传）
```

- 首版 1 台 2C4G ECS 即可支撑数十并发；`go-app` 无状态（会话数据全在 PG/Redis），扩容=加副本 + SLB。
- 配置经环境变量（`APP_ENV`/`.env`），密钥走 ECS 环境/Secrets Manager。
- 日志 stdout → Docker 采集；预留 Prometheus 指标（请求量、SSE 时长、工具成功率、token 消耗）。

---

## 8. 仓库目录结构（monorepo 草案）

```
sfh_workplace/
├── Agent.md                 # 本文档
├── web/                     # React + Vite + TS
│   ├── src/
│   │   ├── pages/           # chat / library / settings …
│   │   ├── components/      # MessageList, SkillCard, CitationCard, Composer…
│   │   ├── api/             # REST + SSE 客户端
│   │   └── stores/
│   └── ...
└── server/                  # Go
    ├── cmd/api/main.go
    ├── internal/
    │   ├── gateway/         # HTTP 路由、SSE、中间件(auth/限流/CORS)
    │   ├── auth/
    │   ├── agent/           # Agent Core 循环、上下文组装
    │   ├── skill/           # registry + 各内置 skill
    │   ├── rag/             # ingest(解析/分块/向量化) + retrieve
    │   ├── model/           # OpenAI 兼容 provider、配置、降级
    │   ├── store/           # PG(pgx) + Redis 数据访问
    │   └── types/           # 共享模型
    ├── migrations/          # SQL 迁移
    └── go.mod
```

---

## 9. 里程碑（建议节奏）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0 骨架打通** | monorepo 初始化；users 建表 + 注册/登录/refresh/me；Go 起 REST+SSE `/v1/chat`（无工具）；前端登录/注册页 + GPT 风格聊天页 + 会话列表/多轮续载 + 流式打字机 | ✅ 完成：注册登录 → 新建会话 → 多轮对话流式回复并落库，刷新可恢复 |
| **M1 Agent + Skill** | tools 协议循环；Skill 框架 + 首批 Skill（quiz_generator / explain_topic / knowledge_retrieve 占位）；Skill 调用卡片 UI | ✅ 完成：function calling 工具循环（上限 5 轮）、Skill 面板、Demo 模式可无 key 触发 quiz_generator |
| **M2 RAG** | 文档上传/解析/向量化/检索 + 引用溯源 UI | 问答命中课程资料并可溯源 |
| **M3 教育业务** | 课程/班级/角色权限；测评 skill（批改、诊断）；学情统计；教师端 | 学生练习→批改→学情闭环 |
| **M4 上线** | 阿里云 Compose 部署、限流、审计、监控、README/运维文档 | 生产可运行 |

---

## 10. 待定事项 / 风险

**已定决策**：
- ✅ 模型接入：OpenAI 架构（Chat Completions + function calling），Embedding 用 text-embedding-3-small（1536 维）。
- ✅ 账号体系：自研 JWT（用户名密码 + 角色 + refresh token），不接学校 SSO。

**仍待定 / 风险**：

1. **模型型号与配额**：默认对话模型选型（gpt-4o-mini vs 更强模型）与预算/限流策略，M1 联调前定。
2. **内容安全**：教育合规——敏感词过滤、低龄保护、模型输出审查策略需在产品侧评审。
3. **批改客观性**：主观题批改仅作辅助，需在 UI 明示"仅供参考，最终以教师为准"。
4. **课程资料版权**：教师上传内容的使用边界需确认。

---

*本文档为架构草案，决策定稿后进入开发（M0 起）。*
