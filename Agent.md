# 教育版 Web 智能体（AI Tutor）整体架构

> 版本：v1.2（生产版 —— Skill v2 = Claude 风格 SKILL.md + 文件知识库 + Python 代码沙箱 execute_code 产物体系 + 消息级附件多轮记忆 + 华师主题 UI + 移动端适配 + 公开首页 + 数学公式渲染 + 监控/审计 + LLM 缓存监控）
> 定位：面向教育场景的 ChatGPT 风格 Web 智能体。前端参考 GPT 交互形态、浅色学术 UI（华中师范大学品牌：华师蓝主色 + 宋体标题 + 金辅点缀）；`/` 为**公开首页**（能力介绍 + 注册引导），登录后进 `/chat` 对话；支持**移动端底部 Tab 导航**与响应式布局。服务端为单一 Agent 内核 + 可插拔 Skill 编排，支持 **自然对话自动触发** 与 **`/命令` 主动唤起** Skill（文档型技能均**流式执行**、无需展开工具卡即可见产物），具备 **ask_user 向学生提问**能力，可上传 pdf/docx/xlsx（含老式 .doc/.xls）作为资料库供对话检索引用，支持**消息级多文件附件**（上传即读、同会话多轮追问免重传、刷新自动恢复会话与草稿），可通过 **Python 代码沙箱（execute_code，256m 限额）** 完成解析/计算/绘图并产出 docx/pptx/xlsx/pdf/png 等持久化产物（**中文文件名可用**）；Markdown 中的 LaTeX 公式（$...$/$$...$$）由 **KaTeX** 渲染；提供**监控中心**（仅 admin：Agent 指标、LLM 缓存命中率、宿主/容器资源、Postgres 状态、全站对话审计与导出）；OpenAI 兼容模型接入。

---

## 1. 项目定位与范围

**一句话**：一个"智能助教 / 练习测评 / 教师辅助"三种模式共存的单 Agent Web 应用。用户在对话中自然唤起 Skill（由模型自觉），也可输入 `/命令` 强制唤起；Agent 信息不足时会通过 `ask_user` 提问澄清，而不是臆测参数。

### 1.1 目标用户与场景

| 角色 | 典型场景 | 涉及 Skill |
|---|---|---|
| 学生（智能助教答疑） | 学科答疑、概念讲解、追问、基于课程资料作答 | `explain_topic`、`knowledge_retrieve`、`ask_user` |
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
| 前端 | React 19 + Vite 8 + TypeScript | SPA（`web/`）；react-markdown + remark-gfm + **KaTeX（数学公式）** 渲染、Zustand 状态、React Router；移动端底部 Tab + 响应式 |
| 后端 | Go 1.27（`net/http` 1.22+ 方法路由），stdlib 为主 + pgx 驱动 | Agent 服务端；`server/` |
| 实时通信 | SSE（Server-Sent Events） | 帧带全局单调 `seq` + 断点续流重放端点（`/v1/chat/stream/{id}`）；事件协议见 §6.2 |
| LLM 接入 | OpenAI Chat Completions + function calling | `OPENAI_*` 三件套配置，兼容 DeepSeek/OpenAI/通义等；本地当前启用 DeepSeek `deepseek-v4-flash` + `reasoning_effort=medium`；无 key 时 Demo 模式可无网联调 |
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
│  │ 文档型 SKILL.md │            │ OpenAI 兼容 / Demo │         │
│  │ + 原语(ask_user │            │ Chat(stream+tools)│         │
│  │ /retrieve/exec)│            │ 技能内层流式执行    │         │
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
- **账号**：登录/注册页（双栏品牌版：华师蓝渐变品牌区 + 表单卡）；密码框**默认隐藏、可点 👁️/🙈 切换明文**；JWT access 自动附带，401 用 refresh 静默续期后重试一次，失败跳登录；路由守卫（admin 专属路由 RequireRole）。
- **多轮对话**：会话列表/新建/重命名/删除/续载；按「今天/昨天/更早」分组 + 模式图标；消息即时落库；**断点续流**（刷新/切换后已生成内容立即续上，见 §4.9）；防重复提交 + 停止生成（Abort）。
- **欢迎引导（物理课程与教学概论语境）**：新对话欢迎区四张快捷卡片 `/diagnose 诊断教学设计` · `/theory 最近发展区设计教学过程` · `/quiz 围绕电场强度概念出 2 个促进思维的问题` · `/search 实验教学中运用物理教学模式和方法`（点击填入输入框）。
- **侧栏「正在执行中」动画**：5s 轮询 `/v1/chat/generating` + 本地当前流即时并入 → 会话条目标题右侧旋转 spinner（`GeneratingIndicator`）；完成/停止自动消失。
- **错误与边界**：登录失效、断线、异常均有反馈。

