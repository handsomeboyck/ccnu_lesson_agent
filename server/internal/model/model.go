// Package model 抽象 LLM 供应商：对话补全（流式，支持 function calling）。
// 遵循 OpenAI Chat Completions 协议；本地无 key 时退化为 Demo 流式输出（可模拟工具调用）。
package model

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/config"
)

// Role 常量
const (
	RoleSystem    = "system"
	RoleUser      = "user"
	RoleAssistant = "assistant"
	RoleTool      = "tool"
)

// Msg 是发给 LLM 的一条消息。
type Msg struct {
	Role       string     `json:"role"`
	Content    string     `json:"content,omitempty"`
	Reasoning  string     `json:"reasoning_content,omitempty"` // 思考链（携带 tools 时需回传）
	ToolCallID string     `json:"tool_call_id,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
}

// ToolCall 是模型发起的一次工具调用。
type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"` // JSON 对象
}

// MarshalJSON 输出 OpenAI 兼容 wire 格式
// （assistant message 的 tool_calls 项：arguments 必须是 JSON 字符串）。
func (t ToolCall) MarshalJSON() ([]byte, error) {
	w := struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		Fn   struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"function"`
	}{ID: t.ID, Type: "function"}
	w.Fn.Name = t.Name
	w.Fn.Arguments = string(t.Arguments)
	return json.Marshal(w)
}

// UnmarshalJSON 兼容两种输入：wire 形式与内部简写形式。
func (t *ToolCall) UnmarshalJSON(b []byte) error {
	var wire struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		Fn   *struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"function"`
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(b, &wire); err != nil {
		return err
	}
	t.ID = wire.ID
	t.Name = wire.Name
	t.Arguments = wire.Arguments
	if wire.Fn != nil {
		if wire.Name == "" {
			t.Name = wire.Fn.Name
		}
		if len(wire.Arguments) == 0 {
			t.Arguments = json.RawMessage(wire.Fn.Arguments)
		}
	}
	return nil
}

