package gateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/agent"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// chatService 处理 POST /v1/chat（SSE 流式对话）。
type chatService struct {
	store    store.Store
	conv     *convService
	provider model.Provider
	model    string
}

type chatRequest struct {
	ConversationID string `json:"conversation_id"` // 空 = 新建会话
	Content        string `json:"content"`
	Mode           string `json:"mode"`
	CourseID       string `json:"course_id"`
}

// stream 事件协议见 Agent.md：
// meta → (tool_call/tool_result, M1) → delta* → done | error
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

	// 3. 组装历史（含本条 user 消息）
	msgs, err := c.store.ListMessages(r.Context(), conv.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	history := make([]model.Msg, 0, len(msgs))
	for _, m := range msgs {
		history = append(history, model.Msg{Role: m.Role, Content: m.Content})
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
	meta := map[string]string{"conversation_id": conv.ID}
	writeSSE(w, "meta", meta)
	flusher.Flush()

	// 5. 驱动 Agent 流式生成
	evCh, err := agent.RunChat(r.Context(), c.provider, conv.Mode, history, c.model)
	if err != nil {
		writeSSE(w, "error", map[string]string{"code": "internal", "message": err.Error()})
		flusher.Flush()
		return
	}

	var sb strings.Builder
	var usage *model.Usage
	errorCode := ""
	errorMsg := ""

	for ev := range evCh {
		switch ev.Kind {
		case model.KindDelta:
			sb.WriteString(ev.Content)
			writeSSE(w, "delta", map[string]string{"text": ev.Content})
			flusher.Flush()
		case model.KindUsage:
			usage = ev.Usage
		case model.KindToolCall:
			// M1：Skill 调度后启用
			writeSSE(w, "tool_call", json.RawMessage(ev.Content))
			flusher.Flush()
		case model.KindError:
			errorCode, errorMsg = "internal", ev.Err.Error()
		}
		if r.Context().Err() != nil { // 客户端断开
			break
		}
	}

	// 6. 持久化助手回复（若已产生内容）
	assistantID := ""
	if sb.Len() > 0 {
		assistantMsg := &store.Message{
			ConversationID: conv.ID,
			Role:           "assistant",
			Content:        sb.String(),
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
	if errorMsg != "" && sb.Len() == 0 {
		writeSSE(w, "error", map[string]string{"code": errorCode, "message": errorMsg})
	} else if sb.Len() > 0 {
		writeSSE(w, "done", map[string]any{
			"message_id":  assistantID,
			"usage":       usage,
			"duration_ms": 0,
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
