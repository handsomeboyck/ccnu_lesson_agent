// Package agent 是 Agent 内核编排层：上下文组装 + LLM 工具调用循环 + Skill 调度。
// 单 Agent 多模式：模式仅决定系统提示词与可用 Skill 集合。
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/skill"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// MaxToolRounds 单次用户请求允许的最大工具推理轮数（防死循环）。
const MaxToolRounds = 5

// skillTimeout 单个 Skill 最大执行时长。
const skillTimeout = 120 * time.Second

// ErrNoInput 表示没有可回复的消息。
var ErrNoInput = errors.New("agent: empty input")

// EventKind 是 agent 输出事件类型（供 SSE 层映射）。
type EventKind string

const (
	EventDelta      EventKind = "delta"
	EventToolCall   EventKind = "tool_call"
	EventToolResult EventKind = "tool_result"
	EventEnd        EventKind = "end"
	EventError      EventKind = "error"
)

// Event 是从 agent 流出的编排事件。
type Event struct {
	Kind    EventKind
	Content string          // delta 文本 / tool 错误信息
	Tool    *model.ToolCall // tool_call 时携带
	Summary string          // tool_result 摘要（给前端卡片）
	Usage   *model.Usage    // 累计用量（EventEnd 时给出）
	Err     error
}

// SystemPrompt 依据会话模式返回系统提示词（单 Agent 多模式的核心差异化配置）。
func SystemPrompt(mode string, skills []string) string {
	var sb strings.Builder
	switch mode {
	case store.ModePractice:
		sb.WriteString("你是「练习与测评」教育助手：负责生成练习题、批改作答、诊断薄弱知识点。" +
			"批改主观题时给出评分依据并注明仅供参考。")
	case store.ModeTeacher:
		sb.WriteString("你是「教师辅助」教育助手：协助教师生成教案、布置与批改作业、汇总学情，输出结构化内容（教学目标/环节/评价方式）。")
	default:
		sb.WriteString("你是「学伴」教育助手：面向学生答疑。先理解问题，再分步讲解；优先启发思考而非直接给答案；结论需有依据。")
	}
	if len(skills) > 0 {
		sb.WriteString("\n\n你有以下可调用的 Skill（通过 function calling）：\n- " + strings.Join(skills, "\n- "))
		sb.WriteString("\n当用户请求匹配某个 Skill 的职责时应调用它，拿到结果后组织成自然、友好的回复。")
	}
	return sb.String()
}

// Run 驱动一次对话：LLM 推理 ↔ 工具调用循环，输出流式事件。
// history 为该会话已持久化消息（含最新一条 user 消息）。
// done 事件在整轮完成时发出；调用方消费到 done/error 即结束。
func Run(ctx context.Context, prov model.Provider, reg *skill.Registry, env *skill.Env,
	mode, modelName string, history []model.Msg) (<-chan Event, error) {

	if len(history) == 0 {
		return nil, ErrNoInput
	}
	tools := reg.ToolsForMode(mode)
	skillNames := make([]string, 0, len(tools))
	for _, t := range tools {
		skillNames = append(skillNames, fmt.Sprintf("%s：%s", t.Function.Name, t.Function.Description))
	}

	msgs := make([]model.Msg, 0, len(history)+MaxToolRounds*3)
	msgs = append(msgs, model.Msg{Role: model.RoleSystem, Content: SystemPrompt(mode, skillNames)})
	msgs = append(msgs, history...)

	out := make(chan Event, 128)
	go func() {
		defer close(out)
		var total *model.Usage

		for round := 1; round <= MaxToolRounds; round++ {
			evCh, err := prov.ChatStream(ctx, model.ChatRequest{Messages: msgs, Tools: tools, Model: modelName})
			if err != nil {
				out <- Event{Kind: EventError, Err: err}
				return
			}

			var calls []model.ToolCall
			for ev := range evCh {
				if ctx.Err() != nil { // 客户端断开/取消
					return
				}
				switch ev.Kind {
				case model.KindDelta:
					out <- Event{Kind: EventDelta, Content: ev.Content}
				case model.KindToolCall:
					if ev.ToolCall != nil {
						calls = append(calls, *ev.ToolCall)
						out <- Event{Kind: EventToolCall, Tool: ev.ToolCall}
					}
				case model.KindUsage:
					total = mergeUsage(total, ev.Usage)
				case model.KindError:
					out <- Event{Kind: EventError, Err: ev.Err}
					return
				}
			}

			if len(calls) == 0 {
				out <- Event{Kind: EventEnd, Usage: total}
				return
			}

			// 把 assistant 的工具调用意图回填给模型
			msgs = append(msgs, model.Msg{Role: model.RoleAssistant, Content: "", ToolCalls: calls})

			// 顺序执行 Skill，结果作为 tool 消息回填
			for _, tc := range calls {
				res := execSkill(ctx, reg, env, tc)
				msgs = append(msgs, model.Msg{Role: model.RoleTool, ToolCallID: tc.ID, Content: res})
				out <- Event{Kind: EventToolResult, Tool: &tc, Summary: summaryOf(res)}
				if ctx.Err() != nil {
					return
				}
			}
		}
		// 达到轮次上限，通知前端后收尾
		out <- Event{Kind: EventDelta, Content: "\n\n（已达到工具调用轮次上限，已停止继续调用工具。）"}
		out <- Event{Kind: EventEnd, Usage: total}
	}()
	return out, nil
}

// execSkill 执行单个工具调用；错误时把错误信息作为 tool 结果回填（模型可见并兜底）。
func execSkill(ctx context.Context, reg *skill.Registry, env *skill.Env, tc model.ToolCall) string {
	ctx, cancel := context.WithTimeout(ctx, skillTimeout)
	defer cancel()
	res, err := reg.Execute(ctx, env, tc.Name, tc.Arguments)
	if err != nil {
		msg := fmt.Sprintf("Skill %q 执行失败：%v", tc.Name, err)
		b, _ := json.Marshal(map[string]any{"error": msg})
		return string(b)
	}
	b, _ := json.Marshal(res)
	return string(b)
}

// summaryOf 从 tool 结果 JSON 提取给前端展示的摘要。
func summaryOf(res string) string {
	var r struct {
		Summary string `json:"summary"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(res), &r); err == nil {
		if r.Summary != "" {
			return r.Summary
		}
		if r.Content != "" {
			s := []rune(r.Content)
			if len(s) > 60 {
				return string(s[:60]) + "…"
			}
			return r.Content
		}
	}
	return "Skill 已执行"
}

func mergeUsage(a, b *model.Usage) *model.Usage {
	if b == nil {
		return a
	}
	if a == nil {
		return b
	}
	return &model.Usage{
		PromptTokens:     a.PromptTokens + b.PromptTokens,
		CompletionTokens: a.CompletionTokens + b.CompletionTokens,
		TotalTokens:      a.TotalTokens + b.TotalTokens,
	}
}
