package gateway

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/ingest"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// chatAttachmentService 处理消息级附件：上传解析入库（自动成为资料库文件）。
type chatAttachmentService struct {
	store     store.Store
	uploadDir string
}

const maxChatAttachments = 5

type attachResult struct {
	DocID    string `json:"doc_id"`
	Filename string `json:"filename"`
	Status   string `json:"status"`
	Error    string `json:"error,omitempty"`
}

// upload POST /v1/chat/attachments —— multipart 字段名 files（多文件），同步解析后返回 doc_id。
// 解析产物进入用户资料库（documents），前端发送消息时携带 attachments:[doc_id…]。
func (s *chatAttachmentService) upload(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeError(w, http.StatusBadRequest, "文件过大（上限 30MB）或请求非法")
		return
	}
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		writeError(w, http.StatusBadRequest, "缺少 files 字段（multipart）")
		return
	}
	if len(files) > maxChatAttachments {
		writeError(w, http.StatusBadRequest, "一次最多附加 "+strconv.Itoa(maxChatAttachments)+" 个文件")
		return
	}
	results := make([]attachResult, 0, len(files))
	for _, fh := range files {
		filename := filepath.Base(fh.Filename)
		res := attachResult{Filename: filename, Status: "failed"}
		f, err := fh.Open()
		if err != nil {
			res.Error = "读取文件失败"
			results = append(results, res)
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, maxUploadBytes))
		f.Close()
		if err != nil {
			res.Error = "读取文件失败"
			results = append(results, res)
			continue
		}

		doc, err := storeParsedDocument(r.Context(), s.store, s.uploadDir, claims.UserID, filename, data)
		if err != nil {
			if errors.Is(err, ingest.ErrUnsupported) {
				res.Error = err.Error()
			} else {
				res.Error = "解析失败：" + err.Error()
			}
			if doc != nil {
				res.DocID = doc.ID
			}
			results = append(results, res)
			continue
		}
		results = append(results, attachResult{DocID: doc.ID, Filename: doc.Filename, Status: doc.Status})
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

// linkAttachments 供 chat handler 调用：校验归属并把新附件关联到会话（多轮记忆）。
// 返回 (newDocs 本条新关联的文档, allDocs 会话当前全部关联文档, err)。
func (s *chatAttachmentService) linkAttachments(ctx context.Context, convID, userID string, attachIDs []string) (newDocs, allDocs []*store.Document, err error) {
	if len(attachIDs) > 0 {
		docs, err := s.store.GetDocumentsByIDs(ctx, userID, attachIDs)
		if err != nil {
			return nil, nil, err
		}
		owned := make([]string, 0, len(docs))
		for _, d := range docs {
			owned = append(owned, d.ID)
		}
		if len(owned) > 0 {
			if err := s.store.LinkConversationDocuments(ctx, convID, owned); err != nil {
				return nil, nil, err
			}
		}
		newDocs = docs
	}
	allDocs, err = s.store.ListConversationAttachments(ctx, convID)
	return newDocs, allDocs, err
}

// 注入上限（rune）
const (
	attachInjectPerFile = 4000  // 每个文件全量注入上限
	attachInjectTotal   = 12000 // 单轮注入总上限
)

// buildAttachmentContext 构造发送给模型的附件上下文：
//   - 本条刚附加了文件（newDocs>0）→ 逐个文件全量正文注入（上限截断），让模型"通读全文"；
//   - 后续追问（无新附件）→ 从会话关联文档按问题关键词检索相关片段注入（多轮记忆），
//     让"继续问这份文件里的问题"无需重传。
func buildAttachmentContext(ctx context.Context, st store.Store, newDocs, allDocs []*store.Document, question string) string {
	var sb strings.Builder
	if len(newDocs) > 0 {
		total := 0
		for _, d := range newDocs {
			if d.Status != "ready" {
				continue
			}
			body := docFullText(ctx, st, d.ID)
			runes := []rune(body)
			if len(runes) > attachInjectPerFile {
				runes = runes[:attachInjectPerFile]
			}
			if total+len(runes) > attachInjectTotal {
				runes = runes[:attachInjectTotal-total]
			}
			if len(runes) == 0 {
				continue
			}
			sb.WriteString(fmt.Sprintf("【已附加文件：%s】\n%s\n", d.Filename, string(runes)))
			total += len(runes)
			if total >= attachInjectTotal {
				break
			}
		}
		return sb.String()
	}
	// 后续轮：检索关联文档
	if len(allDocs) == 0 {
		return ""
	}
	terms := queryTerms(question)
	hits := retrieveFromDocs(ctx, st, allDocs, terms, 6)
	if len(hits) == 0 {
		return "" // 检索不到就不注入，避免噪音
	}
	sb.WriteString("（本会话曾上传文件，以下为按当前问题检索到的相关片段，可据此作答并标注出处）\n")
	for _, h := range hits {
		runes := []rune(h.Content)
		if len(runes) > 500 {
			runes = runes[:500]
		}
		sb.WriteString(fmt.Sprintf("--- [出处：%s] ---\n%s\n", h.Filename, string(runes)))
	}
	return sb.String()
}

func docFullText(ctx context.Context, st store.Store, docID string) string {
	cs, err := st.GetDocumentChunks(ctx, docID)
	if err != nil {
		return ""
	}
	var sb strings.Builder
	for _, c := range cs {
		sb.WriteString(c.Content)
		sb.WriteString("\n")
	}
	return sb.String()
}

type hit struct {
	Filename string
	Content  string
}

// retrieveFromDocs 在指定文档块中按词元匹配（OR），按命中词数排序取 topK。
func retrieveFromDocs(ctx context.Context, st store.Store, docs []*store.Document, terms []string, topK int) []hit {
	type scored struct {
		hit
		score int
	}
	var scoredHits []scored
	for _, d := range docs {
		if d.Status != "ready" {
			continue
		}
		cs, err := st.GetDocumentChunks(ctx, d.ID)
		if err != nil {
			continue
		}
		for _, c := range cs {
			lower := strings.ToLower(c.Content)
			s := 0
			for _, t := range terms {
				if strings.Contains(lower, t) {
					s++
				}
			}
			if s > 0 {
				scoredHits = append(scoredHits, scored{hit{d.Filename, c.Content}, s})
			}
		}
	}
	sort.Slice(scoredHits, func(i, j int) bool { return scoredHits[i].score > scoredHits[j].score })
	out := make([]hit, 0, topK)
	for i, h := range scoredHits {
		if i >= topK {
			break
		}
		out = append(out, h.hit)
	}
	return out
}

// queryTerms 简单词元：空白词 + 中文 2-gram（小写）。
func queryTerms(q string) []string {
	var terms []string
	seen := map[string]bool{}
	add := func(t string) {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" || len([]rune(t)) < 2 || seen[t] {
			return
		}
		seen[t] = true
		terms = append(terms, t)
	}
	for _, f := range strings.Fields(q) {
		add(f)
	}
	runes := []rune(q)
	for i := 0; i+2 <= len(runes); i++ {
		if isCJKish(runes[i]) && isCJKish(runes[i+1]) {
			add(string(runes[i : i+2]))
		}
	}
	return terms
}

func isCJKish(r rune) bool {
	return (r >= 0x4E00 && r <= 0x9FFF) || (r >= 0x3400 && r <= 0x4DBF)
}