**交互能力**：
- **`/` 命令菜单**：输入框键入 `/` 弹出 Skill 命令列表（继续输入过滤，Tab/点击补全为 `"/cmd "`）。
- **ask_user 交互**：收到 SSE `ask` → 助手气泡显示问题 + 「等待回答」横幅 + 快捷选项按钮；学生回答后自动继续原任务。
- **Skill 调用卡片**：流式中展示 `⚙调用中 → ✓完成(摘要)`；**产物卡片化**（文件类型图标 WPS/Office 风格 FileIcon：Word📝/Excel📊/PPT📽️/PDF📕…），图片即时预览、docx 可点弹窗网页渲染正文（mammoth）、pdf 内嵌查看器、每卡常驻「⬇ 下载」。
- **流式渲染**：Markdown + 打字机光标（注意：delta 追加必须是**纯 updater**，避免 StrictMode 双调导致逐字重复——已修复）。
- **模式切换**：智能助教/练习/教师（胶囊分段控件）；新会话选模式，历史会话沿用其模式。
- **Skill 面板**（新对话时）：顶部胶囊列出 `/命令`，点击自动填入。
- **消息级附件**：输入框 📎 多选（或**拖拽文件到消息区**）→ 上传解析入库 → chips 展示（可删/大小/类型图标）→ 随消息发送（见 §4.5）。

**页面**：`/login` `/register`（公共）；`/` 聊天主界面（欢迎屏=品牌首屏 + 能力引导卡）；**`/library` 我的资料库**；**`/artifacts` 产物库**（docx/pdf 等网页预览）；**`/skills` 技能管理**；**`/monitor` 监控中心**（仅 admin：指标/宿主/审计，见 §4.6）。

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

**内置技能现状**：

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
- 解析（`internal/ingest`，**沙箱优先 + Go 回退**）：
  - 沙箱通道（`ingest/sandbox.go`，包级注入 `ingest.SandboxParse`，main.go 装配）：codex 沙箱执行脚本，**MarkItDown**（微软开源，pdf/docx/pptx/xls/xlsx 统一转 Markdown）优先、**PyMuPDF** 兜底（中文 CID 字体 PDF 提取可靠，修复 ledongthuc 乱码问题）；结果经 `/out/extract.md` 产物通道回传（规避 stdout 64KB 截断）；
  - 本地回退：纯 Go —— PDF(ledongthuc) / DOCX(标准库 zip+xml) / XLSX(excelize) / XLS(extrame) / 文本；.doc 走 antiword；
  - 兜底检测 `looksReadable`：无效 UTF-8 / 大量 U+FFFD 视为不可读 → 明确失败提示（避免静默入库乱码），已入库乱码文档需重新上传。
- 存储：`documents` + `document_chunks`（按 800 字/重叠 120 分块）。
- 检索：`SearchChunks`（Postgres ILIKE；中文 2-gram 分词；内存版同语义）→ knowledge_retrieve 把命中片段带出处注入上下文，模型引用作答。
- 升级点：检索层已抽象，后续可换 pgvector + embedding（1536 维）。

### 4.5 消息级附件与多轮记忆（对话中上传文件即读）

**场景**：学生在对话中直接附加文件（pdf/docx/xlsx/txt/md/csv，每次 ≤5 个、单个 ≤30MB），AI 读取内容作答，且**同会话后续追问无需重传**。

- 前端：输入框 📎 多选 + **拖拽到消息区**；选中文件以**文件卡片**展示（`FileCard`，对标 DeepSeek Chat：类型图标/文件名/大写扩展名/大小/可删）；上传为**同步解析**——`POST /v1/chat/attachments`（multipart `files`，可多文件）解析完成才返回 `doc_id`（`status=ready`，无 OCR；不做"解析未完就对话"的竞态）。
- **解析等待期动效**（解析到发送之间的延迟反馈）：卡片图标位 → 旋转 spinner + 状态行「解析中...」+ 底部**不确定进度条**（滑动动画）；解析完成自动恢复；**失败卡片**（「上传失败」+ 原因）保留在输入区可**点击重试**（重传成功后直接作为消息发送）或移除；全失败且无文字输入时不发空消息；发送按钮解析中禁用并显示 spinner（`title="文件解析中…"`）。
- 存储：附件与资料库上传**同库**（自动成为用户资料库文件，可复用/删除）；`conversation_attachments(conv_id, doc_id)` 记录"会话用过哪些文件"（迁移 0006），会话删除级联解绑、**文件保留在资料库**。
- 对话注入（chat handler）：
  - **首轮**（本条带 attachments）：把文件正文（docFullText 由 document_chunks 重组，每文件 ≤4000 字、单轮 ≤12000 字）**全量注入**发送给模型的那条 user 消息（存储仍保持原文，仅模型可见富文本）；
  - **后续追问**（无新附件）：会话存在关联文件 → 按当前问题关键词在关联文件分块中检索 topK 注入（多轮记忆，无需重传/点名）；
  - 注入前带【系统提示】强指令：内容已给出应**直接阅读使用**，除非用户明确要求检索整个资料库，否则**不要调用 knowledge_retrieve**（SystemPrompt 行为准则同步区分"本条已附文件段落"与"仅提及我的资料"两种情形——曾因检索误导导致模型忽略已注入内容，已修复）。
