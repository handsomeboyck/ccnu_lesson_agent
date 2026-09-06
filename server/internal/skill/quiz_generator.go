package skill

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// quizQuestion 题目结构（也用于给模型对齐的 JSON 契约）。
type quizQuestion struct {
	Type        string   `json:"type"` // choice | blank | short
	Question    string   `json:"question"`
	Options     []string `json:"options,omitempty"` // 选择题
	Answer      string   `json:"answer"`
	Explanation string   `json:"explanation"` // 解析/答案说明
}

// quizArgs quiz_generator 参数。
type quizArgs struct {
	Topic      string `json:"topic"`
	Count      int    `json:"count"`
	Difficulty string `json:"difficulty"` // easy|medium|hard
}

// NewQuizGenerator 创建出题 Skill：调模型生成结构化题目 JSON，再渲染 markdown。
func NewQuizGenerator() Skill {
	return &quizGenerator{}
}

type quizGenerator struct{}

func (s *quizGenerator) Name() string { return "quiz_generator" }
func (s *quizGenerator) Description() string {
	return "根据知识点/数量/难度生成练习题（选择/填空/简答），适用于练习与测评。当用户要求出题、生成练习、测验时调用。"
}
func (s *quizGenerator) Modes() []string { return []string{store.ModePractice, store.ModeTeacher} }

func (s *quizGenerator) Parameters() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"topic":      map[string]any{"type": "string", "description": "知识点或主题，如“一元二次方程”"},
			"count":      map[string]any{"type": "integer", "description": "题目数量，默认 5，1-20"},
			"difficulty": map[string]any{"type": "string", "enum": []string{"easy", "medium", "hard"}, "description": "难度"},
		},
		"required": []string{"topic"},
	}
}

func (s *quizGenerator) Execute(ctx context.Context, env *Env, args json.RawMessage) (*Result, error) {
	a := quizArgs{Topic: "", Count: 5, Difficulty: "medium"}
	if len(args) > 0 {
		_ = json.Unmarshal(args, &a)
	}
	a.Topic = strings.TrimSpace(a.Topic)
	if a.Topic == "" {
		return nil, fmt.Errorf("quiz_generator: topic is required")
	}
	if a.Count <= 0 || a.Count > 20 {
		a.Count = 5
	}
	switch a.Difficulty {
	case "easy", "hard":
	default:
		a.Difficulty = "medium"
	}

	marker := fmt.Sprintf("【题目生成请求】topic=%s; count=%d; difficulty=%s; 语言：简体中文。仅输出 JSON 数组，每项 {\"type\":\"choice|blank|short\",\"question\":\"...\",\"options\":[\"A. ...\"],\"answer\":\"...\",\"explanation\":\"...\"}",
		a.Topic, a.Count, a.Difficulty)
	sys := "你是经验丰富的学科命题老师。严格按照请求数量与题型出题，难度贴合参数，答案准确并附简短解析。只输出 JSON，不要输出其它文字。"
	raw, _, err := env.Model.Complete(ctx, model.ChatRequest{Messages: buildCompleteArgs(sys, marker), Model: env.ModelName})
	if err != nil {
		return nil, fmt.Errorf("quiz_generator: %w", err)
	}

	rawJSON, ok := extractJSON(raw)
	if !ok {
		return &Result{
			Content: "生成失败：模型未返回结构化题目。请重试或换一种问法。",
			Summary: "未解析到题目（生成异常）",
			Done:    true,
		}, nil
	}
	var qs []quizQuestion
	if err := json.Unmarshal(rawJSON, &qs); err != nil || len(qs) == 0 {
		return &Result{Content: "生成失败：题目数据不合法。", Summary: "题目数据不合法", Done: true}, nil
	}
	// 控制数量
	if len(qs) > a.Count {
		qs = qs[:a.Count]
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("## %s · 练习（%d 题，难度 %s）\n\n", a.Topic, len(qs), a.Difficulty))
	for i, q := range qs {
		no := i + 1
		switch q.Type {
		case "choice":
			sb.WriteString(fmt.Sprintf("**%d.（选择）** %s\n", no, q.Question))
			for _, o := range q.Options {
				sb.WriteString("- " + o + "\n")
			}
		case "blank":
			sb.WriteString(fmt.Sprintf("**%d.（填空）** %s\n", no, q.Question))
		default:
			sb.WriteString(fmt.Sprintf("**%d.（简答）** %s\n", no, q.Question))
		}
		if q.Answer != "" {
			sb.WriteString(fmt.Sprintf("> 参考答案：%s\n", q.Answer))
		}
		if q.Explanation != "" {
			sb.WriteString(fmt.Sprintf("> 解析：%s\n", q.Explanation))
		}
		sb.WriteString("\n")
	}
	sb.WriteString("_如需批改你的作答，请把答案发我，我会调用批改 Skill 检查。_\n")

	return &Result{
		Content:   sb.String(),
		Summary:   fmt.Sprintf("已生成 %d 道 %s 练习题", len(qs), a.Topic),
		Artifacts: []any{qs},
		Done:      true,
	}, nil
}
