package skill

import (
	"context"
	"encoding/json"
	"strings"
)

// NewAskUser 创建向学生提问的 Skill。
// 触发时机：模型需要澄清（题目数量/难度/范围）或想用问题引导学生思考时调用；
// 调用后 agent 会暂停并把问题呈现给学生，等待其回答后继续原任务。
func NewAskUser() Skill {
	return &askUser{}
}

type askUser struct{}

func (s *askUser) Name() string { return "ask_user" }
func (s *askUser) Description() string {
	return "向学生提出一个澄清/引导性问题。当任务信息不足（如题目数量、难度、知识点范围不明确），或想引导学生自己思考时调用；提问后等待学生回答。"
}
func (s *askUser) Modes() []string { return []string{} } // 全部模式

func (s *askUser) Parameters() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"question": map[string]any{"type": "string", "description": "要向学生提出的问题，简洁、具体"},
			"options":  map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "可选的快捷选项（最多 4 个）"},
		},
		"required": []string{"question"},
	}
}

// Commands 命令入口：/ask 你的问题
func (s *askUser) Commands() []string { return []string{"ask", "提问"} }

// CommandArgs 把命令文本当问题。
func (s *askUser) CommandArgs(rawText string) map[string]any {
	return map[string]any{"question": strings.TrimSpace(rawText)}
}

func (s *askUser) Execute(ctx context.Context, env *Env, args json.RawMessage) (*Result, error) {
	var a struct {
		Question string   `json:"question"`
		Options  []string `json:"options"`
	}
	if len(args) > 0 {
		_ = json.Unmarshal(args, &a)
	}
	a.Question = strings.TrimSpace(a.Question)
	if a.Question == "" {
		return AskFor("你想让我帮你做什么呢？可以告诉我知识点或想完成的练习。"), nil
	}
	if len(a.Options) > 4 {
		a.Options = a.Options[:4]
	}
	return &Result{
		Summary: "正在向你提问…",
		Done:    true,
		Ask:     &Ask{Question: a.Question, Options: a.Options},
	}, nil
}
