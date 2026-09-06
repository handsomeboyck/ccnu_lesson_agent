package gateway

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// artifactService 提供产物库接口（沙箱/技能产物的列表/预览/下载/删除）。
type artifactService struct {
	store       store.Store
	artifactDir string
}

type artifactView struct {
	ID        string    `json:"id"`
	Filename  string    `json:"filename"`
	Mime      string    `json:"mime"`
	SizeBytes int64     `json:"size_bytes"`
	Skill     string    `json:"skill"`
	CreatedAt time.Time `json:"created_at"`
}

func toArtifactView(a *store.Artifact) artifactView {
	return artifactView{ID: a.ID, Filename: a.Filename, Mime: a.Mime, SizeBytes: a.SizeBytes, Skill: a.Skill, CreatedAt: a.CreatedAt}
}

// list GET /v1/artifacts?limit=
func (s *artifactService) list(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	items, err := s.store.ListArtifacts(r.Context(), claims.UserID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	out := make([]artifactView, 0, len(items))
	for _, a := range items {
		out = append(out, toArtifactView(a))
	}
	writeJSON(w, http.StatusOK, map[string]any{"artifacts": out})
}

// raw GET /v1/artifacts/{id}/raw —— 产物文件字节（鉴权后；Content-Disposition 支持下载）
func (s *artifactService) raw(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	a, err := s.store.GetArtifact(r.Context(), r.PathValue("id"), claims.UserID)
	if err != nil {
		writeError(w, http.StatusNotFound, "artifact not found")
		return
	}
	if s.artifactDir == "" || a.StorageKey == "" {
		writeError(w, http.StatusNotFound, "artifact file unavailable")
		return
	}
	// 防目录穿越：storageKey 是我们生成的 id_filename，仍做一次校验
	path := filepath.Join(s.artifactDir, a.StorageKey)
	if filepath.Dir(path) != s.artifactDir {
		writeError(w, http.StatusNotFound, "artifact file unavailable")
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "artifact file missing")
		return
	}
	mime := a.Mime
	if mime == "" {
		mime = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mime)
	if r.URL.Query().Get("download") == "1" {
		// RFC 5987 文件名编码
		w.Header().Set("Content-Disposition", `attachment; filename*=UTF-8''`+url.PathEscape(a.Filename))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// remove DELETE /v1/artifacts/{id}
func (s *artifactService) remove(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	a, err := s.store.GetArtifact(r.Context(), r.PathValue("id"), claims.UserID)
	if err != nil {
		writeError(w, http.StatusNotFound, "artifact not found")
		return
	}
	if s.artifactDir != "" && a.StorageKey != "" {
		_ = os.Remove(filepath.Join(s.artifactDir, a.StorageKey))
	}
	if err := s.store.DeleteArtifact(r.Context(), a.ID, claims.UserID); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
