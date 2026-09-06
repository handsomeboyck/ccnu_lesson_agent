package skill

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
)

// 内置 Skill 注册入口：由 main 组装。
func RegisterDefaults(reg *Registry) {
	reg.Register(NewQuizGenerator())
	reg.Register(NewExplainTopic())
	reg.Register(NewKnowledgeRetrieve())
	reg.Register(NewAskUser())
}

// parseCountText 从文本中抽取数量词（“5道/五道/五 道”）。
func parseCountText(raw string) int {
	count := 5
	// 中文数字 1-20
	cn := map[rune]int{'一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}
	for i, r := range []rune(raw) {
		if n, ok := cn[r]; ok {
			// 十以内直接取；十X=X；X十=X0 简化取 10
			if i+1 < len([]rune(raw)) && []rune(raw)[i+1] == '十' {
				count = 10
			} else if r == '十' {
				count = 10
			} else {
				count = n
			}
			break
		}
		if r >= '1' && r <= '9' {
			count = int(r - '0')
			break
		}
	}
	if count < 1 || count > 20 {
		return 5
	}
	return count
}

// extractJSON 从模型输出中截取第一个 JSON 数组/对象（容忍 markdown 代码围栏）。
func extractJSON(s string) (json.RawMessage, bool) {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "```"); i >= 0 {
		s = s[i:]
		if j := strings.Index(s, "\n"); j >= 0 {
			s = s[j+1:]
		}
		if k := strings.LastIndex(s, "```"); k >= 0 {
			s = s[:k]
		}
	}
	start := strings.IndexAny(s, "[{")
	end := strings.LastIndexAny(s, "}]")
	if start < 0 || end <= start {
		return nil, false
	}
	raw := json.RawMessage(strings.TrimSpace(s[start : end+1]))
	if !json.Valid(raw) {
		return nil, false
	}
	return raw, true
}

// buildCompleteArgs 组 Skill 内部调模型的 messages。
func buildCompleteArgs(system, marker string) []model.Msg {
	return []model.Msg{
		{Role: model.RoleSystem, Content: system},
		{Role: model.RoleUser, Content: marker},
	}
}

func quote(s string) string { return fmt.Sprintf("%q", s) }
