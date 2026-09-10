# 断点续流（真续流）验证指南

三层实现完成后，按以下顺序验证。均在项目根目录 `ccnu_lesson_agent` 下进行。

## 0. 环境准备

- 后端：`cd server && go run ./cmd/api`（建议配好 `.env` 的 `OPENAI_API_KEY`，用真实模型验证）
- 前端：`cd web && npm install && npm run dev`（:5173，代理 /v1 → :8080）

> 若 Go 版本 < 1.27：安装 Go 1.27 或修改 `server/go.mod` 的 `go` 版本。
>
> **受限环境构建**（如 DSH 沙箱，无法 spawn 子进程）：`node build-uitest.mjs`
> —— 自动 patch vite 的网络盘探测（去掉 exec）、内联旧 dist CSS 产物替换 tailwind 插件、用
> vite JS API 构建（rolldown in-process 不 spawn）。产物在 `dist/`，用 `go run ./cmd/api`
> 托管即可访问。**注意**：该脚本会临时修改 `src/index.css`（构建后自动还原，git 可复查）。

## 1. 协议级验证（无需浏览器，最快）

```bash
cd web
node test-resume-protocol.mjs http://127.0.0.1:8080
```

模拟「真实模型生成 → 正文 200 字时断连 → 从断点续流 → [DONE] → DB 对比」，
断言 seq 无重叠无缺口、文本拼接完整。**当前实现 11/11 通过**。

## 1.5 前端引擎逻辑验证（复刻 useChatStream 数据流）

```bash
cd web
node test-resume-frontend-logic.mjs http://127.0.0.1:8080
```

复刻前端 hook 的完整数据流：meta → streamIdRef → 节流持久化 → 断连 →
loadResume → since 续流 → seq 去重续拼 → DB 对比。
**10/10 通过**（含「断点状态 streamId 非空」断言——曾因持久化误用
`chunk.streamId`（普通帧无此字段）导致续流永不触发，已修复为 ref 持有）。

## 1.6 SSR 冒烟（无浏览器验证渲染层集成）

```bash
cd web
node build-ssr-smoke.mjs && node --experimental-webstorage --localstorage-file=%TEMP%\ssr-ls.json ssr-bundle.mjs
```

用 rolldown（in-process）把 ChatPage 打包为 SSR 入口，`renderToString` 渲染并断言
品牌标题/欢迎引导/模式标签/输入框。**5/5 通过**——该测试曾在集成期抓出
「滚动 effect 依赖数组残留 `status` 引用」的真实回归（`tsc -b` 增量缓存漏检，
`tsc -b --force` 与运行时共同确认）。

## 2. 合并器单测（纯函数，无需服务）

```bash
cd web
node test-stream-merge.mjs
```

验证自研 chunk→parts 合并器（reasoning/text/tool 状态机、续流中途接入、seq 剥离）。**9/9 通过**。

## 3. UI 层真续流验证（核心体验）

```bash
cd web
node e2e-resume-v3.mjs http://localhost:5173 http://127.0.0.1:8080
```

场景：发 3000 字长任务 → 生成中**刷新页面** → 断言：

1. **刷新后 2.5 秒内立即显示已生成的部分**（真续流：半截内容直接渲染，而非等完成）——这是与旧实现（watchGeneration 等 [DONE]）的本质区别；
2. 继续流式到完成，最终内容完整；
3. `ccnu-stream-resume` / `ccnu-stream-map` 正确清理；
4. 与 DB 权威内容一致。

## 4. 回归既有场景

```bash
cd web
node e2e-resume.mjs        # 切换会话渲染 / ask 卡 / 刷新恢复（场景 C 被 v3 取代）
node e2e-refresh.mjs       # 刷新后会话与回答恢复
node e2e-ask-history.mjs   # 若有：ask 历史回看
```

重点回归：ask 提问卡、工具卡状态机、产物卡、历史消息回看（tool_steps/reasoning/artifacts 渲染路径未改，但消息层从 useChat 换成了自研引擎）。

## 架构要点（本次改动）

