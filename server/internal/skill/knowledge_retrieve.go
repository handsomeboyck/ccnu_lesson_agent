package skill

import (
	"context"
	"encoding/json"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// knowledgeArgs knowledge_retrieve 参数。
type knowledgeArgs struct {
	Query string `json:"query"`
	TopK  int    `json:"top_k"`
}

// NewKnowledgeRetrieve 创建知识库检索 Skill（M1 占位，M2 接入 RAG 后启用真实检索）。
// 无课程知识库时返回提示，让模型基于自身知识回答。
func NewKnowledgeRetrieve() Skill {
	return &knowledgeRetrieve{}
}

type knowledgeRetrieve struct{}

func (s *knowledgeRetrieve) Name() string { return "knowledge_retrieve" }
func (s *knowledgeRetrieve) Description() string {
	return "检索当前课程的教材/讲义/课件知识库，用于让回答有据可依、可溯源。当问题涉及课程资料内容时应先调用。"
}
func (s *knowledgeRetrieve) Modes() []string {
	return []string{store.ModeCompanion, store.ModePractice, store.ModeTeacher}
}

func (s *knowledgeRetrieve) Parameters() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"query": map[string]any{"type": "string", "description": "检索问题或关键词"},
			"top_k": map[string]any{"type": "integer", "description": "返回片段数，默认 5"},
		},
		"required": []string{"query"},
	}
}

func (s *knowledgeRetrieve) Execute(ctx context.Context, env *Env, args json.RawMessage) (*Result, error) {
	a := knowledgeArgs{TopK: 5}
	if len(args) > 0 {
		_ = json.Unmarshal(args, &a)
	}
	if a.Query == "" {
		a.Query = "课程内容"
	}
	if env.CourseID == "" {
		// M1 占位：知识库尚未接入（RAG 在 M2 实现）。
		return &Result{
			Content: "当前会话未绑定课程知识库（RAG 尚未启用，M2 接入）。请基于通用学科知识回答学生问题，若涉及具体教材内容请说明无法溯源。",
			Summary: "未绑定课程知识库（M2 启用 RAG）",
			Done:    true,
		}, nil
	}
	return &Result{
		Content: "知识库检索功能开发中（M2 提供文档上传与向量检索）。",
		Summary: "知识库检索开发中",
		Done:    true,
	}, nil
}
