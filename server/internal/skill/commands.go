package skill

import (
	"regexp"
	"strings"
)

// 本文件为各内置 Skill 实现 CommandProvider（斜杠命令唤起）。
// 通过 "/命令 自然语言参数" 可绕过模型自觉直接执行 Skill。

// ---- quiz_generator：/quiz 出5道一元二次方程题 ----

func (s *quizGenerator) Commands() []string { return []string{"quiz", "出题", "quiz_gen"} }

func (s *quizGenerator) CommandArgs(rawText string) map[string]any {
	raw := strings.TrimSpace(rawText)
	topic := raw
	difficulty := "medium"
	for _, kw := range []struct{ word, d string }{
		{"简单", "easy"}, {"基础", "easy"}, {"困难", "hard"}, {"提高", "hard"}, {"难", "hard"}, {"中等", "medium"},
	} {
		if strings.Contains(raw, kw.word) {
			difficulty = kw.d
			topic = strings.ReplaceAll(topic, kw.word, " ")
			break
		}
	}
	count := parseCountText(raw)
	for _, w := range []string{"生成", "出", "练习", "测验", "题目", "道", "题", "请", "帮我", "个", "张", "份", "套"} {
		topic = strings.ReplaceAll(topic, w, " ")
	}
	// 去掉孤立数字（如“3道”中的 3）
	topic = regexp.MustCompile(`\d+`).ReplaceAllString(topic, " ")
	topic = strings.Join(strings.Fields(topic), " ")
	if topic == "" {
		topic = raw
	}
	return map[string]any{"topic": topic, "count": count, "difficulty": difficulty}
}

// ---- explain_topic：/explain 什么是导数 ----

func (s *explainTopic) Commands() []string { return []string{"explain", "讲解", "解释"} }

func (s *explainTopic) CommandArgs(rawText string) map[string]any {
	raw := strings.TrimSpace(rawText)
	topic := raw
	for _, w := range []string{"讲解", "解释", "请", "帮我", "讲讲", "一下", "什么", "什么是"} {
		topic = strings.ReplaceAll(topic, w, " ")
	}
	topic = strings.Join(strings.Fields(topic), " ")
	if topic == "" {
		topic = raw
	}
	return map[string]any{"topic": topic}
}

// ---- knowledge_retrieve：/search 课程资料问题（M2 接入 RAG）----

func (s *knowledgeRetrieve) Commands() []string { return []string{"search", "检索", "查资料"} }

func (s *knowledgeRetrieve) CommandArgs(rawText string) map[string]any {
	return map[string]any{"query": strings.TrimSpace(rawText)}
}
