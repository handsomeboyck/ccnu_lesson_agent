# 教育版 Web 智能体（AI Tutor）整体架构

> 版本：v0.4（Skill v2 = Claude 风格 SKILL.md 文档驱动 + 用户级文件知识库）
> 定位：面向教育场景的 ChatGPT 风格 Web 智能体。前端参考 GPT 交互形态，服务端为单一 Agent 内核 + 可插拔 Skill 编排，支持 **自然对话自动触发** 与 **`/命令` 主动唤起** Skill，具备 **ask_user 向学生提问**能力，可上传 pdf/docx/xlsx 作为资料库供对话检索引用，OpenAI 兼容模型接入。

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

**页面**：`/login` `/register`（公共）；`/` 聊天主界面；**`/library` 我的资料库**（上传 pdf/docx/xlsx/txt，列表/删除/解析状态）；**`/skills` 技能管理**（teacher/admin 增删改 SKILL.md，实时生效）。设置页为规划。

### 4.2 Agent 内核（`server/internal/agent`，单 Agent 双路径）

- **路径 A 工具循环**：OpenAI function calling 驱动；模型只做意图/参数/语言组织，动作经 Skill。
  - 组装上下文：模式系统提示词（行为准则含：信息不足用 ask_user、答完提问续接任务、涉及"我上传/讲义/资料"先 knowledge_retrieve）+ 历史 + tools。
  - 循环：`ChatStream` → 有 `tool_calls` 则逐个执行 Skill → `role:tool` 回填 → 继续；无调用即结束。轮次上限 `MaxToolRounds=5`。
  - **ask 中断**：Skill 返回 `Result.Ask`（如 ask_user 或文档技能 `ASK_QUESTION:` 协议）→ 发 `ask` 事件并**暂停**；问题作为助手消息落库，学生回答后续接。
- **路径 B `/命令`**：经 `Registry.LookupCommand` 命中平台原语或文档技能 → 按各自 Execute 流程直接执行并流式返回。
- 会话模式（mode）是同一 Agent 的**配置切面**：仅影响系统提示词与可用 Skill 集合。

### 4.3 Skill 体系（Skill v2：SKILL.md 文档驱动）

**两层架构**：
```
skill/
├── registry.go             # Skill 接口 / Registry(含 Remove/LookupCommand) / Ask / AskFor
├── builtin.go              # 注册平台原语（Go 实现）
├── doc.go                  # ★ SKILL.md 文档型技能：解析/Loader/Execute(按文档调模型)/ASK 协议
├── commands.go             # 平台原语的 /命令 别名
├── ask_user.go             # 平台原语：向学生提问（Go，交互暂停）
└── knowledge_retrieve.go   # 平台原语：用户资料库检索（Go，真实实现）

skills/                     # 文档技能目录（SKILLS_DIR，默认 server/skills，部署可挂 volume）
├── quiz_generator/SKILL.md     # 出题（文档驱动）
├── explain_topic/SKILL.md      # 讲解（文档驱动）
└── <新增技能>/SKILL.md         # 用户/教师自行添加，运行时即生效
```

**SKILL.md 格式（Claude 官方风格）**：
```markdown
---
name: quiz_generator          # 技能名（tool/命令标识）
description: 按知识点/数量/难度生成练习题…  # 何时用、做什么
commands: [quiz, 出题]        # /命令别名
modes: []                     # 可用会话模式（空=全部）
version: 1.0.0
---
# 标题
## 执行步骤（模型按此逐步完成）
## 输出格式 / 边界
# 缺参澄清协议：回复首行输出 ASK_QUESTION：问题（可带 ASK_OPTION：选项行）→ agent 转 ask 暂停等待
```

