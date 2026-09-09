package gateway

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/agent"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/codex"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/skill"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// chatService 处理 POST /v1/chat（SSE 流式对话）。
type chatService struct {
	store       store.Store
	conv        *convService
	provider    model.Provider
	registry    *skill.Registry
	codex       *codex.Client
	uploadDir   string
	artifactDir string
	model       string
	attach      *chatAttachmentService

	// 后台生成注册表：conversationID → 取消函数（生成与客户端连接解耦，断开不中断）
	genMu     sync.Mutex
	genCancel map[string]context.CancelFunc
	genStart  map[string]time.Time

	// 流缓冲：streamId → ring buffer（Resume Streams：断线重连可重放）
	streams *streamRegistry
}

// genTimeout 单次生成的最长运行时间（后台任务兜底，防止泄漏）。
const genTimeout = 15 * time.Minute

// registerGen 登记会话生成（返回 false 表示该会话已在生成中，拒绝并发）。
func (c *chatService) registerGen(convID string, cancel context.CancelFunc) bool {
	c.genMu.Lock()
	defer c.genMu.Unlock()
	if _, ok := c.genCancel[convID]; ok {
		return false
	}
	c.genCancel[convID] = cancel
	c.genStart[convID] = time.Now()
	return true
}

func (c *chatService) unregisterGen(convID string) {
	c.genMu.Lock()
	defer c.genMu.Unlock()
	if cancel, ok := c.genCancel[convID]; ok {
		cancel() // 兜底取消（正常结束也应释放后台 ctx）
		delete(c.genCancel, convID)
		delete(c.genStart, convID)
	}
}

// handleStop 显式停止某会话的后台生成（用户点"停止"按钮）。
func (c *chatService) handleStop(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ConversationID string `json:"conversation_id"`
	}
	if err := decodeJSON(r, &in); err != nil || in.ConversationID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "conversation_id required"})
		return
	}
	c.genMu.Lock()
	cancel, ok := c.genCancel[in.ConversationID]
	c.genMu.Unlock()
	if ok && cancel != nil {
		cancel()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "stopped": ok})
}

// handleGenerating 返回正在后台生成的会话列表（刷新/切换后前端据此恢复）。
func (c *chatService) handleGenerating(w http.ResponseWriter, r *http.Request) {
	c.genMu.Lock()
	out := make([]map[string]any, 0, len(c.genCancel))
	for id, st := range c.genStart {
		out = append(out, map[string]any{"conversation_id": id, "started_at": st.Format(time.RFC3339)})
	}
	c.genMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"generating": out})
}

type chatRequest struct {
	ConversationID string   `json:"conversation_id"` // 空 = 新建会话
	Content        string   `json:"content"`
	Mode           string   `json:"mode"`
	CourseID       string   `json:"course_id"`
	Attachments    []string `json:"attachments"` // 本次消息附带的资料库文档 id
}

