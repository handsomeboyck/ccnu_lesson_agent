// Package gateway 提供 HTTP 层：路由、中间件、REST 与 SSE 处理器。
package gateway

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/auth"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/codex"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/config"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/skill"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// New 构建全部路由。
func New(cfg *config.Config, authSvc *auth.Service, st store.Store, prov model.Provider,
	reg *skill.Registry, loader *skill.Loader, codexCli *codex.Client, modelName string) http.Handler {
	authH := &authService{svc: authSvc}
	convH := &convService{store: st}
	libH := &libraryService{store: st, uploadDir: cfg.UploadDir}
	artH := &artifactService{store: st, artifactDir: cfg.ArtifactDir}
	skillH := &skillService{loader: loader, registry: reg}
	chatH := &chatService{store: st, conv: convH, provider: prov, registry: reg,
		codex: codexCli, uploadDir: cfg.UploadDir, artifactDir: cfg.ArtifactDir, model: modelName,
		genCancel: map[string]context.CancelFunc{}, genStart: map[string]time.Time{},
		streams: newStreamRegistry()}
	chatH.attach = &chatAttachmentService{store: st, uploadDir: cfg.UploadDir}
	monH := newMonitorService(st, codexCli, cfg.OpenAIBaseURL, cfg.OpenAIAPIKey)
	adminH := newAdminService(cfg.APIKeyFile, cfg.OpenAIBaseURL)

	mux := http.NewServeMux()

	// 健康检查
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// 认证（公开）
	mux.HandleFunc("POST /v1/auth/register", authH.register)
	mux.HandleFunc("POST /v1/auth/login", authH.login)
	mux.HandleFunc("POST /v1/auth/refresh", authH.refresh)
	mux.HandleFunc("POST /v1/auth/logout", authH.logout)
	mux.HandleFunc("GET /v1/auth/me", authH.requireAuth(authH.me))

	// 会话（需登录）
	mux.HandleFunc("GET /v1/conversations", authH.requireAuth(convH.list))
	mux.HandleFunc("POST /v1/conversations", authH.requireAuth(convH.create))
	mux.HandleFunc("GET /v1/conversations/{id}", authH.requireAuth(convH.get))
	mux.HandleFunc("PATCH /v1/conversations/{id}", authH.requireAuth(convH.rename))
	mux.HandleFunc("DELETE /v1/conversations/{id}", authH.requireAuth(convH.delete))
	mux.HandleFunc("GET /v1/conversations/{id}/messages", authH.requireAuth(convH.messages))

	// 用户资料库（需登录）
	mux.HandleFunc("POST /v1/library/files", authH.requireAuth(libH.upload))
	mux.HandleFunc("GET /v1/library/files", authH.requireAuth(libH.list))
	mux.HandleFunc("DELETE /v1/library/files/{id}", authH.requireAuth(libH.remove))

	// 产物库（需登录）
	mux.HandleFunc("GET /v1/artifacts", authH.requireAuth(artH.list))
	mux.HandleFunc("GET /v1/artifacts/{id}/raw", authH.requireAuth(artH.raw))
	mux.HandleFunc("DELETE /v1/artifacts/{id}", authH.requireAuth(artH.remove))

	// 对话（SSE，需登录）
	mux.HandleFunc("POST /v1/chat", authH.requireAuth(chatH.stream))
	// 流重放：断线后从指定 seq 续传（需登录）
	mux.HandleFunc("GET /v1/chat/stream/{streamId}", authH.requireAuth(chatH.handleStreamReplay))
	// 显式停止后台生成（需登录）
	mux.HandleFunc("POST /v1/chat/stop", authH.requireAuth(chatH.handleStop))
	// 正在后台生成的会话列表（刷新恢复用，需登录）
	mux.HandleFunc("GET /v1/chat/generating", authH.requireAuth(chatH.handleGenerating))
	// 对话附件（多文件，同步解析入资料库，需登录）
	mux.HandleFunc("POST /v1/chat/attachments", authH.requireAuth(chatH.attach.upload))

	// Skill 清单 + 命令清单 + 文档技能管理（需登录；改动建议仅 teacher/admin）
	mux.HandleFunc("GET /v1/skills", authH.requireAuth(skillH.list))
	mux.HandleFunc("GET /v1/skills/{name}", authH.requireAuth(skillH.docDetail))
	mux.HandleFunc("PUT /v1/skills/{name}", authH.requireRole(skillH.save, store.RoleTeacher, store.RoleAdmin))
	mux.HandleFunc("DELETE /v1/skills/{name}", authH.requireRole(skillH.remove, store.RoleTeacher, store.RoleAdmin))

	// 监控（仅 admin）
	mux.HandleFunc("GET /v1/monitor/overview", authH.requireRole(monH.overview, store.RoleAdmin))
	mux.HandleFunc("GET /v1/monitor/health", authH.requireRole(monH.serviceHealth, store.RoleAdmin))
	mux.HandleFunc("GET /v1/monitor/conversations", authH.requireRole(monH.auditConversations, store.RoleAdmin))
	mux.HandleFunc("GET /v1/monitor/conversations/export-all", authH.requireRole(monH.auditExportAll, store.RoleAdmin))
	mux.HandleFunc("GET /v1/monitor/conversations/{id}", authH.requireRole(monH.auditTranscript, store.RoleAdmin))
	mux.HandleFunc("GET /v1/monitor/conversations/{id}/export", authH.requireRole(monH.auditExport, store.RoleAdmin))
	mux.HandleFunc("GET /v1/monitor/balance", authH.requireRole(monH.balance, store.RoleAdmin))
	mux.HandleFunc("GET /v1/monitor/user-costs", authH.requireRole(monH.userCosts, store.RoleAdmin))

	// Admin：API Key 热替换（仅 admin，验证连通性后即时生效）
	mux.HandleFunc("PUT /v1/admin/apikey", authH.requireRole(adminH.replaceAPIKey, store.RoleAdmin))

	handler := http.Handler(mux)
	handler = corsMiddleware(cfg.CORSOrigins, handler)
	handler = logMiddleware(handler)
	return handler
}

func corsMiddleware(origins []string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && contains(origins, origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		// RequestURI 含 query string（前端错误上报 /v1/debug/log?msg=... 依赖此记录 msg）
		log.Printf("%s %s %s (%s)", r.Method, r.URL.RequestURI(), r.RemoteAddr, time.Since(start))
	})
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
