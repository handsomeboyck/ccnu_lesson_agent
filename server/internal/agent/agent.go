// Package agent 是 Agent 内核编排层（M0：上下文组装 + 流式补全）。
// M1 将在此引入 tool-call 循环与 Skill 调度。
package agent

import (
	"context"
	"errors"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// ErrNoInput 表示没有可回复的消息。
var ErrNoInput = errors.New("agent: empty input")

// SystemPrompt 依据会话模式返回系统提示词（单 Agent 多模式的核心差异化配置）。
func SystemPrompt(mode string) string {
	switch mode {
	case store.ModePractice:
		return "你是「练习与测评」教育助手。你负责生成练习题、批改作答、诊断薄弱知识点。" +
			"批改主观题时给出评分依据并注明仅供参考。语气鼓励、条理清晰，多用列表与小结。"
	case store.ModeTeacher:
		return "你是「教师辅助」教育助手。你协助教师生成教案、布置与批改作业、汇总学情。" +
			"输出结构化内容：教学目标、教学环节、评价方式等。可引用课程资料佐证。"
	default: // companion 学伴
		return "你是「学伴」教育助手，面向学生答疑。遵循苏格拉底式引导：先理解问题，再分步讲解，" +
			"优先启发思考而非直接给答案；结论需有依据（引用课程资料时给出出处）。" +
			"数学题请给出解题步骤，使用清晰的排版。"
	}
}

// RunChat 组装消息并驱动流式回复，返回事件通道（delta/usage/end/error）。
// history 应为该会话已持久化的消息（含最新一条 user 消息）。
func RunChat(ctx context.Context, prov model.Provider, mode string, history []model.Msg, modelName string) (<-chan model.Event, error) {
	if len(history) == 0 {
		return nil, ErrNoInput
	}
	msgs := make([]model.Msg, 0, len(history)+1)
	msgs = append(msgs, model.Msg{Role: model.RoleSystem, Content: SystemPrompt(mode)})
	msgs = append(msgs, history...)
	return prov.ChatStream(ctx, model.ChatRequest{Messages: msgs, Model: modelName})
}
