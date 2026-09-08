// Package agent 是 Agent 内核编排层：上下文组装 + LLM 工具调用循环 + Skill 调度。
// 单 Agent 多模式：模式仅决定系统提示词与可用 Skill 集合。
// 两条路径：
//  1. 自然对话：LLM 推理 ↔ 工具调用循环（模型自觉选择 Skill / ask_user）；
//  2. 斜杠命令：用户以 "/命令 参数" 显式唤起 Skill，直接执行并流式返回。
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
	EventReasoning  EventKind = "reasoning" // 思考链增量（reasoning_content）
	EventToolCall   EventKind = "tool_call"
	EventToolResult EventKind = "tool_result"
	EventAsk        EventKind = "ask" // 需要向学生提问（暂停等待回答）
	EventEnd        EventKind = "end"
	EventError      EventKind = "error"
)

// Event 是从 agent 流出的编排事件。
type Event struct {
	Kind      EventKind
	Content   string               // delta 文本 / tool 错误信息
	Tool      *model.ToolCall      // tool_call 时携带
	Summary   string               // tool_result 摘要（给前端卡片）
	Artifacts []skill.ArtifactView // tool_result 产物（图片/csv，旁路给前端，不进模型）
	Question  string               // ask 事件的问题
	Options   []string             // ask 事件的快捷选项
	Usage     *model.Usage         // 累计用量（EventEnd 时给出）
	Err       error
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
	sb.WriteString("\n\n行为准则：")
	sb.WriteString("\n- 当任务信息不足（如题目数量/难度/范围不明确，或需引导学生思考）时，调用 ask_user 提出一个问题并等待学生回答，不要臆测参数继续。")
	sb.WriteString("\n- 学生回答了你上轮提问后，继续完成原任务（如接着出题）。")
	sb.WriteString("\n- 若用户本轮消息里已附带文件内容（形如“【已附加文件：…】/【系统提示：…上传了文件…】”的段落），说明文件全文/相关片段已直接给到，**直接阅读并使用**，不要再调用 knowledge_retrieve，除非用户明确要求检索整个资料库。")
	sb.WriteString("\n- 仅当用户问题提及“我上传的资料/讲义/课件/根据这份文件/这份资料”而本消息并没有附带文件内容时，才应调用 knowledge_retrieve 检索其资料库，再基于命中内容作答并标注 [出处：文件名]；资料库为空或未命中时如实说明。")
	if len(skills) > 0 {
		sb.WriteString("\n\n你有以下可调用的 Skill（通过 function calling）：\n- " + strings.Join(skills, "\n- "))
		sb.WriteString("\n当用户请求匹配某个 Skill 的职责时应调用它，拿到结果后组织成自然、友好的回复。")
	}
	return sb.String()
}

// Run 驱动一次对话。自动识别 "/命令" 强制路径；否则走 LLM 工具循环。
// history 为该会话已持久化消息（含最新一条 user 消息）。
// 事件消费到 EventEnd / EventAsk / EventError 即一轮结束。
func Run(ctx context.Context, prov model.Provider, reg *skill.Registry, env *skill.Env,
	mode, modelName string, history []model.Msg) (<-chan Event, error) {

	if len(history) == 0 {
		return nil, ErrNoInput
	}
	out := make(chan Event, 128)
	go func() {
		defer close(out)
		// 尝试斜杠命令
		if handled := runCommand(ctx, reg, env, history, out); handled {
			return
		}
		runLLMLoop(ctx, prov, reg, env, mode, modelName, history, out)
	}()
	return out, nil
}

// ---- 路径 1：/命令 强制唤起 ----

func runCommand(ctx context.Context, reg *skill.Registry, env *skill.Env, history []model.Msg, out chan<- Event) bool {
	last := ""
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Role == model.RoleUser {
			last = history[i].Content
			break
		}
	}
	trimmed := strings.TrimSpace(last)
	if !strings.HasPrefix(trimmed, "/") {
		return false
	}
	cmdRaw := strings.TrimPrefix(trimmed, "/")
	sp := strings.IndexAny(cmdRaw, " \t\n")
	cmdName := cmdRaw
	rest := ""
	if sp >= 0 {
		cmdName = strings.TrimSpace(cmdRaw[:sp])
		rest = strings.TrimSpace(cmdRaw[sp+1:])
	}
	s, ok := reg.LookupCommand(cmdName)
	if !ok {
		out <- Event{Kind: EventDelta, Content: fmt.Sprintf("未知命令 `/%s`。\n\n可用命令：\n%s", cmdName, commandHelp(reg))}
		out <- Event{Kind: EventEnd}
		return true
	}
	// 构建参数：优先命令提供者启发式抽取，否则默认 {}
	var args json.RawMessage = json.RawMessage(`{}`)
	if cp, isCmd := s.(skill.CommandProvider); isCmd {
		b, err := json.Marshal(cp.CommandArgs(rest))
		if err == nil {
			args = b
		}
	}
	emitCommandExec(ctx, out, reg, env, s, args)
	return true
}

// emitCommandExec 执行命令对应 Skill，事件序列：
// tool_call → tool_result → (ask | delta* → end)
func emitCommandExec(ctx context.Context, out chan<- Event, reg *skill.Registry, env *skill.Env, s skill.Skill, args json.RawMessage) {
	tc := &model.ToolCall{ID: "cli_" + s.Name(), Name: s.Name(), Arguments: args}
	out <- Event{Kind: EventToolCall, Tool: tc}

	execCtx, cancel := context.WithTimeout(ctx, skillTimeout)
	defer cancel()
	res, err := reg.Execute(execCtx, env, s.Name(), args)
	emitResult := func(summary string) Event {
		ev := Event{Kind: EventToolResult, Tool: tc, Summary: summary}
		if res != nil {
			ev.Artifacts = res.Artifacts
		}
		return ev
	}
	if err != nil {
		out <- emitResult("执行失败：" + err.Error())
		out <- Event{Kind: EventError, Err: err}
		return
	}
	if res.Ask != nil && res.Ask.Question != "" {
		out <- emitResult(res.Summary)
		out <- Event{Kind: EventAsk, Question: res.Ask.Question, Options: res.Ask.Options}
		out <- Event{Kind: EventEnd}
		return
	}
	out <- emitResult(res.Summary)
	streamMarkdown(ctx, out, res.Content)
	out <- Event{Kind: EventEnd}
}