- 纯附件消息（无文字）默认指令"请阅读我上传的文件并给出简要总结"。

### 4.6 监控中心与运营审计（仅 admin）

**后端采集**
- Agent 指标：每次对话/工具调用/沙箱执行写 `metric_events`（迁移 0005：kind=chat|tool|codex、mode、status、token、耗时）；chat 埋点用**独立 context**（客户端断开不丢事件）。
- 宿主/容器指标：codex-worker `GET /metrics/sys` 经 compose 把宿主根只读挂载到 `/host`，statfs 读磁盘、/proc 读内存/负载/核数（linux build tag），并 `docker ps` + `docker stats` 采样本 compose 三容器。
- Postgres 状态：`SystemStats`（连接数/库大小/缓存命中/事务）——store 可选接口 `SystemStatsProvider`。

**API（均 admin）**
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/monitor/overview` | 聚合快照：Agent 指标（24h 桶/分位/分布）+ db + host/containers |
| GET | `/v1/monitor/health` | app/db/codex 健康 |
| GET | `/v1/monitor/conversations` | 全站会话审计（join 用户名） |
| GET | `/v1/monitor/conversations/{id}` | 单会话完整问答（user/assistant 成对） |
| GET | `/v1/monitor/conversations/{id}/export` | 单会话导出 txt |
| GET | `/v1/monitor/conversations/export-all` | **一键导出全部会话 zip**（按用户分文件夹 + manifest.csv） |
| POST | `/v1/chat/attachments` | 消息级附件上传（多文件同步解析，见 §4.5） |

**前端 `/monitor`**：健康条、Agent 指标卡（对话/token/延迟 P50/P95/沙箱成功率/错误）、24h 逐小时双柱图（对话蓝/工具金）、模式与技能分布、ECS 宿主（含磁盘使用率，>80% 红色告警）、容器 CPU/内存、PostgreSQL 状态；「用户对话审计」区（搜索用户/标题、查看问答弹窗、单会话导出、一键 zip 导出、复制清单）；每 15s 自动刷新。侧栏仅 admin 可见「🛰️ 监控中心」。

### 4.7 模型接入（`server/internal/model`）

- OpenAI Chat Completions 流式：文本 delta 实时、tool_calls 分片聚合（wire 格式：`type=function` + arguments 为 JSON 字符串——曾踩坑修复）。
- `Provider.ChatStream`（工具循环用）与 `Provider.Complete`（Skill 内部非流式二次调用用）。
- 无 `OPENAI_API_KEY` 时启用 DemoProvider（可模拟 quiz 触发与结构化回填），保证本地无网可联调。

### 4.8 代码沙箱（`execute_code` 平台原语 · 已实现，挂件式）

**目标**：让 Agent 具备"编写并执行 Python 代码"能力（Code Interpreter / Claude Code 形态）——
既能解决文件解析生态短板（老 .doc / 扫描 PDF OCR / 复杂表格），也向所有 SKILL.md 技能开放通用计算能力
（数据统计、可视化、格式转换等）。

**实现要点**：
- 沙箱底层：**Docker 一次性容器**（`docker run --rm`）+ 独立 **codex-worker 服务**（compose 中 `codex`，
  挂 docker.sock + 共享作业目录 + 宿主根只读 `/host`），app 经 HTTP 调用；镜像 `ccnu-codex:latest`
  （python:3.12-slim + pdfplumber/PyMuPDF/python-docx/**python-pptx**/openpyxl/pandas/numpy/matplotlib/Pillow/
  pytesseract/**reportlab/fpdf2** + tesseract-ocr 中文 + **LibreOffice(impress)** + **Noto CJK 字体**，≈1.2GB）
- 范围：**全开放** —— 平台原语 `execute_code`，任何 SKILL.md / 模型均可调用
- 网络：**默认禁网**（`--network=none`）
- 产物：捕获 stdout/stderr/退出码；支持 **png/csv/txt/md/json/html/pdf/docx/pptx/xlsx** 收集
  （文本明文、二进制 base64；≤2MB），**持久化到产物库**（`artifacts` 表 + ARTIFACT_DIR 卷），
  对话内即时预览/下载 + **历史会话/产物库页可回看**
- **pptx 自动转 pdf 预览**：作业完成后 worker 发现 .pptx 产物 → 用沙箱镜像内置 LibreOffice headless
  （`soffice --entrypoint`，UserInstallation 置于 tmpfs）自动转同名 .pdf 一并返回（浏览器可网页预览 PPT 内容）。
- 引导模型：Description 说明可生成 docx(试卷)/pptx(课件)/xlsx/pdf(pdf 中文用 reportlab
  `UnicodeCIDFont('STSong-Light')`)，保存到当前工作目录即自动成为可下载产物。
- **挂件式/自愈**：`execute_code` 可在运行时被动态摘除/恢复（`Registry.SetDisabled`）——
  无 CODEX_URL 启动即隐藏；app 每 15s 健康轮询 codex-worker，故障自动摘除、恢复自动再现；
  执行失败降级为提示文本不打断对话（安全底线：无沙箱绝不裸跑用户代码）
- worker 稳定性：restart unless-stopped + healthcheck、**全局并发信号量（默认 2；任务级隔离、无状态一次性容器，
  用完即释放；无用户级限额/公平队列，超限 429——单人多开可占满，多人课堂可被抢先）**、
  60s 超时强杀、内存 512m/1cpu/pids 128、作业目录自动清理；`GET /metrics/sys` 供监控（§4.6）

**执行流程**（复用现有工具循环）：
```
用户 / SKILL.md → 模型调 execute_code{python, files:[docIDs]}
  agent 平台原语：
    ① 从资料库取原文件副本（base64 传 worker → /in 只读）
    ② worker docker run 一次性容器（非root / read-only / tmpfs / 禁网 / 限额 / 超时）执行
    ③ 回传 stdout/stderr/退出码/产物 → app 落盘落库
    ④ 模型上下文只回填文本（产物 base64 不进模型）；产物经 SSE tool_result.artifacts 旁路给前端
  SSE: tool_call → tool_result(含 artifacts) → delta → done