- **平台原语**（Go，不可由用户删改）：`ask_user`（交互）、`knowledge_retrieve`（检索）——本质上交互/检索能力不是"技能"。
- **文档型技能**（用户可增删改）：行为 100% 由 SKILL.md 定义，Execute = 文档作系统指令 + 用户请求 → 调模型完成。新增技能 = 在 skills/ 目录建文件夹写 SKILL.md（页面 `/skills` 或直接文件），**无需改代码/重启**。
- 运行管理：`GET /v1/skills`（列表含 doc/primitive 标记）、`GET /v1/skills/{name}`（详情含全文）、`PUT/DELETE /v1/skills/{name}`（teacher/admin）。

**内置技能现状（v0.4）**：

| 技能 | 类型 | /命令 | 说明 | 模式 | 状态 |
|---|---|---|---|---|---|
| `quiz_generator` | 文档型 | `/quiz` `/出题` | 出题（SKILL.md 驱动，缺主题/数量可用 ASK_QUESTION 澄清） | 全部 | ✅ |
| `explain_topic` | 文档型 | `/explain` `/讲解` | 结构化讲解（SKILL.md 驱动） | 全部 | ✅ |
| `knowledge_retrieve` | 平台原语 | `/search` `/检索` | 检索**用户资料库**，命中带 `[出处：文件名]` | 全部 | ✅（关键词检索） |
| `ask_user` | 平台原语 | `/ask` `/提问` | 提问并等待学生回答（可带快捷选项） | 全部 | ✅ |
| `answer_grader`/`lesson_plan` 等 | - | - | 可自行以 SKILL.md 添加 | - | ⛔ 未实现（M3） |

**如何扩展（不再写 Go！）**：`/skills` 页面（teacher/admin）或直接在 `skills/<名称>/SKILL.md` 写文档 → 保存即注册生效（运行时热加载）。前端 `/命令` 菜单与技能面板自动出现，无需改代码。

### 4.4 文件知识库（用户级资料库）

- 上传：`POST /v1/library/files`（multipart，pdf/docx/xlsx/txt/md/csv，≤30MB）→ 异步解析 `parsing→ready|failed`。
- 解析：`internal/ingest` 纯 Go —— PDF(ledongthuc) / DOCX(标准库 zip+xml，兼容两种分隔符) / XLSX(excelize) / 文本；.doc 老格式提示转 .docx。
- 存储：`documents` + `document_chunks`（按 800 字/重叠 120 分块）。
- 检索：`SearchChunks`（Postgres ILIKE；中文 2-gram 分词；内存版同语义）→ knowledge_retrieve 把命中片段带出处注入上下文，模型引用作答。
- 升级点：检索层已抽象，后续可换 pgvector + embedding（1536 维）。

### 4.5 模型接入（`server/internal/model`）

- OpenAI Chat Completions 流式：文本 delta 实时、tool_calls 分片聚合（wire 格式：`type=function` + arguments 为 JSON 字符串——曾踩坑修复）。
- `Provider.ChatStream`（工具循环用）与 `Provider.Complete`（Skill 内部非流式二次调用用）。
- 无 `OPENAI_API_KEY` 时启用 DemoProvider（可模拟 quiz 触发与结构化回填），保证本地无网可联调。

### 4.6 代码沙箱（`execute_code` 平台原语 · 设计定稿，待实现）

**目标**：让 Agent 具备"编写并执行 Python 代码"能力（Code Interpreter / Claude Code 形态）——
既能解决文件解析生态短板（老 .doc / 扫描 PDF OCR / 复杂表格），也向所有 SKILL.md 技能开放通用计算能力
（数据统计、可视化、格式转换等）。

**已定决策**：
- 沙箱底层：**Docker 一次性容器**（每次执行 `docker run --rm`），ECS 已具备 Docker；
  镜像 `ccnu_codex:latest`（python:3.12-slim + pdfplumber/PyMuPDF/python-docx/openpyxl/pandas/numpy/matplotlib/pytesseract 等）
- 范围：**全开放** —— 平台原语 `execute_code`，任何 SKILL.md / 模型均可调用
- 网络：**默认禁网**（`--network=none`）；后续如需联网走单独白名单通道
- 产物：捕获 stdout/stderr/退出码；生成的 png/csv 等作为可展示/下载产物