// ---- 路径 2：LLM 工具循环 ----

func runLLMLoop(ctx context.Context, prov model.Provider, reg *skill.Registry, env *skill.Env,
	mode, modelName string, history []model.Msg, out chan<- Event) {

	tools := reg.ToolsForMode(mode)
	skillNames := make([]string, 0, len(tools))
	for _, t := range tools {
		skillNames = append(skillNames, fmt.Sprintf("%s：%s", t.Function.Name, t.Function.Description))
	}

	msgs := make([]model.Msg, 0, len(history)+MaxToolRounds*3)
	msgs = append(msgs, model.Msg{Role: model.RoleSystem, Content: SystemPrompt(mode, skillNames)})
	msgs = append(msgs, history...)

	var total *model.Usage

	for round := 1; round <= MaxToolRounds; round++ {
		evCh, err := prov.ChatStream(ctx, model.ChatRequest{Messages: msgs, Tools: tools, Model: modelName})
		if err != nil {
			out <- Event{Kind: EventError, Err: err}
			return
		}
		var calls []model.ToolCall
		var roundReasoning strings.Builder // 本轮思考链（工具轮次需回传 reasoning_content）
		for ev := range evCh {
			if ctx.Err() != nil {
				return
			}
			switch ev.Kind {
			case model.KindDelta:
				out <- Event{Kind: EventDelta, Content: ev.Content}
			case model.KindReasoning:
				roundReasoning.WriteString(ev.Content)
				out <- Event{Kind: EventReasoning, Content: ev.Content}
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
		msgs = append(msgs, model.Msg{
			Role:       model.RoleAssistant,
			Content:    "",
			Reasoning:  roundReasoning.String(), // 携带 tools 时官方要求回传思考链
			ToolCalls:  calls,
		})

		// 逐个执行；若某 Skill 返回 Ask（如 ask_user），暂停等学生回答，结束本轮。
		for _, tc := range calls {
			res, execErr := execSkill(ctx, reg, env, tc)
			msgs = append(msgs, model.Msg{Role: model.RoleTool, ToolCallID: tc.ID, Content: toolContent(res, execErr, tc.Name)})
			ev := Event{Kind: EventToolResult, Tool: &tc, Summary: summarizeOf(res, execErr, tc.Name)}
			if res != nil && len(res.Artifacts) > 0 {
				ev.Artifacts = res.Artifacts
			}
			out <- ev
			if ctx.Err() != nil {
				return
			}
			if res != nil && res.Ask != nil && res.Ask.Question != "" {
				out <- Event{Kind: EventAsk, Question: res.Ask.Question, Options: res.Ask.Options}
				out <- Event{Kind: EventEnd, Usage: total}
				return
			}
		}
	}
	// 轮次上限兜底
	out <- Event{Kind: EventDelta, Content: "\n\n（已达到工具调用轮次上限，已停止继续调用工具。）"}
	out <- Event{Kind: EventEnd, Usage: total}
}

// execSkill 执行单个工具调用，返回 Skill 结果（含产物，供旁路下发）。
func execSkill(ctx context.Context, reg *skill.Registry, env *skill.Env, tc model.ToolCall) (*skill.Result, error) {
	execCtx, cancel := context.WithTimeout(ctx, skillTimeout)
	defer cancel()
	return reg.Execute(execCtx, env, tc.Name, tc.Arguments)
}

// toolContent 回填给模型的纯文本（产物数据不进模型上下文）。
func toolContent(res *skill.Result, err error, name string) string {
	if err != nil {
		return fmt.Sprintf("Skill %q 执行失败：%v", name, err)
	}
	if strings.TrimSpace(res.Content) != "" {
		return res.Content
	}
	if res.Ask != nil && res.Ask.Question != "" {
		return "需要向用户提问：" + res.Ask.Question
	}
	if res.Summary != "" {
		return res.Summary
	}
	return "Skill 已执行"
}

// summarizeOf 从结果构造卡片摘要。
func summarizeOf(res *skill.Result, err error, name string) string {
	if err != nil {
		return "执行失败：" + err.Error()
	}
	if res.Summary != "" {
		return res.Summary
	}
	s := []rune(res.Content)
	if len(s) > 60 {
		return string(s[:60]) + "…"
	}
	return "Skill 已执行"
}

// streamMarkdown 把长文本按小块以 delta 输出（不依赖 provider）。
func streamMarkdown(ctx context.Context, out chan<- Event, text string) {
	runes := []rune(text)
	for i := 0; i < len(runes); i += 24 {
		select {
		case <-ctx.Done():
			return
		default:
		}
		end := i + 24
		if end > len(runes) {
			end = len(runes)
		}
		out <- Event{Kind: EventDelta, Content: string(runes[i:end])}
	}
}

// commandHelp 列出可用命令帮助文本。
func commandHelp(reg *skill.Registry) string {
	cmds := reg.Commands()
	lines := make([]string, 0, len(cmds))
	for _, c := range cmds {
		lines = append(lines, fmt.Sprintf("- `/%s` — %s", c.Command, c.Description))
	}
	return strings.Join(lines, "\n")
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