代码异常 → 错误回填模型 → 自动改代码重试（工具循环天然支持）
```

**产物库与历史回看**：
- 每次 execute_code 的产物自动持久化（`artifacts` 表记录 + ARTIFACT_DIR 磁盘文件，storageKey=id_filename），
  并关联 conversation/message
- `/artifacts` 页：网格浏览、**图片缩放 / docx 网页渲染(mammoth) / pdf 内嵌查看 / 文本预览**、下载
  （`GET /v1/artifacts/{id}/raw`，鉴权字节流；`?download=1` 附件下载）、删除
- 历史消息重新展示：assistant 消息存储携带产物摘要（messages.artifacts_json），打开旧会话时前端按 id
  拉取 raw 恢复图片/文件；产物卡片带 WPS/Office 风格类型图标（FileIcon）与常驻「⬇ 下载」
- 流式收尾不闪失：tool_result 产物同步挂到本条 assistant 消息 → 流结束由 HistoryArtifacts 无缝接管
  （图片即时 data-url，避免"闪一下就没了"——已修复）

**安全边界（硬性）**：
- 容器级隔离为第一道（不做黑名单拦截）；`--security-opt no-new-privileges` + 默认 seccomp/apparmor
- **绝不**把 docker.sock 挂给沙箱容器；只读挂载用户文件副本；产物目录 `chmod 777` 供沙箱 uid 1000 写入
- 并发信号量 + 单次超时（60s）+ stdout 截断 + 作业目录清理
- 非通用终端：禁网状态无 pip install/爬取；不开放系统管理操作

**工程落点**：
- `server/internal/codex`：沙箱 Runner + app 侧 HTTP Client（含 Health 探测）
- `server/cmd/codex`：codex-worker 服务
- `skill/execute_code.go`：平台原语（持久化产物、ASK/降级、文件读取）
- `Dockerfile.codex`：sandbox + worker 双 target；compose `codex`/`codex-sandbox` 服务
- 前端：对话工具卡片产物预览 + `/artifacts` 产物库页 + 历史消息产物恢复

### 4.9 断点续流（真续流 · 生成中断开双侧无缝衔接）

**断开语义（共识）**：刷新 / 切换会话 / 断网 **≠ 断开**——生成继续（缓冲/落库/可续流），回来时续流恢复（已生成部分立即显示并继续流式，无「后台生成中」横幅）；**只有手动「停止」才是断开**（终止生成、半截落库、清断点）。实现为三层：

1. **后端流缓冲（`gateway/stream_buffer.go`）**：每个主链路 chunk 字节级注入**全局单调 `seq`**（`buf/bufD/bufRaw`，缓冲与网络帧共用同一 JSON，AI SDK 忽略未知字段）；生成期间**不覆盖不裁剪**（刷新可重放完整历史），`done` 后宽限 10 分钟供重放，随后从注册表移除（上限 20000 帧、尾部保留 4096）。**网络写受 `connected` 门控**：客户端断连后不再写已断开的 TCP 连接（防写阻塞 → handler 卡死 → `genCancel` 残留 → `/v1/chat/generating` 误报），缓冲始终 append、生成/落库照常。
2. **重放端点 `GET /v1/chat/stream/{streamId}?since=N`**（`stream_replay.go`）：返回 `X-Stream-Min-Seq`/`X-Stream-From-Seq` 头；生成期间**长轮询**（50ms 间隔）随生成推送新帧，生成结束补发 `[DONE]`；gap 检测（since < minSeq → 续不上）由前端降级权威兜底。
3. **前端引擎（`web/src/lib/useChatStream.ts` + `useStreamResume.ts` + `streamMerge.ts`）**：自研统一流式引擎（发送/续流/兜底三路径合一）；`seq` 去重 + 80ms 渲染节流 + 300ms 断点节流持久化（`ccnu-stream-resume`：convId/streamId/lastSeq/parts）；`stop(keepResume)` 分离——切换会话保留断点、手动停止清断点；网络错误保留断点；`resume` 支持 `fallbackStreamId`（断点缺失但有 streamId 时纯重放 since=0 重建）；渲染走 `streamMerge.ts` 的 parts 合并器（与 AI SDK parts 形状兼容，卡片组件零改动）。

**兜底**：续流不可用（缓冲过期/服务重启）→ `fallbackWatch`（`/v1/chat/generating` + 2s 轮询 DB 等完成，≤450 次）；`openConversation`/`newChat` 重置「后台生成中」横幅（横幅只在该会话确认生成中且无法续流时出现）。

**工程落点**：`gateway/stream_buffer.go`、`gateway/stream_replay.go`、`gateway/chat_handlers.go`（connected 门控）；`web/src/lib/{useChatStream,useStreamResume,streamMerge}.ts`；`web/src/pages/ChatPage.tsx`（恢复/横幅/执行中轮询）；验证 `web/RESUME_VERIFY.md` + `test-resume-*.mjs`。

---

## 5. 数据模型（PostgreSQL）

实现以迁移文件为准：`server/migrations/0001_init.sql` ～ `0006_*.sql`，启动时自动执行（幂等 `IF NOT EXISTS`）。

```
users(id, username unique, password_hash, display_name, role, created_at)
refresh_tokens(hash pk, user_id FK, expires_at)
conversations(id, user_id FK, title, mode, course_id, created_at, updated_at)
messages(id, conversation_id FK, role, content, model, usage_json, artifacts_json, created_at)
documents(id, user_id FK, filename, ext, size_bytes, status, error, created_at)
document_chunks(id, document_id FK, seq, content, created_at)  -- 关键词检索；预留向量列
artifacts(id, user_id FK, conversation_id, message_id, skill, filename, mime, size_bytes, storage_key, created_at)  -- 产物库
conversation_attachments(conv_id FK, doc_id FK, added_at, PK(conv_id,doc_id))  -- 消息级附件：会话↔文件关联(0006)
metric_events(id, ts, kind(chat|tool|codex), mode, status, skill, prompt_tokens, completion_tokens, duration_ms)  -- 运行指标(0005)
```

> 迁移清单：0001 基础 · 0002 资料库(document_chunks) · 0003 产物库(artifacts) · 0004 历史消息产物(messages.artifacts_json) ·
> 0005 运行指标(metric_events) · 0006 会话附件(conversation_attachments)。
> 存储架构：`store.Store` 接口 + 两实现：`memory.go`（无 DATABASE_URL 开发回退，重启丢数据）与 `postgres.go`（生产）。
> 会话删除：Postgres 经 `ON DELETE CASCADE` 解绑附件记录（文件保留于资料库）。

---

## 6. API 设计

### 6.1 REST（JSON）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/auth/register` `/login` `/refresh` `/logout` | 认证 |
| GET | `/v1/auth/me` | 当前用户 |
| GET/POST | `/v1/conversations` | 列表 / 新建 |
| GET/PATCH/DELETE | `/v1/conversations/{id}` | 详情 / 重命名 / 删除 |
| GET | `/v1/conversations/{id}/messages` | 历史消息（含 artifacts 产物摘要） |
| POST | `/v1/chat` | SSE 流式对话（支持 `/命令`、`attachments:[doc_id…]` 消息级附件） |
| POST | `/v1/chat/attachments` | 消息级附件（multipart `files` 多文件，同步解析入库返回 doc_id） |
| GET | `/v1/skills` | `{skills:[doc|primitive], commands:[...]}` 供面板与 `/` 菜单 |
| GET | `/v1/skills/{name}` | 文档型技能详情（含 SKILL.md 全文） |
| PUT | `/v1/skills/{name}` | 新增/覆盖文档型技能（teacher/admin，热生效） |
| DELETE | `/v1/skills/{name}` | 删除文档型技能（teacher/admin） |
| GET | `/v1/library/files` | 我的资料库文件列表 |
| POST | `/v1/library/files` | 上传（multipart `file`，≤30MB，异步解析） |
| DELETE | `/v1/library/files/{id}` | 删除文件及其分块 |
| GET | `/v1/artifacts` | 产物库列表 |
| GET | `/v1/artifacts/{id}/raw` | 产物文件字节（鉴权；`?download=1` 触发下载） |
| DELETE | `/v1/artifacts/{id}` | 删除产物（含磁盘文件） |
| GET | `/v1/monitor/overview` · `/health` · `/conversations…` | 监控/审计（**仅 admin**，见 §4.6） |
| GET | `/healthz` | 健康检查 |

