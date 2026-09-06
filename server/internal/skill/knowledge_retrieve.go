package skill

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// knowledgeArgs knowledge_retrieve 参数。
type knowledgeArgs struct {
	Query string `json:"query"`
	TopK  int    `json:"top_k"`
}

// NewKnowledgeRetrieve 创建知识库检索平台原语：检索当前用户的资料库（documents），
// 命中片段拼装为带出处（文件名）的上下文供模型引用。无命中时提示模型凭通用知识回答。
func NewKnowledgeRetrieve() Skill {
	return &knowledgeRetrieve{}
}

type knowledgeRetrieve struct{}

func (s *knowledgeRetrieve) Name() string { return "knowledge_retrieve" }
func (s *knowledgeRetrieve) Description() string {
	return "检索用户上传的资料库（pdf/docx/xlsx 等解析后的内容），返回相关片段并标注出处。当用户问题可能来自上传的资料、或希望" +
		"答案引用资料内容时应先调用；资料库为空或未命中时告知用户可先上传文件。"
}
func (s *knowledgeRetrieve) Modes() []string { return []string{} } // 全部模式

func (s *knowledgeRetrieve) Parameters() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"query": map[string]any{"type": "string", "description": "检索问题或关键词"},
			"top_k": map[string]any{"type": "integer", "description": "返回片段数，默认 5，1-10"},
		},
		"required": []string{"query"},
	}
}

func (s *knowledgeRetrieve) Execute(ctx context.Context, env *Env, args json.RawMessage) (*Result, error) {
	a := knowledgeArgs{TopK: 5}
	if len(args) > 0 {
		_ = json.Unmarshal(args, &a)
	}
	a.Query = strings.TrimSpace(a.Query)
	if a.Query == "" {
		a.Query = "课程内容"
	}
	if a.TopK < 1 || a.TopK > 10 {
		a.TopK = 5
	}
	docs, err := env.Store.ListDocuments(ctx, env.UserID)
	if err != nil {
		return nil, fmt.Errorf("knowledge_retrieve: %w", err)
	}
	if len(docs) == 0 {
		return &Result{
			Content: "当前用户资料库为空（尚未上传任何 pdf/docx/xlsx/txt 文件）。请基于通用学科知识回答；如需基于资料作答，先引导用户上传文件。",
			Summary: "资料库为空，未检索",
			Done:    true,
		}, nil
	}
	hits, err := env.Store.SearchChunks(ctx, env.UserID, a.Query, a.TopK)
	if err != nil {
		return nil, fmt.Errorf("knowledge_retrieve: %w", err)
	}
	if len(hits) == 0 {
		return &Result{
			Content: fmt.Sprintf("在用户资料库（共 %d 个文件）中未检索到与“%s”相关的内容。请说明资料中可能没有该信息，并基于通用知识回答。", len(docs), a.Query),
			Summary: fmt.Sprintf("未命中（资料库 %d 个文件）", len(docs)),
			Done:    true,
		}, nil
	}

	// 拼装带出处的上下文
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("以下是从用户资料库检索到的内容（检索词：%s），回答请优先引用并在引用后标注 [出处：文件名]：\n\n", a.Query))
	for i, h := range hits {
		snippet := []rune(strings.TrimSpace(h.Content))
		if len(snippet) > 600 {
			snippet = snippet[:600]
		}
		sb.WriteString(fmt.Sprintf("--- 片段 %d（出处：%s）---\n%s\n\n", i+1, h.Filename, string(snippet)))
	}
	return &Result{
		Content: sb.String(),
		Summary: fmt.Sprintf("资料库命中 %d 条片段", len(hits)),
		Done:    false, // 交给模型基于片段组织回答
	}, nil
}