// stream 输出 AI SDK UI message stream v1（x-vercel-ai-ui-message-stream: v1）：
// data: {start} → data: {text-start/text-delta/text-end}* + data: {tool-input-*/tool-output-*}
// + data: {data-ccnu}（meta/tool_call/tool_result/ask/done 旁路）→ data: {finish} → data: [DONE]
// 协议详情见 Agent.md §6。
func (c *chatService) stream(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())

	var in chatRequest
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	content := strings.TrimSpace(in.Content)
	if content == "" && len(in.Attachments) == 0 {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}
	if content == "" {
		content = "请阅读我上传的文件并给出简要总结。" // 纯附件消息默认指令
	}

	// 1. 会话解析/新建 + 归属校验
	conv, err := c.conv.resolveConversation(r.Context(), claims.UserID, in.ConversationID, in.Mode, in.CourseID, content)
	if err != nil {
		writeError(w, http.StatusNotFound, "conversation not found")
		return
	}

	// 2. 附件：校验归属并关联会话（多轮记忆）。
	var newDocs, linkedDocs []*store.Document
	if c.attach != nil {
		newDocs, linkedDocs, err = c.attach.linkAttachments(r.Context(), conv.ID, claims.UserID, in.Attachments)
		if err != nil {
			log.Printf("chat: link attachments failed: %v", err)
		}
	}
	original := content // 展示/存储用原文
	inject := ""        // 发送给模型的注入段（附件全文或检索片段）

	// 2.5 组装注入内容：本条带附件 → 附件正文全量注入；否则若会话有关联附件 → 自动检索注入。
	if len(newDocs) > 0 || len(linkedDocs) > 0 {
		inject = buildAttachmentContext(r.Context(), c.store, newDocs, linkedDocs, original)
	}

	// 2. 持久化用户消息（只存原文，避免注入文本污染历史界面；模型每轮都会再注入）
	userMsg := &store.Message{ConversationID: conv.ID, Role: "user", Content: original}
	if err := c.store.CreateMessage(r.Context(), userMsg); err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	_ = c.store.TouchConversation(r.Context(), conv.ID, claims.UserID, time.Now())

	// 3. 组装历史（用户/助手消息，含本条）
	msgs, err := c.store.ListMessages(r.Context(), conv.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	history := make([]model.Msg, 0, len(msgs))
	for _, m := range msgs {
		if m.Role == "user" || m.Role == "assistant" {
			history = append(history, model.Msg{Role: m.Role, Content: m.Content})
		}
	}
	// 把本轮附件注入文本合入发送给模型的最后一条用户消息（存储保持原文，仅模型可见富文本）
	if inject != "" && len(history) > 0 && history[len(history)-1].Role == model.RoleUser {
		history[len(history)-1].Content = inject + "\n\n" + history[len(history)-1].Content
	}

	// 4. 流式响应头（AI SDK UI message stream v1）
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("x-vercel-ai-ui-message-stream", "v1")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// 流缓冲（Resume Streams）：断线重连可从此 streamId 重放
	streamID, streamBuf := c.streams.create()
	defer func() { streamBuf.close(); time.AfterFunc(5*time.Minute, func() { c.streams.remove(streamID) }) }()
	buf := func(m map[string]any) { writeUIChunk(w, m); streamBuf.append(mustMarshal(m)) }
	bufD := func(m map[string]any) { writeUIData(w, m); streamBuf.append(mustMarshal(m)) }
	bufRaw := func(v any) { writeUIChunk(w, v); b, _ := json.Marshal(v); streamBuf.append(b) }

	// 首个 chunk：消息开始（messageId 每次流唯一，前端用作消息 key）
	buf(map[string]any{"type": "start", "messageId": streamMsgID()})
	bufD(map[string]any{"type": "meta", "conversation_id": conv.ID, "streamId": streamID})
	flusher.Flush()

	// 5. 驱动 Agent（LLM ↔ Skill 工具循环）
	env := &skill.Env{
		UserID:         claims.UserID,
		ConversationID: conv.ID,
		CourseID:       conv.CourseID,
		Mode:           conv.Mode,
		Store:          c.store,
		Model:          c.provider,
		ModelName:      c.model,
		UploadDir:      c.uploadDir,
		ArtifactDir:    c.artifactDir,
		Codex:          c.codex,
	}
	start := time.Now()
	// 生成与客户端连接解耦：用后台 ctx 驱动 Agent（断开/刷新不中断，完成后落库）。
	// 显式停止走 /v1/chat/stop（cancel genCtx），同一会话并发生成被拒绝。
	genCtx, genCancel := context.WithTimeout(context.Background(), genTimeout)
	if !c.registerGen(conv.ID, genCancel) {
		writeUIError(w, "该会话正在生成中，请稍候")
		flusher.Flush()
		genCancel()
		return
	}
	defer c.unregisterGen(conv.ID)
	evCh, err := agent.Run(genCtx, c.provider, c.registry, env, conv.Mode, c.model, history)
	if err != nil {
		c.unregisterGen(conv.ID)
		writeUIError(w, err.Error())
		flusher.Flush()
		return
	}

	var sb strings.Builder
	var usage *model.Usage
	var pendingAsk *skill.Ask             // ask_user 触发：等待学生回答
	var msgArtifacts []skill.ArtifactView // 本轮产生的持久化产物（写入 assistant 消息供历史回看）
	// 工具执行轨迹（持久化到 assistant 消息，历史回看工具卡片）
	var toolSteps []toolStepRecord
	toolStartAt := map[string]time.Time{} // name#seq → 开始时间
	toolCalls := map[string]int{}         // name → 已发起次数（兼作指标）
	toolStarted := map[string]bool{}      // toolCallId → 已发出 tool-input-start（参数流式去重）
	textStarted := false                  // 是否已输出 text-start（结束需补 text-end）
	reasoningStarted := false             // 思考链 part 状态（start/delta/end 三件套）
	reasoningEnded := false
	var reasoningSb strings.Builder       // 思考链全文（持久化，历史回看）
	errorMsg := ""
	connected := true // 客户端是否仍在连接（断开后停止写 SSE，但生成继续消费事件）
	const textPartID = "text"  // 单流内文本 part 的固定 id（start/delta/end 关联）
	const reasoningPartID = "r1" // 单流内思考 part 的固定 id

	// endReasoning 输出 reasoning-end（若还在流式思考中），并允许下一轮重新开始思考 part。
	endReasoning := func() {
		if reasoningStarted && !reasoningEnded && connected {
			buf(map[string]any{"type": "reasoning-end", "id": reasoningPartID})
			reasoningEnded = true
			reasoningStarted = false // 多轮工具循环中新一轮思考可重新 start
			flusher.Flush()
		}
	}

	for ev := range evCh {
		switch ev.Kind {
		case agent.EventReasoning:
			reasoningSb.WriteString(ev.Content)
			if !reasoningStarted {
				buf(map[string]any{"type": "reasoning-start", "id": reasoningPartID})
				reasoningStarted = true
			}
			buf(map[string]any{"type": "reasoning-delta", "id": reasoningPartID, "delta": ev.Content})
			flusher.Flush()
		case agent.EventDelta:
			endReasoning() // 思考结束 → 正式回答
			sb.WriteString(ev.Content)
			if !textStarted {
				buf(map[string]any{"type": "text-start", "id": textPartID})
				textStarted = true
			}
			buf(map[string]any{"type": "text-delta", "id": textPartID, "delta": ev.Content})
			flusher.Flush()
		case agent.EventToolInput:
			// 工具参数流式：首个分片先发 start（结束思考 + 卡片出现），后续分片实时透传
			if ev.Tool != nil && ev.Tool.ID != "" {
				if !toolStarted[ev.Tool.ID] {
					endReasoning()
					buf(map[string]any{
						"type":       "tool-input-start",
						"toolCallId": ev.Tool.ID,
						"toolName":   ev.Tool.Name,
					})
					toolStarted[ev.Tool.ID] = true
				}
				if ev.Content != "" {
					buf(map[string]any{
						"type":           "tool-input-delta",
						"toolCallId":     ev.Tool.ID,
						"inputTextDelta": ev.Content,
					})
				}
				flusher.Flush()
			}
		case agent.EventToolCall:
			endReasoning() // 思考结束 → 执行工具（长任务期间工具卡即加载态）
			if ev.Tool != nil {
				// 若参数未流式（start 未发过），此处补发 start
				if !toolStarted[ev.Tool.ID] {
					buf(map[string]any{
						"type":       "tool-input-start",
						"toolCallId": ev.Tool.ID,
						"toolName":   ev.Tool.Name,
					})
					toolStarted[ev.Tool.ID] = true
				}
				var args any
				if err := json.Unmarshal(ev.Tool.Arguments, &args); err != nil {
					args = string(ev.Tool.Arguments)
				}
				buf(map[string]any{
					"type":              "tool-input-available",
					"toolCallId":        ev.Tool.ID,
					"toolName":          ev.Tool.Name,
					"input":             args,
					"providerExecuted":  true,
				})
				toolCalls[ev.Tool.Name]++
				key := ev.Tool.Name + "#" + strconv.Itoa(toolCalls[ev.Tool.Name])
				toolStartAt[key] = time.Now()
				toolSteps = append(toolSteps, toolStepRecord{Name: ev.Tool.Name, CallID: ev.Tool.ID})
				flusher.Flush()
			}
		case agent.EventToolResult:
			// 由轨迹记录取 toolCallId（tool_result 事件不携带 Tool 引用）
			callID := ""
			for i := len(toolSteps) - 1; i >= 0; i-- {
				if toolSteps[i].Name == ev.Tool.Name && toolSteps[i].Summary == "" {
					callID = toolSteps[i].CallID
					break
				}
			}
			// 原生工具 chunk：output-available（providerExecuted=服务端已执行）
			// 产物不走工具卡（避免展开才能看），改为在主链路发 data-ccnu artifacts 块
			output := map[string]any{"summary": ev.Summary}
			buf(map[string]any{
				"type":             "tool-output-available",
				"toolCallId":       callID,
				"output":           output,
				"providerExecuted": true,
			})
			if len(ev.Artifacts) > 0 {
				// 主链路产物卡（无需展开工具即可见；同时收集持久化供历史回看）
				bufD(map[string]any{"type": "artifacts", "artifacts": ev.Artifacts})
				for _, a := range ev.Artifacts {
					if a.ID != "" {
						msgArtifacts = append(msgArtifacts, skill.ArtifactView{ID: a.ID, Name: a.Name, Mime: a.Mime})
					}
				}
			}
			// 回填轨迹：最近一条同名未回填记录
			for i := len(toolSteps) - 1; i >= 0; i-- {
				if toolSteps[i].Name == ev.Tool.Name && toolSteps[i].Summary == "" {
					toolSteps[i].Summary = ev.Summary
					if len(ev.Artifacts) > 0 {
						toolSteps[i].Artifacts = append([]skill.ArtifactView(nil), ev.Artifacts...)
					}
					if t, ok := toolStartAt[ev.Tool.Name+"#"+strconv.Itoa(toolCalls[ev.Tool.Name])]; ok {
						toolSteps[i].DurationMs = time.Since(t).Milliseconds()
					}
					break
				}
			}
			flusher.Flush()
		case agent.EventAsk:
			pendingAsk = &skill.Ask{Question: ev.Question, Options: ev.Options}
			// 问题本身也作为一条可见消息给前端（自定义 data chunk）
			bufD(map[string]any{
				"type":     "ask",
				"question": ev.Question,
				"options":  ev.Options,
			})
			flusher.Flush()
		case agent.EventEnd:
			usage = ev.Usage
		case agent.EventError:
			errorMsg = ev.Err.Error()
		}
		if r.Context().Err() != nil {
			connected = false // 客户端断开：停止写 SSE，但生成继续（后台跑完并落库）
		}
	}

	// 断开后不再写 SSE（text-end 等收尾 chunk 只在连接存活时发送）
	if connected && textStarted {
		buf(map[string]any{"type": "text-end", "id": textPartID})
		flusher.Flush()
	}
	endReasoning() // 流结束时兜底关闭思考 part（连接存活时）

	// 记录 Agent 指标（异步写库：用独立 ctx，避免客户端断开后 insert 失败）
	go func() {
		mctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		recordChatMetrics(mctx, c.store, conv.Mode, errorMsg, pendingAsk, usage, toolCalls, time.Since(start))
	}()

	// 6. 持久化助手回复：有文本落文本；仅提问则把问题作为助手消息落库，
	//    便于学生回答后模型在历史中看到“自己问过什么”。
	assistantID := ""
	assistantContent := sb.String()
	if assistantContent == "" && pendingAsk != nil {
		assistantContent = pendingAsk.Question
	}
	if assistantContent != "" {
		assistantMsg := &store.Message{
			ConversationID: conv.ID,
			Role:           "assistant",
			Content:        assistantContent,
			Model:          c.model,
		}
		if pendingAsk != nil {
			b, _ := json.Marshal(map[string]any{"question": pendingAsk.Question, "options": pendingAsk.Options})
			assistantMsg.AskJSON = string(b)
		}
		if usage != nil {
			b, _ := json.Marshal(usage)
			assistantMsg.UsageJSON = string(b)
		}
		if len(msgArtifacts) > 0 {
			b, _ := json.Marshal(msgArtifacts)
			assistantMsg.ArtifactsJSON = string(b)
		}
		if len(toolSteps) > 0 {
			b, _ := json.Marshal(toolSteps)
			assistantMsg.ToolStepsJSON = string(b)
		}
		if reasoningSb.Len() > 0 {
			assistantMsg.Reasoning = reasoningSb.String()
		}
		if err := c.store.CreateMessage(genCtx, assistantMsg); err == nil {
			assistantID = assistantMsg.ID
			_ = c.store.TouchConversation(genCtx, conv.ID, claims.UserID, time.Now())
		}
	}

	// 7. 收尾 chunk
	if errorMsg != "" && sb.Len() == 0 && pendingAsk == nil {
		writeUIError(w, errorMsg)
	} else if sb.Len() > 0 || pendingAsk != nil {
		bufD(map[string]any{
			"type":        "done",
			"message_id":  assistantID,
			"usage":       usage,
			"duration_ms": time.Since(start).Milliseconds(),
		})
		finishReason := "stop"
		if errorMsg != "" {
			finishReason = "error"
		}
		buf(map[string]any{"type": "finish", "finishReason": finishReason})
		bufRaw("DONE")
	} else {
		writeUIError(w, "no content generated")
	}
	flusher.Flush()
}