### 6.2 流式协议（POST /v1/chat，AI SDK UI message stream v1 兼容）

> 传输：SSE 帧 `data: {json}\n\n`，响应头 `x-vercel-ai-ui-message-stream: v1`，收尾 `data: [DONE]`。
> **每个主链路帧带全局单调 `seq`**（字节级注入，AI SDK 忽略未知字段）——断点续流去重/重放的基础（见 §4.9）。
> 前端由自研流式引擎 `useChatStream` 消费（不再依赖 SDK useChat/DefaultChatTransport；parts 合并走 `streamMerge.ts`）。

| chunk type | 字段 | 说明 |
|---|---|---|
| `start` | messageId, seq | 流开始 |
| `reasoning-start/delta/end` | id, delta, seq | 思考链三件套（可折叠展示） |
| `text-start` / `text-delta` / `text-end` | id, delta, seq | 流式文本三件套 |
| `tool-input-start` | toolCallId, toolName, seq | Skill 开始（工具卡片运行态） |
| `tool-input-available` | toolCallId, toolName, input, providerExecuted, seq | 参数就绪（服务端已执行=true） |
| `tool-output-available` | toolCallId, output{summary,artifacts?}, seq | Skill 完成（卡片完成态 + 产物清单） |
| `data-ccnu` | data{type: meta/done…}, seq | 自定义旁路载荷（meta 含 conversation_id + streamId） |
| `finish` | finishReason (stop/error), seq | 流结束 |
| `[DONE]` | — | 终止符（不入缓冲；重放端点结束自行补发） |