// Tool 描述可用函数工具。
type Tool struct {
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

type ToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// EventKind 是流式事件的种类。
type EventKind string

const (
	KindDelta      EventKind = "delta"      // 文本增量
	KindReasoning  EventKind = "reasoning"  // 思考链增量（reasoning_content）
	KindToolInput  EventKind = "tool_input" // 工具调用参数增量（流式，前端加载态）
	KindToolCall   EventKind = "tool_call"  // 模型请求调用工具（已聚合完整参数）
	KindUsage      EventKind = "usage"      // token 用量
	KindEnd        EventKind = "end"        // 本轮流结束
	KindError      EventKind = "error"      // 出错
)

type Event struct {
	Kind     EventKind
	Content  string    // delta 文本
	ToolCall *ToolCall // KindToolCall 时携带
	Usage    *Usage
	Err      error
}

type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// Provider 是 LLM 供应商抽象。
type Provider interface {
	// ChatStream 发起流式对话；返回事件通道（消费到 KindEnd 或 KindError 为止），
	// 调用方负责 ctx 取消以终止。
	ChatStream(ctx context.Context, req ChatRequest) (<-chan Event, error)
	// Complete 非流式补全（不带 tools），供 Skill 内部二次调用。
	Complete(ctx context.Context, req ChatRequest) (string, *Usage, error)
}

type ChatRequest struct {
	Messages []Msg
	Tools    []Tool
	Model    string // 空则用默认
	Tag      string // 埋点标签（agent round / skill 名），仅用于日志
}

// streamStat 记录一次流式调用的耗时画像（埋点日志）。
type streamStat struct {
	start          time.Time
	firstDataAt    time.Time
	reasoningStart time.Time
	reasoningEnd   time.Time
	textLen        int
	usage          *Usage
	err            error
}

func (s *streamStat) log(req ChatRequest) {
	var dur, ttfb, rsn time.Duration
	dur = time.Since(s.start)
	if !s.firstDataAt.IsZero() {
		ttfb = s.firstDataAt.Sub(s.start)
	}
	if !s.reasoningStart.IsZero() && !s.reasoningEnd.IsZero() {
		rsn = s.reasoningEnd.Sub(s.reasoningStart)
	}
	ti, to := 0, 0
	if s.usage != nil {
		ti, to = s.usage.PromptTokens, s.usage.CompletionTokens
	}
	errStr := ""
	if s.err != nil {
		errStr = s.err.Error()
	}
	model := req.Model
	if model == "" {
		model = "(default)"
	}
	log.Printf("[llm] tag=%s model=%s type=stream dur=%.1fs ttfb=%.2fs reasoning=%.1fs text=%d tok_in=%d tok_out=%d err=%q",
		req.Tag, model, dur.Seconds(), ttfb.Seconds(), rsn.Seconds(), s.textLen, ti, to, errStr)
}

// New 依据配置创建 Provider：有 API key 用 OpenAI，否则用 Demo（便于无 key 联调）。
func New(cfg *config.Config) Provider {
	if cfg.OpenAIAPIKey != "" {
		return &OpenAIProvider{cfg: cfg, client: &http.Client{Timeout: 0}}
	}
	return &DemoProvider{cfg: cfg}
}

// ---- OpenAI 兼容实现 ----

type OpenAIProvider struct {
	cfg    *config.Config
	client *http.Client
}

type openAIChatRequest struct {
	Model           string        `json:"model"`
	Messages        []Msg         `json:"messages"`
	Tools           []Tool        `json:"tools,omitempty"`
	Stream          bool          `json:"stream"`
	ReasoningEffort string        `json:"reasoning_effort,omitempty"` // 思考强度 low/high/max（OpenAI 兼容）
	Thinking        *thinkingOpenAIRequest `json:"thinking,omitempty"` // DeepSeek 思考模式开关
}

type thinkingOpenAIRequest struct {
	Type string `json:"type"` // enabled / disabled
}

type openAIStreamChunk struct {
	Choices []struct {
		Index int `json:"index"`
		Delta struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"` // 思考链增量
			ToolCalls        []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
	Usage *Usage `json:"usage"`
}

// buildOpenAIRequest 组装 OpenAI 兼容请求（含思考模式参数）。
// 思考模式：OPENAI_REASONING_EFFORT 非空时开启；thinking 开关仅对 deepseek 域下发（OpenAI 无此参数）。
func (p *OpenAIProvider) buildOpenAIRequest(req ChatRequest, stream bool) openAIChatRequest {
	model := req.Model
	if model == "" {
		model = p.cfg.OpenAIModel
	}
	r := openAIChatRequest{Model: model, Messages: req.Messages, Tools: req.Tools, Stream: stream}
	if effort := p.cfg.OpenAIReasoningEffort; effort != "" {
		r.ReasoningEffort = effort
		if strings.Contains(p.cfg.OpenAIBaseURL, "deepseek.com") {
			r.Thinking = &thinkingOpenAIRequest{Type: "enabled"}
		}
	}
	return r
}

func (p *OpenAIProvider) ChatStream(ctx context.Context, req ChatRequest) (<-chan Event, error) {
	body, err := json.Marshal(p.buildOpenAIRequest(req, true))
	if err != nil {
		return nil, err
	}
	out := make(chan Event, 64)
	go func() {
		defer close(out)
		st := &streamStat{start: time.Now()}
		resp, err := p.post(ctx, body)
		if err != nil {
			st.err = err
			st.log(req)
			out <- Event{Kind: KindError, Err: err}
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			st.err = fmt.Errorf("openai: status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
			st.log(req)
			out <- Event{Kind: KindError, Err: st.err}
			return
		}
		p.parseStream(ctx, resp.Body, out, st, req)
		st.log(req)
	}()
	return out, nil
}

func (p *OpenAIProvider) Complete(ctx context.Context, req ChatRequest) (content string, usage *Usage, err error) {
	start := time.Now()
	defer func() {
		ti, to := 0, 0
		if usage != nil {
			ti, to = usage.PromptTokens, usage.CompletionTokens
		}
		errStr := ""
		if err != nil {
			errStr = err.Error()
		}
		model := req.Model
		if model == "" {
			model = "(default)"
		}
		log.Printf("[llm] tag=%s model=%s type=complete dur=%.1fs tok_in=%d tok_out=%d err=%q",
			req.Tag, model, time.Since(start).Seconds(), ti, to, errStr)
	}()
	body, err := json.Marshal(p.buildOpenAIRequest(req, false))
	if err != nil {
		return "", nil, err
	}
	resp, err := p.post(ctx, body)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", nil, fmt.Errorf("openai: status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage *Usage `json:"usage"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out); err != nil {
		return "", nil, err
	}
	if len(out.Choices) == 0 {
		return "", nil, errors.New("openai: empty choices")
	}
	return out.Choices[0].Message.Content, out.Usage, nil
}

func (p *OpenAIProvider) post(ctx context.Context, body []byte) (*http.Response, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(p.cfg.OpenAIBaseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+p.cfg.OpenAIAPIKey)
	return p.client.Do(httpReq)
}

// toolCallFragment 累积流式 tool_calls 分片。
type toolCallFragment struct {
	id   string
	name string
	args strings.Builder
}

// parseStream 解析 OpenAI SSE。文本 delta 实时下发；tool_calls 分片聚合，
// 在流结束时以聚合后的 KindToolCall 逐个下发，最后 KindEnd。同时采集耗时画像。
func (p *OpenAIProvider) parseStream(ctx context.Context, r io.Reader, out chan<- Event, st *streamStat, req ChatRequest) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	agg := map[int]*toolCallFragment{}
	var order []int

	sendEnd := func() {
		for _, idx := range order {
			frag := agg[idx]
			if frag == nil {
				continue
			}
			var args json.RawMessage
			if s := strings.TrimSpace(frag.args.String()); s != "" {
				args = json.RawMessage(s)
			} else {
				args = json.RawMessage(`{}`)
			}
			out <- Event{
				Kind:     KindToolCall,
				ToolCall: &ToolCall{ID: frag.id, Name: frag.name, Arguments: args},
			}
		}
		out <- Event{Kind: KindEnd}
	}

	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			sendEnd()
			return
		}
		var chunk openAIStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		now := time.Now()
		if st.firstDataAt.IsZero() {
			st.firstDataAt = now
		}
		if chunk.Usage != nil {
			st.usage = chunk.Usage
			out <- Event{Kind: KindUsage, Usage: chunk.Usage}
		}
		for _, ch := range chunk.Choices {
			if ch.Delta.ReasoningContent != "" {
				if st.reasoningStart.IsZero() {
					st.reasoningStart = now
				}
				out <- Event{Kind: KindReasoning, Content: ch.Delta.ReasoningContent}
			}
			if ch.Delta.Content != "" {
				if !st.reasoningStart.IsZero() && st.reasoningEnd.IsZero() {
					st.reasoningEnd = now
				}
				st.textLen += len([]rune(ch.Delta.Content))
				out <- Event{Kind: KindDelta, Content: ch.Delta.Content}
			}
			for _, tc := range ch.Delta.ToolCalls {
				if !st.reasoningStart.IsZero() && st.reasoningEnd.IsZero() {
					st.reasoningEnd = now
				}
				frag, ok := agg[tc.Index]
				if !ok {
					frag = &toolCallFragment{}
					agg[tc.Index] = frag
					order = append(order, tc.Index)
				}
				if tc.ID != "" {
					frag.id = tc.ID
				}
				if tc.Function.Name != "" {
					frag.name = tc.Function.Name
				}
				// 实时转发参数增量（前端 tool-input-streaming 加载态），首个分片同时暴露 id/name
				if frag.id != "" {
					out <- Event{
						Kind:     KindToolInput,
						Content:  tc.Function.Arguments,
						ToolCall: &ToolCall{ID: frag.id, Name: frag.name},
					}
				}
				frag.args.WriteString(tc.Function.Arguments)
			}
		}
	}
	if err := sc.Err(); err != nil {
		st.err = err
		select {
		case <-ctx.Done():
		default:
			out <- Event{Kind: KindError, Err: err}
			return
		}
	}
	sendEnd()
}

// ---- Demo 实现（无 key 本地联调，模拟流式打字机 + 工具触发）----

type DemoProvider struct{ cfg *config.Config }

// lastTurnRole 判断最近一轮是否为工具结果回填。
func lastTurnRole(msgs []Msg) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		switch msgs[i].Role {
		case RoleTool:
			return RoleTool
		case RoleUser, RoleAssistant:
			return msgs[i].Role
		}
	}
	return ""
}

func (p *DemoProvider) ChatStream(ctx context.Context, req ChatRequest) (<-chan Event, error) {
	out := make(chan Event, 64)
	go func() {
		defer close(out)
		lastRole := lastTurnRole(req.Messages)
		if lastRole != RoleTool && len(req.Tools) > 0 && p.wantQuiz(req) {
			out <- Event{
				Kind: KindToolCall,
				ToolCall: &ToolCall{
					ID:        "call_demo_quiz",
					Name:      "quiz_generator",
					Arguments: json.RawMessage(p.mockQuizArgs(req)),
				},
			}
			out <- Event{Kind: KindEnd}
			return
		}
		// 工具结果回填轮：把 Skill 返回内容作为回复流式呈现（模拟模型总结工具结果）。
		if lastRole == RoleTool {
			reply := p.replyFromToolResult(req.Messages)
			p.streamText(ctx, out, reply)
			return
		}
		last := ""
		for i := len(req.Messages) - 1; i >= 0; i-- {
			if req.Messages[i].Role == RoleUser {
				last = req.Messages[i].Content
				break
			}
		}
		p.streamText(ctx, out, p.demoReply(last, false))
	}()
	return out, nil
}

// replyFromToolResult 从最近的 tool 消息中解析 skill.Result.Content 作为回复文本。
func (p *DemoProvider) replyFromToolResult(msgs []Msg) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role != RoleTool {
			continue
		}
		var res struct {
			Content string `json:"content"`
			Done    bool   `json:"done"`
		}
		if err := json.Unmarshal([]byte(msgs[i].Content), &res); err == nil && res.Content != "" {
			return res.Content
		}
	}
	return "（演示模式）Skill 已执行完成，结果见上方工具卡片。"
}

// streamText 将文本分批输出为 delta 事件（模拟打字机）。
func (p *DemoProvider) streamText(ctx context.Context, out chan<- Event, reply string) {
	runes := []rune(reply)
	for i := 0; i < len(runes); i += 3 {
		select {
		case <-ctx.Done():
			out <- Event{Kind: KindEnd}
			return
		case <-time.After(6 * time.Millisecond):
		}
		end := i + 3
		if end > len(runes) {
			end = len(runes)
		}
		out <- Event{Kind: KindDelta, Content: string(runes[i:end])}
	}
	out <- Event{Kind: KindEnd}
}

// Complete 供 Skill 内部调用。识别 Skill 的标记 prompt 并返回结构化内容，
// 使无 key 模式下工具链路仍可完整演示；真实模式走 OpenAI。
func (p *DemoProvider) Complete(ctx context.Context, req ChatRequest) (string, *Usage, error) {
	last := ""
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == RoleUser {
			last = req.Messages[i].Content
			break
		}
	}
	select {
	case <-ctx.Done():
		return "", nil, ctx.Err()
	case <-time.After(80 * time.Millisecond):
	}
	reply := p.demoComplete(last)
	n := len([]rune(reply)) / 2
	return reply, &Usage{PromptTokens: 8, CompletionTokens: n, TotalTokens: 8 + n}, nil
}

// demoComplete 处理 Skill 结构化标记（真实模式下由 LLM 完成）。
func (p *DemoProvider) demoComplete(marker string) string {
	switch {
	case strings.HasPrefix(marker, "【题目生成请求】"):
		return p.demoQuizJSON(marker)
	case strings.HasPrefix(marker, "【讲解请求】"):
		return p.demoExplanation(marker)
	default:
		return p.demoReply(marker, false)
	}
}

// demoQuizJSON 生成占位题目 JSON 数组。
func (p *DemoProvider) demoQuizJSON(marker string) string {
	topic := "一元二次方程"
	if i := strings.Index(marker, "topic="); i >= 0 {
		rest := marker[i+6:]
		if j := strings.IndexAny(rest, "; \n"); j >= 0 {
			rest = rest[:j]
		}
		topic = strings.TrimSpace(rest)
	}
	count := 5
	if i := strings.Index(marker, "count="); i >= 0 {
		rest := marker[i+6:]
		if j := strings.IndexAny(rest, "; \n"); j >= 0 {
			rest = rest[:j]
		}
		if n := atoiSafe(strings.TrimSpace(rest)); n > 0 && n <= 20 {
			count = n
		}
	}
	qs := make([]map[string]any, 0, count)
	for i := 1; i <= count; i++ {
		qs = append(qs, map[string]any{
			"type":        "blank",
			"question":    fmt.Sprintf("（%d）请给出「%s」的一个核心概念，并用一句话解释它。", i, topic),
			"answer":      "参考答案视具体定义而定（演示数据，真实模式由模型生成）。",
			"explanation": "此题考察对核心概念的准确表述（演示模式题目）。",
		})
	}
	b, _ := json.Marshal(qs)
	return string(b)
}

// demoExplanation 生成结构化讲解。
func (p *DemoProvider) demoExplanation(marker string) string {
	topic := "该概念"
	if i := strings.Index(marker, "topic="); i >= 0 {
		rest := marker[i+6:]
		if j := strings.IndexAny(rest, "; \n"); j >= 0 {
			rest = rest[:j]
		}
		topic = strings.TrimSpace(rest)
	}
	return fmt.Sprintf("（演示模式讲解）\n\n## 一句话定义\n%s 是教学大纲中的重要知识点。\n\n## 直观例子\n用一个贴近生活的例子帮助你建立直觉。\n\n## 分步讲解\n1. 先看定义与适用条件；\n2. 再分析典型例题的每一步；\n3. 最后做变式练习巩固。\n\n## 常见易错点\n- 混淆概念适用条件\n- 计算符号错误\n\n## 小结与追问\n先试着用自己的话复述定义，再想想：这个知识点和之前学的哪个概念有关？", topic)
}

// wantQuiz Demo 启发式：文本含出题意图且注册了 quiz_generator 时模拟调用。
func (p *DemoProvider) wantQuiz(req ChatRequest) bool {
	text := ""
	for _, m := range req.Messages {
		if m.Role == RoleUser {
			text += m.Content + " "
		}
	}
	hasQuiz := false
	for _, t := range req.Tools {
		if t.Function.Name == "quiz_generator" {
			hasQuiz = true
		}
	}
	if !hasQuiz {
		return false
	}
	for _, kw := range []string{"出题", "练习题", "测验", "练习", "quiz", "题目"} {
		if strings.Contains(text, kw) {
			return true
		}
	}
	return false
}

// mockQuizArgs 从用户文本粗提取 count/topic（启发式，尽力而为）。
func (p *DemoProvider) mockQuizArgs(req ChatRequest) string {
	text := ""
	for _, m := range req.Messages {
		if m.Role == RoleUser {
			text += m.Content + " "
		}
	}
	count := 5
	for i := 0; i < len(text); i++ {
		if text[i] >= '0' && text[i] <= '9' {
			j := i
			for j < len(text) && text[j] >= '0' && text[j] <= '9' {
				j++
			}
			if n := atoiSafe(text[i:j]); n > 0 && n <= 50 {
				count = n
			}
			break
		}
	}
	topic := "一元二次方程"
	for _, kw := range []string{"方程", "函数", "几何", "导数", "勾股定理"} {
		if strings.Contains(text, kw) {
			topic = kw
			break
		}
	}
	args, _ := json.Marshal(map[string]any{"topic": topic, "count": count, "difficulty": "medium"})
	return string(args)
}

func (p *DemoProvider) demoReply(input string, afterTool bool) string {
	trimmed := strings.TrimSpace(input)
	if afterTool {
		return "（演示模式）已为你调用 Skill 生成练习，结果见上方工具卡片。你可以继续追问其中某道题，我来讲解。"
	}
	if trimmed == "" {
		trimmed = "（空消息）"
	}
	if len([]rune(trimmed)) > 80 {
		r := []rune(trimmed)
		trimmed = string(r[:80]) + "…"
	}
	return fmt.Sprintf("（演示模式 · 未配置 OPENAI_API_KEY）\n\n你刚才说：%q\n\n这是教育版 Web 智能体在流式回复。\n\n可尝试：\n1. 「生成 5 道一元二次方程练习题」→ 触发 quiz_generator Skill\n2. 设置 OPENAI_API_KEY 后自动切换真实对话与工具调度", trimmed)
}

func atoiSafe(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
	}
	return n
}

var _ Provider = (*OpenAIProvider)(nil)
var _ Provider = (*DemoProvider)(nil)

var ErrClosed = errors.New("model: stream closed")
