package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/skill"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// convService 是会话语义层的 HTTP 处理器（数据访问直接经 store，
// M1 引入会话 service 后可替换）。
type convService struct {
	store store.Store
}

type convView struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Mode      string    `json:"mode"`
	CourseID  string    `json:"course_id"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type msgView struct {
	ID        string               `json:"id"`
	Role      string               `json:"role"`
	Content   string               `json:"content"`
	Reasoning string               `json:"reasoning,omitempty"`  // 思考链全文（历史回看思考卡片）
	Artifacts []skill.ArtifactView `json:"artifacts,omitempty"`  // 该消息关联产物（历史回看）
	ToolSteps []toolStepRecord     `json:"tool_steps,omitempty"` // 工具执行轨迹（历史回看工具卡片）
	Ask       *json.RawMessage     `json:"ask,omitempty"`        // ask_user 触发时的提问与选项（{question, options}），历史回看 AskCard
	CreatedAt time.Time            `json:"created_at"`
}

func toConvView(c *store.Conversation) convView {
	return convView{ID: c.ID, Title: c.Title, Mode: c.Mode, CourseID: c.CourseID, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt}
}

func toMsgView(m *store.Message) msgView {
	v := msgView{ID: m.ID, Role: m.Role, Content: m.Content, Reasoning: m.Reasoning, CreatedAt: m.CreatedAt}
	if m.ArtifactsJSON != "" {
		var arts []skill.ArtifactView
		if json.Unmarshal([]byte(m.ArtifactsJSON), &arts) == nil && len(arts) > 0 {
			v.Artifacts = arts
		}
	}
	if m.ToolStepsJSON != "" {
		var steps []toolStepRecord
		if json.Unmarshal([]byte(m.ToolStepsJSON), &steps) == nil && len(steps) > 0 {
			v.ToolSteps = steps
		}
	}
	if m.AskJSON != "" {
		var raw json.RawMessage
		if json.Unmarshal([]byte(m.AskJSON), &raw) == nil {
			v.Ask = &raw
		}
	}
	return v
}

func (c *convService) list(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	items, err := c.store.ListConversations(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	out := make([]convView, 0, len(items))
	for _, it := range items {
		out = append(out, toConvView(it))
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": out})
}

func (c *convService) create(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	var in struct {
		Title    string `json:"title"`
		Mode     string `json:"mode"`
		CourseID string `json:"course_id"`
	}
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	conv := &store.Conversation{
		UserID:   claims.UserID,
		Title:    strings.TrimSpace(in.Title),
		Mode:     normalizeMode(in.Mode),
		CourseID: in.CourseID,
	}
	if conv.Title == "" {
		conv.Title = "新会话"
	}
	if err := c.store.CreateConversation(r.Context(), conv); err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusCreated, toConvView(conv))
}

func (c *convService) get(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	conv, err := c.store.GetConversation(r.Context(), r.PathValue("id"), claims.UserID)
	if err != nil {
		writeError(w, http.StatusNotFound, "conversation not found")
		return
	}
	writeJSON(w, http.StatusOK, toConvView(conv))
}

func (c *convService) rename(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	var in struct {
		Title string `json:"title"`
	}
	if err := decodeJSON(r, &in); err != nil || strings.TrimSpace(in.Title) == "" {
		writeError(w, http.StatusBadRequest, "title is required")
		return
	}
	conv, err := c.store.GetConversation(r.Context(), r.PathValue("id"), claims.UserID)
	if err != nil {
		writeError(w, http.StatusNotFound, "conversation not found")
		return
	}
	conv.Title = strings.TrimSpace(in.Title)
	if err := c.store.UpdateConversation(r.Context(), conv); err != nil {
		writeError(w, http.StatusNotFound, "conversation not found")
		return
	}
	writeJSON(w, http.StatusOK, toConvView(conv))
}

func (c *convService) delete(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	if err := c.store.DeleteConversation(r.Context(), r.PathValue("id"), claims.UserID); err != nil {
		writeError(w, http.StatusNotFound, "conversation not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (c *convService) messages(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	convID := r.PathValue("id")
	if _, err := c.store.GetConversation(r.Context(), convID, claims.UserID); err != nil {
		writeError(w, http.StatusNotFound, "conversation not found")
		return
	}
	msgs, err := c.store.ListMessages(r.Context(), convID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	out := make([]msgView, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, toMsgView(m))
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": out})
}

func normalizeMode(mode string) string {
	switch mode {
	case store.ModePractice, store.ModeTeacher, store.ModeCompanion:
		return mode
	}
	return store.ModeCompanion
}

func defaultTitle(content string) string {
	title := strings.TrimSpace(content)
	runes := []rune(title)
	if len(runes) > 30 {
		title = string(runes[:30]) + "…"
	}
	if title == "" {
		return "新会话"
	}
	return title
}

// resolveConversation：存在则校验归属；不存在（convID 为空）则新建，
// 标题取首条用户消息。
func (c *convService) resolveConversation(ctx context.Context, userID, convID, mode, courseID, firstContent string) (*store.Conversation, error) {
	if convID != "" {
		return c.store.GetConversation(ctx, convID, userID)
	}
	conv := &store.Conversation{
		UserID:   userID,
		Title:    defaultTitle(firstContent),
		Mode:     normalizeMode(mode),
		CourseID: courseID,
	}
	if err := c.store.CreateConversation(ctx, conv); err != nil {
		return nil, err
	}
	return conv, nil
}