> 续流重放：`GET /v1/chat/stream/{streamId}?since=N`（返回 `X-Stream-Min-Seq`/`X-Stream-From-Seq`），
> 刷新/切回时前端由此补拉断点后的帧并继续长轮询直到 `[DONE]`（详见 §4.9）。
>
> 历史回看：`GET /v1/conversations/{id}/messages` 的 assistant 消息带
> `artifacts`（产物摘要）与 `tool_steps`（工具执行轨迹 [{call_id,name,summary,duration_ms,artifacts}]），
> 由前端渲染为持久化工具卡片。

---

## 7. 部署架构（阿里云 · 已上线 https://www.ccnu.chat）

```
阿里云 ECS (2C2G/40G 系统盘) ── Docker Compose
├── app        单进程：API + 前端静态资源（单端口 8080，Nginx TLS 443→8080）
│              环境变量：DATABASE_URL / JWT_SECRET / OPENAI_* / CODEX_URL / PORT
├── db         postgres:16（pgdata 卷；healthcheck）
├── codex      codex-worker：沙箱执行 HTTP（docker.sock + 作业卷 + 宿主根只读 /host + LibreOffice 转换）
└── codex-sandbox  profile 工具：ccnu-codex 沙箱镜像（仅构建）
Nginx（自定义编译 /usr/local/nginx）443 ssl + http2；Let's Encrypt(acme.sh 自动续期)；
client_max_body_size 35m；前端 web/dist 打进镜像由 Go 托管（SPA fallback）
```

