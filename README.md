# ccnu_lesson_agent

教育版 Web 智能体（AI Tutor）：**华中师范大学浅色学术 UI** + Go Agent 服务端，MIT 开源协议。
单 Agent 内核 + 可插拔 Skill 编排（Claude 风格 SKILL.md）；支持自然对话自动触发与 **`/命令`** 主动唤起 Skill（文档型技能均**流式执行**），
具备 **ask_user 向学生提问**、**消息级多文件附件**（上传即读、多轮追问免重传；附件卡片带解析动效）、**Python 代码沙箱 execute_code + 产物库**
（可生成并下载 docx/pptx/xlsx/pdf/png，产物直接展示在主链路）；**三层断点续流**（刷新/切换会话后已生成内容立即续上、不丢不重）；
**文档解析沙箱优先**（MarkItDown/PyMuPDF，中文 PDF 可靠）Go 回退；**监控中心与全站对话审计**（仅 admin，含 LLM 缓存命中率）；OpenAI 兼容模型接入（DeepSeek/OpenAI/通义…，当前 deepseek-v4-flash + reasoning_effort=medium）。

> 架构文档见 [Agent.md](./Agent.md) ｜ 阿里云部署见 [deploy/DEPLOY_ALIYUN.md](./deploy/DEPLOY_ALIYUN.md)
> 线上：https://www.ccnu.chat（admin 账号：admin / 见运维记录）

## 仓库结构

```
├── Agent.md / README.md / LICENSE(MIT)
├── Dockerfile / Dockerfile.codex      # app 镜像 / 沙箱+codex-worker 镜像（含 LibreOffice + MarkItDown）
├── docker-compose.yml                 # app + postgres + codex + 日志限容(10m×3) + 卷
├── deploy/                            # 阿里云部署、nginx 模板、cleanup_docker.sh(磁盘回收)
├── web/                               # React 19 + Vite + TS
│   └── src/components/                # FileCard(附件解析动效) / GeneratingIndicator(执行中动画) …
└── server/                            # Go 1.27 Agent 服务端
    ├── cmd/api/                       # 主服务入口（装配 ingest.SandboxParse 沙箱解析通道）
    ├── cmd/codex/                     # codex-worker（沙箱执行 + /metrics/sys 系统指标）
    ├── internal/{agent,codex,auth,config,gateway,ingest,model,skill,store}
    ├── migrations/                    # SQL 迁移 0001~0010（自动执行）
    └── .env.example
```

## 分支约定

- `master`：稳定分支，仅合入已验收版本
- `develop`：开发分支，日常提交与功能合入

## 快速开始（本地开发）

### 服务端（默认 :8080）
```bash
cd server
cp .env.example .env     # 编辑模型 key（DeepSeek 等）；不配 key 则 Demo 模式
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
export DATABASE_URL="postgres://agent:pass@127.0.0.1:5432/lesson_agent?sslmode=disable"
go run ./cmd/api          # 启动时自动建表/迁移
```

> 💡 代码沙箱需要 Docker + 配置 `CODEX_URL`（生产见 compose `codex` 服务 + `ccnu-codex:latest` 镜像，
> 首次 `docker compose build codex-sandbox`）；未配置时 `execute_code` 自动隐藏（挂件式降级），
> 文档解析自动回退本地 Go（沙箱解析依赖 markitdown/PyMuPDF 已打入沙箱镜像）。

## 玩什么（当前现状）

- **自然对话**：问「帮我出点题」→ 信息不足会 ask_user 提问；「根据我上传的讲义…」→ 自动检索资料库带出处作答。
- **欢迎引导（物理课程与教学概论语境）**：`/diagnose 诊断教学设计` · `/theory 最近发展区设计教学过程` ·
  `/quiz 围绕电场强度概念出 2 个促进思维的问题` · `/search 实验教学中运用物理教学模式和方法`（点击填入输入框）。
