package skill

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// explainArgs explain_topic 参数。
type explainArgs struct {
	Topic    string `json:"topic"`
	Audience string `json:"audience"` // 学生年级/水平（可选）
	Depth    string `json:"depth"`    // intro|standard|advanced
}

// NewExplainTopic 创建讲解 Skill：结构化分步讲解（定义→例子→易错点→小结）。
func NewExplainTopic() Skill {
	return &explainTopic{}
}

type explainTopic struct{}

func (s *explainTopic) Name() string { return "explain_topic" }
func (s *explainTopic) Description() string {
	return "对某个概念/知识点做结构化讲解：定义→例子→易错点→小结，适合学生答疑。当用户请求“讲解/解释/什么是”某概念时调用。"
}
func (s *explainTopic) Modes() []string { return []string{store.ModeCompanion, store.ModePractice} }

func (s *explainTopic) Parameters() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"topic":    map[string]any{"type": "string", "description": "要讲解的概念，如“一元二次方程的求根公式”"},
			"audience": map[string]any{"type": "string", "description": "听众水平，如“初二学生”"},
			"depth":    map[string]any{"type": "string", "enum": []string{"intro", "standard", "advanced"}, "description": "讲解深度"},
		},
		"required": []string{"topic"},
	}
}

func (s *explainTopic) Execute(ctx context.Context, env *Env, args json.RawMessage) (*Result, error) {
	a := explainArgs{Topic: "", Audience: "学生", Depth: "standard"}
	if len(args) > 0 {
		_ = json.Unmarshal(args, &a)
	}
	a.Topic = strings.TrimSpace(a.Topic)
	if a.Topic == "" {
		return nil, fmt.Errorf("explain_topic: topic is required")
	}
	if a.Audience == "" {
		a.Audience = "学生"
	}

	marker := fmt.Sprintf("【讲解请求】topic=%s; audience=%s; depth=%s; 语言：简体中文。按以下结构输出：\n1. 一句话定义\n2. 直观例子\n3. 分步讲解（可含公式/代码）\n4. 常见易错点\n5. 小结与一个追问启发问题",
		a.Topic, a.Audience, a.Depth)
	sys := "你是循循善诱的学科教师，采用苏格拉底式引导与清晰分步讲解，避免直接倾倒答案，讲完用提问启发学生进一步思考。"
	content, _, err := env.Model.Complete(ctx, model.ChatRequest{Messages: buildCompleteArgs(sys, marker), Model: env.ModelName})
	if err != nil {
		return nil, fmt.Errorf("explain_topic: %w", err)
	}
	return &Result{
		Content:   content,
		Summary:   fmt.Sprintf("已讲解「%s」", a.Topic),
		Artifacts: []any{map[string]any{"topic": a.Topic, "depth": a.Depth}},
		Done:      true,
	}, nil
}