构建与运行文件（仓库根）：
- `Dockerfile`：多阶段（node 构建 web → go 构建 server → alpine 运行）
- `Dockerfile.codex`：`sandbox`（Python+LibreOffice 执行环境）与 `worker`（Go + docker CLI）双 target
- `docker-compose.yml`：app + postgres + codex（含 `logging: json-file 10m×3` 日志限容；卷 pgdata/skills/uploads/artifacts）
- `deploy/`：部署脚本、nginx 模板、**cleanup_docker.sh**（部署后回收 dangling 镜像/build 缓存/退出容器——
  勿用 `system prune -a`，曾误删在用沙箱镜像）

**磁盘与运维注意（踩坑实录）**：40G 系统盘易被"多次 `--build` 的旧镜像层 + buildkit 缓存 + 崩溃循环日志"打满
（曾致 Postgres 无法扩展文件、服务反复重启）。缓解：
① 每次部署后执行 `bash deploy/cleanup_docker.sh`（或 crontab 每日）；
② compose 日志限容（json-file 10m×3）防崩溃日志吃盘；
③ 监控页宿主磁盘使用率 >80% 红警（见 §4.6）；
④ 沙箱镜像约 1.2GB，镜像重建是磁盘与时间大户。

---

## 8. 仓库结构（现状）

```
sfh_workplace/（= ccnu_lesson_agent）
├── Agent.md                # 本文档
├── README.md               # 快速开始 / API 摘要
├── Dockerfile / Dockerfile.codex   # app / 沙箱+worker 构建
├── docker-compose.yml      # app + postgres + codex + 日志限容 + 卷
├── deploy/                 # 部署脚本 / nginx 模板 / cleanup_docker.sh(磁盘回收) / 验证脚本
├── web/                    # React 19 + Vite + TS
│   └── src/{pages(chat,skills,library,artifacts,login,register,monitor),components(PasswordField,FileIcon,HistoryArtifacts),api,store,lib,types.ts,index.css}
└── server/                 # Go 1.27
    ├── cmd/api/main.go     # 入口：配置/存储/SKILL 加载/沙箱健康轮询/静态托管/装配 ingest.SandboxParse
    ├── cmd/codex/main.go   # codex-worker（+sysmetrics_linux/other.go：/metrics/sys 宿主指标）
    ├── internal/
    │   ├── agent/          # 工具循环 + /命令 + ask 中断 + 产物旁路 + SystemPrompt(附件规则)
    │   ├── auth/           # JWT/PBKDF2/注册登录刷新 + requireRole
    │   ├── codex/          # 沙箱 Runner(含 pptx→pdf 转换) + HTTP Client(Health/SysMetrics/Exec)
    │   ├── config/ ingest/ model/     # 配置 / 文件解析（sandbox.go 沙箱通道+Go 回退）/ LLM Provider
    │   ├── gateway/        # REST+SSE：conv/library/artifact/skill/chat(含附件注入)/
    │   │                   #   chat_attachments(上传+多轮检索) / monitor_handlers(监控+审计+导出) /
    │   │                   #   stream_buffer(seq 缓冲) / stream_replay(续流重放)
    │   ├── skill/          # 平台原语 + SKILL.md 文档技能 + execute_code
    │   └── store/          # Store 接口 + memory + postgres（含 metric/conversation_attachments）
    ├── skills/             # ★ SKILL.md 文档技能目录（运行时热加载）
    ├── migrations/         # SQL 迁移 0001~0010
    ├── .env(.example)
    └── go.mod
```