// toolStepRecord 单条工具执行轨迹（持久化到 assistant 消息，历史回看工具卡片）。
type toolStepRecord struct {
	CallID     string               `json:"call_id,omitempty"`
	Name       string               `json:"name"`
	Summary    string               `json:"summary"`
	DurationMs int64                `json:"duration_ms"`
	Artifacts  []skill.ArtifactView `json:"artifacts,omitempty"`
}

// ---- AI SDK UI message stream v1 输出辅助 ----
// 帧格式：标准 SSE `data: {json}\n\n`，收尾 `data: [DONE]\n\n`；
// 响应头 `x-vercel-ai-ui-message-stream: v1`。前端由 Vercel AI SDK useChat 消费。

// writeUIChunk 输出一个 UI message chunk（map 或 [DONE] 终止符）。
func mustMarshal(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func writeUIChunk(w http.ResponseWriter, chunk any) {
	if s, ok := chunk.(string); ok && s == "DONE" {
		fmt.Fprint(w, "data: [DONE]\n\n")
		return
	}
	b, _ := json.Marshal(chunk)
	fmt.Fprintf(w, "data: %s\n\n", b)
}

// writeUIData 输出自定义数据 chunk（type 以 data- 开头，SDK 归入 message.parts 的 data part）。
func writeUIData(w http.ResponseWriter, payload any) {
	writeUIChunk(w, map[string]any{"type": "data-ccnu", "data": payload})
}

// streamMsgID 生成每次流唯一的消息 id（前端用作消息 key，避免同会话重复）。
func streamMsgID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return fmt.Sprintf("%x", b) + fmt.Sprintf("%x", time.Now().UnixNano())
}

// writeUIError 输出错误 chunk 并收尾 [DONE]。
func writeUIError(w http.ResponseWriter, message string) {
	writeUIChunk(w, map[string]any{"type": "error", "errorText": message})
	writeUIChunk(w, "DONE")
}
