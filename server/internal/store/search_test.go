package store

import (
	"context"
	"strings"
	"testing"
)

func TestSearchChunksFilenameAndContent(t *testing.T) {
	s := &memoryStore{documents: map[string]*Document{}, docChunks: map[string][]*Chunk{}}
	ctx := context.Background()
	u := "u1"

	// 文档A：文件名含"勾股定理"，正文无该词
	s.documents["d1"] = &Document{ID: "d1", UserID: u, Filename: "勾股定理教案.docx"}
	s.docChunks["d1"] = []*Chunk{{ID: "c1", DocumentID: "d1", Seq: 0, Content: "教学目标与导入环节。"}}
	// 文档B：文件名不含，正文含"勾股"
	s.documents["d2"] = &Document{ID: "d2", UserID: u, Filename: "教案二.docx"}
	s.docChunks["d2"] = []*Chunk{{ID: "c2", DocumentID: "d2", Seq: 0, Content: "本课讲解勾股定理的证明。"}}
	// 文档C：无关
	s.documents["d3"] = &Document{ID: "d3", UserID: u, Filename: "英语单词.docx"}
	s.docChunks["d3"] = []*Chunk{{ID: "c3", DocumentID: "d3", Seq: 0, Content: "apple banana。"}}

	// 查询"勾股" → 应命中 文件名(文档A) + 正文(文档B)，且文档A排前
	hits, err := s.SearchChunks(ctx, u, "勾股", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 {
		t.Fatalf("want 2 hits, got %d", len(hits))
	}
	if hits[0].DocumentID != "d1" {
		t.Fatalf("filename-hit doc should rank first, got %s", hits[0].DocumentID)
	}
	// 正文命中也要带出处文件名
	if !strings.Contains(hits[1].Filename, "教案二") {
		t.Fatalf("content hit filename wrong: %s", hits[1].Filename)
	}

	// 查询"英语" → 只命中文件名(文档C)
	hits2, err := s.SearchChunks(ctx, u, "英语", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits2) != 1 || hits2[0].DocumentID != "d3" {
		t.Fatalf("want only d3 by filename, got %+v", hits2)
	}
}
