// Package model 抽象 LLM 供应商：对话补全（流式）+ 工具调用（M1 起）。
// 遵循 OpenAI Chat Completions 协议；本地无 key 时退化为 Demo 流式输出。
package model

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
)

// Msg 是发给 LLM 的一条消息。
type Msg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Tool 定义可用的函数工具（M1 接入 function calling）。
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
	KindDelta    EventKind = "delta"     // 文本增量
	KindToolCall EventKind = "tool_call" // 模型请求调用工具（M1）
	KindUsage    EventKind = "usage"     // token 用量
	KindEnd      EventKind = "end"       // 流结束
	KindError    EventKind = "error"     // 出错
)

type Event struct {
	Kind    EventKind
	Content string // delta 文本
	Usage   *Usage
	Err     error
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
}

type ChatRequest struct {
	Messages []Msg
	Tools    []Tool // M1 启用
	Model    string // 空则用默认
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
	Model    string `json:"model"`
	Messages []Msg  `json:"messages"`
	Stream   bool   `json:"stream"`
}

type openAIStreamChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
	} `json:"choices"`
	Usage *Usage `json:"usage"`
}

func (p *OpenAIProvider) ChatStream(ctx context.Context, req ChatRequest) (<-chan Event, error) {
	model := req.Model
	if model == "" {
		model = p.cfg.OpenAIModel
	}
	body, err := json.Marshal(openAIChatRequest{Model: model, Messages: req.Messages, Stream: true})
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(p.cfg.OpenAIBaseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+p.cfg.OpenAIAPIKey)

	out := make(chan Event, 64)
	go func() {
		defer close(out)
		resp, err := p.client.Do(httpReq)
		if err != nil {
			out <- Event{Kind: KindError, Err: err}
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			out <- Event{Kind: KindError, Err: fmt.Errorf("openai: status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))}
			return
		}
		p.parseStream(ctx, resp.Body, out)
	}()
	return out, nil
}

func (p *OpenAIProvider) parseStream(ctx context.Context, r io.Reader, out chan<- Event) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			out <- Event{Kind: KindEnd}
			return
		}
		var chunk openAIStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if chunk.Usage != nil {
			out <- Event{Kind: KindUsage, Usage: chunk.Usage}
		}
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			out <- Event{Kind: KindDelta, Content: chunk.Choices[0].Delta.Content}
		}
	}
	if err := sc.Err(); err != nil {
		select {
		case <-ctx.Done():
			out <- Event{Kind: KindEnd}
		default:
			out <- Event{Kind: KindError, Err: err}
		}
		return
	}
	out <- Event{Kind: KindEnd}
}

// ---- Demo 实现（无 key 本地联调，模拟流式打字机）----

type DemoProvider struct{ cfg *config.Config }

func (p *DemoProvider) ChatStream(ctx context.Context, req ChatRequest) (<-chan Event, error) {
	out := make(chan Event, 64)
	go func() {
		defer close(out)
		last := ""
		if len(req.Messages) > 0 {
			last = req.Messages[len(req.Messages)-1].Content
		}
		reply := p.demoReply(last)
		// 按 ~2 字一批模拟打字机输出。
		runes := []rune(reply)
		for i := 0; i < len(runes); i += 3 {
			select {
			case <-ctx.Done():
				out <- Event{Kind: KindEnd}
				return
			case <-time.After(15 * time.Millisecond):
			}
			end := i + 3
			if end > len(runes) {
				end = len(runes)
			}
			out <- Event{Kind: KindDelta, Content: string(runes[i:end])}
		}
		out <- Event{Kind: KindEnd}
	}()
	return out, nil
}

func (p *DemoProvider) demoReply(input string) string {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		trimmed = "（空消息）"
	}
	if len(trimmed) > 80 {
		trimmed = string([]rune(trimmed)[:80]) + "…"
	}
	return fmt.Sprintf("（演示模式 · 未配置 OPENAI_API_KEY）\n\n你刚才说：%q\n\n这是教育版 Web 智能体的 M0 骨架在流式回复。\n\n后续将接入：\n1. 真实 OpenAI 兼容对话（设置 OPENAI_API_KEY 后自动启用）\n2. 内置 Skill 调用与知识库检索（M1/M2）\n3. 学伴 / 练习 / 教师三种模式", trimmed)
}

var _ Provider = (*OpenAIProvider)(nil)
var _ Provider = (*DemoProvider)(nil)

var ErrClosed = errors.New("model: stream closed")
