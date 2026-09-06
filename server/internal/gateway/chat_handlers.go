package gateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/agent"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/codex"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/skill"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// chatService 处理 POST /v1/chat（SSE 流式对话）。
type chatService struct {
	store     store.Store
	conv      *convService
	provider  model.Provider
	registry  *skill.Registry
	codex     *codex.Client
	uploadDir string
	model     string
}

type chatRequest struct {
	ConversationID string `json:"conversation_id"` // 空 = 新建会话
	Content        string `json:"content"`
	Mode           string `json:"mode"`
	CourseID       string `json:"course_id"`
}

// stream 事件协议见 Agent.md：
// meta → (tool_call / tool_result)* → delta* → done | error
func (c *chatService) stream(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())

	var in chatRequest
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	content := strings.TrimSpace(in.Content)
	if content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}

	// 1. 会话解析/新建 + 归属校验
	conv, err := c.conv.resolveConversation(r.Context(), claims.UserID, in.ConversationID, in.Mode, in.CourseID, content)
	if err != nil {
		writeError(w, http.StatusNotFound, "conversation not found")
		return
	}

	// 2. 持久化用户消息
	userMsg := &store.Message{ConversationID: conv.ID, Role: "user", Content: content}
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

	// 4. SSE 头
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// 首次 meta 事件（前端据此更新会话 id）
	writeSSE(w, "meta", map[string]string{"conversation_id": conv.ID})
	flusher.Flush()

	// 5. 驱动 Agent（LLM ↔ Skill 工具循环）
	env := &skill.Env{
		UserID:    claims.UserID,
		CourseID:  conv.CourseID,
		Mode:      conv.Mode,
		Store:     c.store,
		Model:     c.provider,
		ModelName: c.model,
		UploadDir: c.uploadDir,
		Codex:     c.codex,
	}
	start := time.Now()
	evCh, err := agent.Run(r.Context(), c.provider, c.registry, env, conv.Mode, c.model, history)
	if err != nil {
		writeSSE(w, "error", map[string]string{"code": "internal", "message": err.Error()})
		flusher.Flush()
		return
	}

	var sb strings.Builder
	var usage *model.Usage
	var pendingAsk *skill.Ask // ask_user 触发：等待学生回答
	errorCode, errorMsg := "", ""

	for ev := range evCh {
		switch ev.Kind {
		case agent.EventDelta:
			sb.WriteString(ev.Content)
			writeSSE(w, "delta", map[string]string{"text": ev.Content})
			flusher.Flush()
		case agent.EventToolCall:
			if ev.Tool != nil {
				writeSSE(w, "tool_call", map[string]any{
					"id":        ev.Tool.ID,
					"name":      ev.Tool.Name,
					"arguments": ev.Tool.Arguments,
				})
				flusher.Flush()
			}
		case agent.EventToolResult:
			payload := map[string]any{
				"name":    ev.Tool.Name,
				"summary": ev.Summary,
			}
			if len(ev.Artifacts) > 0 {
				payload["artifacts"] = ev.Artifacts
			}
			writeSSE(w, "tool_result", payload)
			flusher.Flush()
		case agent.EventAsk:
			pendingAsk = &skill.Ask{Question: ev.Question, Options: ev.Options}
			// 问题本身也作为一条可见消息给前端（独立事件）
			writeSSE(w, "ask", map[string]any{
				"question": ev.Question,
				"options":  ev.Options,
			})
			flusher.Flush()
		case agent.EventEnd:
			usage = ev.Usage
		case agent.EventError:
			errorCode, errorMsg = "internal", ev.Err.Error()
		}
		if r.Context().Err() != nil { // 客户端断开
			break
		}
	}

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
		if usage != nil {
			b, _ := json.Marshal(usage)
			assistantMsg.UsageJSON = string(b)
		}
		if err := c.store.CreateMessage(r.Context(), assistantMsg); err == nil {
			assistantID = assistantMsg.ID
			_ = c.store.TouchConversation(r.Context(), conv.ID, claims.UserID, time.Now())
		}
	}

	// 7. 收尾事件
	if errorMsg != "" && sb.Len() == 0 && pendingAsk == nil {
		writeSSE(w, "error", map[string]string{"code": errorCode, "message": errorMsg})
	} else if sb.Len() > 0 || pendingAsk != nil {
		writeSSE(w, "done", map[string]any{
			"message_id":  assistantID,
			"usage":       usage,
			"duration_ms": time.Since(start).Milliseconds(),
		})
	} else {
		writeSSE(w, "error", map[string]string{"code": "empty", "message": "no content generated"})
	}
	flusher.Flush()
}

// writeSSE 按 SSE 规范输出一条命名事件：event 行在前，data 逐行，空行结束。
func writeSSE(w http.ResponseWriter, event string, data any) {
	var payload string
	switch v := data.(type) {
	case string:
		payload = v
	default:
		b, err := json.Marshal(data)
		if err != nil {
			payload = fmt.Sprintf(`{"error":%q}`, err.Error())
		} else {
			payload = string(b)
		}
	}
	fmt.Fprintf(w, "event: %s\n", event)
	lines := strings.Split(payload, "\n")
	for _, line := range lines {
		fmt.Fprintf(w, "data: %s\n", line)
	}
	fmt.Fprint(w, "\n")
}
