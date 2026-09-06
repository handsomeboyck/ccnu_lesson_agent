package skill

import (
	"strings"
)

// 本文件为平台原语 Skill 提供 CommandProvider（斜杠命令唤起）。
// 文档型 Skill 的命令别名定义在各自 SKILL.md 的 frontmatter（commands 字段）。

// ---- knowledge_retrieve：/search 检索用户资料库（平台原语）----

func (s *knowledgeRetrieve) Commands() []string { return []string{"search", "检索", "查资料"} }

func (s *knowledgeRetrieve) CommandArgs(rawText string) map[string]any {
	return map[string]any{"query": strings.TrimSpace(rawText)}
}