- **消息级附件**：对话输入框 📎 多选或**拖拽文件到消息区**（pdf/docx/xlsx/txt/md/csv，≤5 个/次）→ **附件卡片解析动效**
  （解析中图标旋转 spinner + 「解析中...」+ 不确定进度条；失败卡片可**点击重试**或移除）→ 上传同步解析即读；
  首轮模型通读全文作答；**同会话继续追问无需重传**（自动按问题检索该会话文件）。
- **Python 代码沙箱**：让 AI「用 python 画图 / 读我上传的 xlsx 算平均分」→ Docker 隔离沙箱真实执行（禁网/256m 限额/超时）
  → 产物（png/docx/pptx/xlsx/pdf）自动收集，**主链路直接展示产物卡**，可下载；**文件名可用中文**（如《一元二次方程教案.docx》）。
- **🗂️ 产物库**：所有沙箱产物自动保存；图片缩放、**docx 网页渲染（mammoth）/ pdf 内嵌查看**、下载、删除；历史消息回看。
- **🛰️ 监控中心（仅 admin）**：对话/自动调用/模型用量/**LLM 缓存命中率**/延迟 + ECS 宿主/容器资源 + 磁盘告警(>80%) +
  PostgreSQL 状态；「用户对话审计」可查全站 query/回答、**一键导出全部会话 zip**。
- **`/` 命令**：`/quiz` · `/explain` · `/ask` · `/search` · `/diagnose` · `/theory` · `/py`（自加技能即出新命令）；文档技能命令同样**流式返回**。
- **Skill = SKILL.md**（Claude 风格）：在 🧩 学习功能页（教师/管理员）或 `server/skills/<name>/SKILL.md` 写 markdown 即生效；**学生不可见**该管理页。
- **📚 我的资料库**：上传 pdf/docx/xlsx/txt/md/csv（含老式 **.doc/.xls**）→ 自动解析建索引 → 对话引用（带 `[出处：文件名]`）；
  **解析沙箱优先**（MarkItDown 统一转换 + PDF 兜底 PyMuPDF，中文 CID 字体 PDF 提取可靠），沙箱不可用回退本地 Go；
  解析结果不可读（乱码）时明确失败提示，避免静默入库。
- **🔌 断点续流（真续流）**：生成中**刷新 / 切换会话 / 断网**回来看，已生成内容立即续上并继续流式（不丢不重、无「后台生成中」横幅）；
  侧栏会话条目以**旋转动画**标记正在执行的会话；**只有手动「停止」才是断开**（终止生成并半截落库）。
