package gateway

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/ingest"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// 上传大小上限：30MB
const maxUploadBytes = 30 << 20

// libraryService 处理用户资料库（文件上传/列表/删除）。
type libraryService struct {
	store     store.Store
	uploadDir string // 原始文件暂存目录（可空=仅存解析文本）
}

type docView struct {
	ID        string    `json:"id"`
	Filename  string    `json:"filename"`
	Ext       string    `json:"ext"`
	SizeBytes int64     `json:"size_bytes"`
	Status    string    `json:"status"`
	Error     string    `json:"error"`
	CreatedAt time.Time `json:"created_at"`
}

func toDocView(d *store.Document) docView {
	return docView{ID: d.ID, Filename: d.Filename, Ext: d.Ext, SizeBytes: d.SizeBytes, Status: d.Status, Error: d.Error, CreatedAt: d.CreatedAt}
}

// storeParsedDocument 同步完成：建记录 → 解析 → 写分块 → 存原件 → ready。
// 供资料库上传（异步外再调）与对话附件（需同步拿到 doc id）复用。
// 返回 (doc, nil)；类型不支持返回 ingest.ErrUnsupported。
func storeParsedDocument(ctx context.Context, st store.Store, uploadDir, userID, filename string, data []byte) (*store.Document, error) {
	ext := ingest.ExtOf(filename)
	if !supportedExt(ext) {
		return nil, fmt.Errorf("不支持的文件类型 .%s（支持 pdf/docx/xlsx/txt/md/csv）: %w", ext, ingest.ErrUnsupported)
	}
	doc := &store.Document{UserID: userID, Filename: filename, Ext: ext, SizeBytes: int64(len(data)), Status: "parsing"}
	if err := st.CreateDocument(ctx, doc); err != nil {
		return nil, err
	}
	text, err := ingest.ParseBytes(filename, data)
	if err != nil {
		_ = st.UpdateDocumentStatus(ctx, doc.ID, userID, "failed", err.Error())
		return doc, err
	}
	chunks := ingest.ChunkText(text)
	cs := make([]store.Chunk, 0, len(chunks))
	for i, c := range chunks {
		cs = append(cs, store.Chunk{DocumentID: doc.ID, Seq: i, Content: c})
	}
	if err := st.ReplaceChunks(ctx, doc.ID, cs); err != nil {
		_ = st.UpdateDocumentStatus(ctx, doc.ID, userID, "failed", err.Error())
		return doc, err
	}
	if uploadDir != "" {
		p := filepath.Join(uploadDir, doc.ID+"_"+sanitize(doc.Filename))
		if err := os.WriteFile(p, data, 0o600); err != nil {
			log.Printf("library: save original %s: %v", doc.Filename, err)
		}
	}
	_ = st.UpdateDocumentStatus(ctx, doc.ID, userID, "ready", "")
	doc.Status = "ready" // 同步完成，返回结构体同步状态（此前 DB 已 ready 但对象仍是 parsing）
	return doc, nil
}

// upload POST /v1/library/files（multipart，字段名 file；支持多文件同名重复上传多次）
func (s *libraryService) upload(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeError(w, http.StatusBadRequest, "文件过大（上限 30MB）或请求非法")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "缺少 file 字段")
		return
	}
	defer file.Close()

	filename := filepath.Base(header.Filename)
	ext := ingest.ExtOf(filename)
	if !supportedExt(ext) {
		writeError(w, http.StatusBadRequest, "不支持的文件类型 ."+ext+"（支持 pdf/docx/xlsx/txt/md）")
		return
	}
	// 读入内存（上限内）
	data := make([]byte, header.Size)
	if _, err := file.Read(data); err != nil && header.Size > 0 {
		writeError(w, http.StatusInternalServerError, "读取文件失败")
		return
	}

	doc := &store.Document{UserID: claims.UserID, Filename: filename, Ext: ext, SizeBytes: header.Size, Status: "parsing"}
	if err := s.store.CreateDocument(r.Context(), doc); err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// 异步解析（避免长阻塞上传请求）
	go s.parseAndStore(r.Context(), doc, data)

	writeJSON(w, http.StatusCreated, toDocView(doc))
}

func supportedExt(ext string) bool {
	switch ext {
	case "pdf", "docx", "xlsx", "txt", "md", "csv", "doc", "xls":
		return true
	}
	return false
}

// parseAndStore 后台解析文件并把分块写入（期间状态流转 parsing→ready/failed）。
func (s *libraryService) parseAndStore(ctx context.Context, doc *store.Document, data []byte) {
	// 新 context（不随请求取消）
	bg := context.Background()
	finish := func(status, errMsg string) {
		_ = s.store.UpdateDocumentStatus(bg, doc.ID, doc.UserID, status, errMsg)
	}
	text, err := ingest.ParseBytes(doc.Filename, data)
	if err != nil {
		finish("failed", err.Error())
		log.Printf("library: parse %s failed: %v", doc.Filename, err)
		return
	}
	chunks := ingest.ChunkText(text)
	cs := make([]store.Chunk, 0, len(chunks))
	for i, c := range chunks {
		cs = append(cs, store.Chunk{DocumentID: doc.ID, Seq: i, Content: c})
	}
	if err := s.store.ReplaceChunks(bg, doc.ID, cs); err != nil {
		finish("failed", err.Error())
		return
	}
	// 可选：暂存原文件到磁盘（保留原始文档路径，跨进程/重启可用）。当前仅存解析文本。
	if s.uploadDir != "" {
		p := filepath.Join(s.uploadDir, doc.ID+"_"+sanitize(doc.Filename))
		if err := os.WriteFile(p, data, 0o600); err != nil {
			log.Printf("library: save original %s: %v", doc.Filename, err)
		}
	}
	finish("ready", "")
	log.Printf("library: parsed %s -> %d chunks", doc.Filename, len(chunks))
}

func sanitize(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|' {
			return '_'
		}
		return r
	}, s)
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

// list GET /v1/library/files
func (s *libraryService) list(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	docs, err := s.store.ListDocuments(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	out := make([]docView, 0, len(docs))
	for _, d := range docs {
		out = append(out, toDocView(d))
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": out})
}

// remove DELETE /v1/library/files/{id}
func (s *libraryService) remove(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	id := r.PathValue("id")
	if err := s.store.DeleteDocument(r.Context(), id, claims.UserID); err != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}
	// 清理暂存原文件
	if s.uploadDir != "" {
		matches, _ := filepath.Glob(filepath.Join(s.uploadDir, id+"_*"))
		for _, m := range matches {
			_ = os.Remove(m)
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// count 工具（供 UI 汇总）
func (s *libraryService) count(ctx context.Context, userID string) (int, error) {
	docs, err := s.store.ListDocuments(ctx, userID)
	if err != nil {
		return 0, err
	}
	return len(docs), nil
}