**前端新增组件/模块**：`components/FileCard.tsx`（附件解析动效卡片）、`components/GeneratingIndicator.tsx`（侧栏执行中 spinner）、
`lib/{useChatStream,useStreamResume,streamMerge}.ts`（断点续流引擎）；`RESUME_VERIFY.md`（续流协议验证文档）+ `test-resume-*.mjs` 等测试工具。

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
| **M5 代码沙箱** | execute_code 平台原语：Docker 一次性容器（codex-worker 服务、禁网、限额、超时、产物收集）；文件/资料库传沙箱处理（OCR/复杂计算/绘图）；对话卡片图表展示 | ✅ 完成 |
| **M5.1 产物库** | 产物持久化（artifacts 表 + 磁盘卷）；`/artifacts` 页网格浏览/预览/下载/删除；历史消息产物回看 | ✅ 完成 |
| **M5.2 文档产物** | 沙箱生成 docx/pptx/xlsx/pdf（python-pptx/reportlab+NotoCJK）；LibreOffice 自动 pptx→pdf 网页预览；产物 WPS 风格图标 | ✅ 完成 |
| **UI 华师主题** | 浅色学术 UI（华师蓝/金辅/宋体标题）；登录双栏品牌版；会话分组；产物卡片；密码显隐 | ✅ 完成 |
| **消息级附件** | 对话 📎/拖拽上传多文件同步解析；首轮全文注入 + 会话级多轮记忆检索（conversation_attachments） | ✅ 完成 |
| **监控/审计** | `/monitor`（admin）：Agent 指标+宿主/容器+PG+磁盘告警；全站对话审计与 zip/单会话导出 | ✅ 完成 |
| **M4 上线** | Postgres + Docker + 阿里云 ECS（https://www.ccnu.chat）；TLS；磁盘清理与日志限容 | ✅ 完成（在线运行） |
| **断点续流** | 三层真续流（seq 流缓冲 + 重放端点长轮询 + 前端续流引擎）；断开语义（刷新/切换≠断开，仅手动停止=断开）；侧栏执行中动画 | ✅ 完成 |
| **文档解析沙箱化** | MarkItDown/PyMuPDF 成熟解析优先（中文 PDF 可靠）+ Go 回退 + 乱码兜底检测 | ✅ 完成 |
| **附件解析动效** | FileCard（spinner + 不确定进度条 + 失败重试，对标 DeepSeek Chat） | ✅ 完成 |
| **引导文案物理化** | /diagnose /theory /quiz /search 四张欢迎引导卡片（物理课程与教学概论语境） | ✅ 完成 |

分支约定：`master` 稳定分支仅合入已验收版本；日常开发在 `develop`。

---

## 10. 已定决策 / 待定风险

**已定**：
- ✅ 模型：OpenAI 架构 Chat Completions；生产 DeepSeek（www.ccnu.chat）。
- ✅ 账号：自研 JWT（PBKDF2-SHA256，refresh 轮换），不接 SSO；密码框默认隐藏可切换（登录/注册）。
- ✅ Skill：双层（平台原语 Go + 文档型 SKILL.md）；模型自觉 / `/命令` / 缺参 ASK 澄清。
- ✅ 代码沙箱：Docker 一次性容器 + codex-worker；execute_code 挂件式；默认禁网；产物持久化；
  支持 docx/pptx/xlsx/pdf 生成（LibreOffice pptx→pdf 预览）；并发=全局 2（任务级隔离、无用户级公平队列）。
- ✅ 资料库：用户级文件知识库（上传解析 → 分块 → 关键词检索 → 引用注入）；**消息级附件复用同一解析与库**。
- ✅ 附件多轮记忆：会话关联文件（conversation_attachments）；首轮全文注入、后续自动检索；强指令避免误触发 knowledge_retrieve。
- ✅ **断点续流**：刷新/切换/断网 ≠ 断开（生成继续、回来续流恢复、无横幅）；仅手动停止=断开（终止+半截落库+清断点）；seq 单调缓冲 + 重放端点 + 前端自研引擎三层。
- ✅ **文档解析**：沙箱优先（MarkItDown/PyMuPDF，中文 PDF 可靠）+ 本地 Go 回退 + looksReadable 乱码兜底；附件卡片解析动效（spinner/进度条/重试）。
- ✅ 监控/审计（admin）：metric_events + worker /metrics/sys（宿主/容器/磁盘）+ PG 状态；对话审计与 zip 导出。
- ✅ 运维：日志限容（json-file 10m×3）、cleanup_docker.sh 磁盘回收、监控磁盘 >80% 红警。
- ✅ 存储/部署：Postgres 权威源；Docker Compose + Go 单进程托管前端；阿里云 ECS + Nginx TLS（已在线）。

**待定 / 风险**：
1. 对话模型型号与配额/限流策略。
2. 内容安全：敏感词/低龄保护/输出审查（教育合规）。
3. 主观题批改仅辅助，UI 需明示"仅供参考"。
4. 课程资料版权边界；上传文件的存储与合规（原文件存 UPLOAD_DIR）。
5. 关键词检索精度 → 向量化升级（文档已留接口）；扫描版 PDF 需 OCR（沙箱具备，消息附件默认不做）。
6. **磁盘扩容未做**：40G 系统盘靠清理维持（51%）；正式长期运行建议控制台扩容云盘或在实例内 growpart+resize2fs（需付费确认后执行）。
7. **沙箱并发=2 无用户级限额**：课堂多人同时跑 execute_code 会被 429 抢先（任务级隔离、用完即还）；如需公平队列/每用户限流为后续增强。

---

*本文档随代码演进维护；与实现不一致时以代码为准并回更本文档。*