**执行流程**（复用现有工具循环，无架构变更）：
```
用户 / SKILL.md → 模型调 execute_code{python, files:[docIDs]}
  agent 平台原语：
    ① 从资料库取原文件副本（只读挂载 /in）
    ② docker run 一次性容器（非root / read-only rootfs / tmpfs / --network=none /
       内存CPU限制 / pids限制 / 超时强杀 / 输出上限）执行
    ③ 回传 stdout/stderr/退出码/产物清单 → tool_result 给模型
  SSE: tool_call → tool_result(含输出预览+产物) → delta → done
代码异常 → 错误回填模型 → 自动改代码重试（工具循环天然支持）
```

**安全边界（硬性）**：
- 容器级隔离为第一道（不做黑名单拦截）；`--security-opt no-new-privileges` + 默认 seccomp/apparmor
- **绝不**挂载 Docker socket / 宿主敏感目录；只读挂载用户文件副本，产物经独立目录回传
- 并发上限（如 4）+ 单用户配额 + 单次超时（60s）+ stdout 长度截断 + 执行审计（入库）
- 非通用终端：禁网状态下无 pip install/爬取；不开放系统管理操作

**工程落点（实现时）**：
- `server/internal/codex`：沙箱执行器（镜像构建/运行/清理/限额/产物收集）
- `skill/execute_code.go`：平台原语（注册 + /命令 + Execute）
- 资料库上传需**保留原件**（UPLOAD_DIR 常驻；当前仅可选暂存 → 改为必存，供沙箱读取）
- 前端：运行输出折叠卡片 + PNG 产物渲染/下载
- 里程碑归属：M5 代码沙箱；本地开发需 Docker Desktop（无 Docker 环境时 execute_code 返回明确不可用提示）

---

## 5. 数据模型（PostgreSQL）

实现以迁移文件为准：`server/migrations/0001_init.sql`、`0002_library.sql`，启动时自动执行（幂等 `IF NOT EXISTS`）。

```
users(id, username unique, password_hash, display_name, role, created_at)
refresh_tokens(hash pk, user_id FK, expires_at)
conversations(id, user_id FK, title, mode, course_id, created_at, updated_at)
messages(id, conversation_id FK, role, content, model, usage_json, created_at)
documents(id, user_id FK, filename, ext, size_bytes, status, error, created_at)
document_chunks(id, document_id FK, seq, content, created_at)  -- 关键词检索；预留向量列
```

> 存储架构：`store.Store` 接口 + 两个实现：`memory.go`（无 DATABASE_URL 的开发回退，重启丢数据）与 `postgres.go`（生产）。审计 `skill_runs` 表为规划（M4）。

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
| GET | `/v1/skills` | `{skills:[doc|primitive], commands:[...]}` 供面板与 `/` 菜单 |
| GET | `/v1/skills/{name}` | 文档型技能详情（含 SKILL.md 全文） |
| PUT | `/v1/skills/{name}` | 新增/覆盖文档型技能（teacher/admin，热生效） |
| DELETE | `/v1/skills/{name}` | 删除文档型技能（teacher/admin） |
| GET | `/v1/library/files` | 我的资料库文件列表 |
| POST | `/v1/library/files` | 上传（multipart `file`，≤30MB，异步解析） |
| DELETE | `/v1/library/files/{id}` | 删除文件及其分块 |
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
├── deploy/                 # 阿里云部署脚本 / nginx 模板 / 导出与验证脚本
├── web/                    # React 19 + Vite + TS
│   └── src/{pages(chat,skills,library,login,register),api,store,types.ts,index.css}
└── server/                 # Go 1.27
    ├── cmd/api/main.go     # 入口：配置/存储选择/SKILL 加载/静态托管
    ├── internal/
    │   ├── agent/          # 工具循环 + /命令 + ask 中断
    │   ├── auth/           # JWT/PBKDF2/注册登录刷新 + requireRole
    │   ├── config/         # .env 加载 + 配置
    │   ├── gateway/        # REST + SSE + CORS + 技能/资料库管理
    │   ├── ingest/         # 文件解析（pdf/docx/xlsx/txt → 分块）
    │   ├── model/          # OpenAI 兼容 / Demo Provider
    │   ├── skill/          # Skill v2：平台原语 + SKILL.md 文档技能（doc.go/Loader）
    │   └── store/          # Store 接口 + memory + postgres（documents/chunks）
    ├── skills/             # ★ SKILL.md 文档技能目录（运行时热加载）
    ├── migrations/         # SQL 迁移（go:embed 自动执行：0001 基础 + 0002 资料库）
    ├── .env(.example)      # 本地配置（不提交 .env）
    └── go.mod