- **模式**：智能助教 / 练习测评 / 教师辅助（右上角胶囊切换）。
- **移动端**：底部四 Tab（对话/资料库/我的文件/学习功能·学生三 Tab）、历史会话面板、全站响应式。
- **首页**：`/` 为公开首页（能力介绍 + 注册引导）；登录后进 `/chat` 对话。
- **刷新恢复**：刷新后自动恢复最近会话与输入草稿；生成中断点续流无缝衔接。
- **账号**：登录/注册双栏品牌版；密码默认隐藏可 👁️/🙈 切换。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/auth/register|login|refresh|logout` | 认证（JWT） |
| GET | `/v1/auth/me` | 当前用户 |
| GET/POST | `/v1/conversations`；GET/PATCH/DELETE `/{id}`；GET `/{id}/messages` | 会话与消息（messages 含 artifacts 摘要） |
| POST | `/v1/chat` | SSE 流式对话（支持 `/命令` 与 `attachments`；帧带全局单调 `seq`） |
| POST | `/v1/chat/attachments` | 消息级附件（multipart `files`，同步解析入资料库；沙箱优先） |
| GET | `/v1/chat/stream/{streamId}?since=N` | **续流重放端点**（断点续流；`X-Stream-Min-Seq` 头用于 gap 检测） |
| GET | `/v1/chat/generating` | 正在生成的会话列表（侧栏「执行中」动画数据源） |
| POST | `/v1/chat/stop` | 手动停止生成（唯一"断开"语义） |
| GET | `/v1/skills`；GET/PUT/DELETE `/v1/skills/{name}` | Skill/命令清单 + 文档技能管理（teacher/admin） |
| GET/POST/DELETE | `/v1/library/files` | 资料库（上传解析/列表/删除） |
| GET | `/v1/artifacts`；GET `/v1/artifacts/{id}/raw`；DELETE `/v1/artifacts/{id}` | 产物库（列表/字节流下载/删除） |
| GET | `/v1/monitor/*` | 监控/审计/导出（**仅 admin**；详情见 Agent.md §4.6） |

SSE 事件：`start` `reasoning-start/delta/end` `text-start/delta/end` `tool-input-*` `tool-output-*` `data-ccnu(meta/done)` `finish` `[DONE]`（全部带 `seq`）

## 里程碑

- [x] M0 骨架：JWT 认证、会话管理、SSE 流式、登录/聊天 UI
- [x] M1 Agent+Skill：function calling 工具循环、调用卡片、真实模型链路
- [x] M1.5 交互增强：`/命令`、ask_user 提问等待续接
- [x] Skill v2：SKILL.md 文档驱动 + 技能管理页（运行时热加载）
- [x] 文件知识库：资料库上传解析 + 关键词检索 + 出处引用
- [x] M5 代码沙箱：execute_code（Docker 隔离、禁网、产物收集、挂件式自愈）
- [x] M5.1 产物库：产物持久化 + `/artifacts` 页 + 历史消息产物回看
- [x] M5.2 文档产物：docx/pptx/xlsx/pdf 生成（pptx 不再自动转 pdf，预览方案后续规划）
- [x] UI 华师主题：浅色学术 UI、**公开首页（能力介绍）**、登录双栏、会话分组、密码显隐
- [x] 消息级附件：多文件上传即读 + 会话多轮记忆 + **刷新会话/草稿恢复**
- [x] 移动端适配：底部 Tab 导航、历史会话面板、响应式全站
- [x] 数学公式渲染：KaTeX（$...$ / $$...$$）
- [x] 产物主链路展示：生成的文件直接出现在消息流（无需展开工具卡）
- [x] LLM 缓存监控：命中率卡片 + [llm] 埋点（耗时/TTFB/缓存 token）
- [x] 性能优化：技能流式执行 + 免重复生成、沙箱 256m、文件生成规范曾引入后回滚
- [x] 监控/审计：`/monitor`（admin）+ 全站对话审计与导出
- [x] M4 上线：Docker + Postgres + 阿里云 ECS（https://www.ccnu.chat）、TLS、磁盘运维
- [x] .doc/.xls 老格式支持（antiword / 纯 Go 解析）
- [x] **三层断点续流（真续流）**：流缓冲 seq 重放 + 前端续流引擎 + 权威兜底；断开语义（刷新/切换≠断开，仅手动停止=断开）
- [x] **文档解析沙箱优先**：MarkItDown/PyMuPDF 成熟解析（中文 PDF 可靠）+ 本地 Go 回退 + 乱码检测
- [x] **附件解析动效**：FileCard（spinner + 不确定进度条 + 失败重试，对标 DeepSeek Chat）
- [x] **引导文案物理语境**：/diagnose /theory /quiz /search 四卡片 + 侧栏「正在执行中」动画
- [ ] M2 增强：向量检索 ｜ M3 教育业务：课程/班级、批改诊断、学情统计

## 生产部署

```bash
# ECS（阿里云）详见 deploy/DEPLOY_ALIYUN.md
# 沙箱镜像（首次/变更后）：
docker compose build codex-sandbox && docker compose up -d --build
# 磁盘回收（每次部署后执行）：
bash deploy/cleanup_docker.sh
```

> GitHub 网络不稳时，ECS 侧可用「本地打包含直传」替代 git pull：
> `git archive --format=tar.gz -o src.tar.gz HEAD` → 上传 ECS `/opt/` → `tar xzf -C /opt/ccnu_lesson_agent`（保留 `.env`）。

## 文档

- 架构/内部机制详见 [Agent.md](./Agent.md)（含断点续流三层、沙箱解析通道、断开语义）
- 断点续流协议/复现验证：`web/RESUME_VERIFY.md`