| 文件 | 改动 |
|---|---|
| `server/internal/gateway/stream_buffer.go` | 重写：全局单调 seq（修复环形覆盖后 seq 重复 bug）、生成期不覆盖（上限 20000 防御）、`minSeq()`、done 后裁剪保留尾部 4096；seq 以**字节级注入** JSON（不依赖反序列化回环） |
| `server/internal/gateway/stream_replay.go` | 重放端点：`X-Stream-Min-Seq` 头（gap 检测）、**修复轮询快照竞态**（断点 = 本轮实际输出快照最大 seq，不再重新读 lastSeq） |
| `server/internal/gateway/chat_handlers.go` | `buf/bufD/bufRaw` 统一：chunk 入缓冲即注入 seq，网络帧与缓冲共用同一 JSON；修复 bufD 双重包装 bug；流结束（done）后宽限 **10 分钟**再删除缓冲 |
| `web/src/lib/streamMerge.ts` | 自研 chunk→parts 合并器（与 AI SDK parts 形状兼容，卡片组件零改动） |
| `web/src/lib/useStreamResume.ts` | 断点状态持久化（localStorage `ccnu-stream-resume`） |
| `web/src/lib/useChatStream.ts` | 统一流式引擎：发送 / 续流 / 权威兜底；seq 去重 + 节流渲染 + 节流持久化；**streamId 由 ref 持有**（修复持久化空 streamId 导致续流永不触发） |
| `web/src/pages/ChatPage.tsx` | 接入引擎：onMeta 直接持久化 streamMap（修复竞态）；打开会话优先 `resume()`（真续流，**不做"已恢复"去重**——生成中切走再切回仍可恢复），失败走 `fallbackWatch()`（listGenerating + 轮询 DB） |

## 已知边界

- **断开语义（共识）**：刷新 / 切换会话 / 断网 **≠ 断开**——生成继续（缓冲/落库/可续流），回来时优先续流恢复（已生成部分立即显示并继续流式，无横幅）；**只有手动停止才是"断开"**（终止生成、半截落库、清断点）。实现要点：
  - 后端 `stream()` 的 `buf/bufD/bufRaw` 网络写受 `connected` 门控（客户端断开后不再写已断开的 TCP 连接，**避免写阻塞导致 handler 卡住、genCancel 残留、`/v1/chat/generating` 误报**）；缓冲始终 append（供续流重放）；
  - 前端 `useChatStream.stop(keepResume)` 分离：切换会话 `stop(true)`（abort 本地流但**保留断点**，切回续流）；手动停止 `stop()`（清断点 + `stopChat`）；网络错误分支**保留断点**（断网不算断开）；
  - `resume` 支持 `fallbackStreamId`：断点状态缺失但 meta 曾回传过 streamId 时退化为**纯重放续流**（since=0 重建）；
  - `openConversation` / `newChat` 均重置 `bgGenerating`（横幅不跨会话残留；横幅只在"服务端确认在生成且续流不可用"的兜底场景出现）；
- 服务重启后内存缓冲丢失 → 续流 404 → 自动降级权威轮询（listGenerating + DB），功能不丢，只是不再"续流"；
- 单流超过 20000 帧（防御上限）→ 头部裁剪 → `X-Stream-Min-Seq` 检测到 gap → 降级权威轮询；
- 真续流期间"停止"= abort 本地流 + 通知后端终止生成（同旧行为）；
- **受限环境构建（build-uitest.mjs）的 CSS 缺 tailwind 工具类**（tailwind v4 工具类由 oxide 按需生成，
  无静态全量文件；该构建仅用于功能/数据流验证，**样式会视觉降级**；正常 `npm run dev` 不受影响）；
- `build-uitest.mjs` 会临时修改 `src/index.css` 并自动还原（构建后用 `git status` 复查）；SSR 冒烟
  生成的 `ssr-bundle.mjs` 为可再生临时产物；
- **浏览器 UI 验证必须在沙箱外执行**：已穷尽 DSH 沙箱内全部路径——Chrome 四组参数
  （双进程 / `--single-process` / `--in-process-gpu` / `--disable-crash-reporter`）均在 CDP
  短暂 listening 后因子进程 mojo 命名管道 IPC FATAL；bsk daemon IPC 命名管道 unreachable；
  jsdom 安装被沙箱拒绝。均源于沙箱禁止命名管道。