```

---

## 9. 里程碑（状态）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0 骨架** | monorepo；JWT 认证；会话 CRUD；SSE 流式；登录/注册 + GPT 风格多轮聊天 | ✅ 完成 |
| **M1 Agent+Skill** | function calling 循环（≤5 轮）；调用卡片 UI；真实模型链路 | ✅ 完成 |
| **M1.5 交互增强** | `/命令`；`ask_user`；Skill 面板/`/`菜单；wire 格式与 StrictMode 修复 | ✅ 完成 |
| **Skill v2** | SKILL.md 文档驱动（Claude 风格）；平台原语与文档技能分层；运行时管理页 `/skills` | ✅ 完成 |
| **文件知识库** | 用户级资料库上传(pdf/docx/xlsx/txt)解析、关键词检索、对话引用带出处、页面 `/library` | ✅ 完成（关键词版；向量化预留） |
| **M2 增强** | 向量检索升级（pgvector+embedding 1536）、doc(.doc) 支持、跨用户分享 | ⛔ 未开始 |
| **M3 教育业务** | 课程/班级/角色权限；answer_grader、lesson_plan 等 Skill；学情统计；教师端 | ⛔ 未开始 |
| **M5 代码沙箱** | execute_code 平台原语（Docker 一次性容器、禁网、产物回传）；文件解析迁移到沙箱（.doc/OCR/复杂表格）；前端输出与图表展示 | ⛔ 未开始（设计已定稿见 §4.6） |
| **M4 上线** | Postgres（完成）；Docker + compose + 阿里云 ECS 部署（完成，https://www.ccnu.chat 在线）；限流、审计(skill_runs)、监控 | 🔄 大部分完成 |

分支约定：`master` 稳定分支仅合入已验收版本；日常开发在 `develop`。

---

## 10. 已定决策 / 待定风险

**已定**：
- ✅ 模型：OpenAI 架构 Chat Completions；生产 DeepSeek（www.ccnu.chat）。
- ✅ 账号：自研 JWT（PBKDF2-SHA256，refresh 轮换），不接 SSO。
- ✅ Skill：双层（平台原语 Go + 文档型 SKILL.md）；模型自觉 / `/命令` / 缺参 ASK 澄清。
- ✅ 资料库：用户级文件知识库（上传解析 → 分块 → 关键词检索 → 引用注入）。
- ✅ 存储/部署：Postgres 权威源；Docker Compose + Go 单进程托管前端；阿里云 ECS + Nginx TLS。

**待定 / 风险**：
1. 对话模型型号与配额/限流策略。
2. 内容安全：敏感词/低龄保护/输出审查（教育合规）。
3. 主观题批改仅辅助，UI 需明示"仅供参考"。
4. 课程资料版权边界；上传文件的存储与合规（现仅存解析文本，原文件可暂存 UPLOAD_DIR）。
5. 关键词检索精度 → 向量化升级（文档已留接口）；扫描版 PDF 需 OCR（暂不支持）。
6. TLS 已就绪（acme 自动续期）；日志监控/审计表待完善。

---

*本文档随代码演进维护；与实现不一致时以代码为准并回更本文档。*
