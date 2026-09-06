// Package gateway 提供 HTTP 层：路由、中间件、REST 与 SSE 处理器。
package gateway

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/auth"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/config"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/skill"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// New 构建全部路由。
func New(cfg *config.Config, authSvc *auth.Service, st store.Store, prov model.Provider,
	reg *skill.Registry, modelName string) http.Handler {
	authH := &authService{svc: authSvc}
	convH := &convService{store: st}
	chatH := &chatService{store: st, conv: convH, provider: prov, registry: reg, model: modelName}

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

	// 对话（SSE，需登录）
	mux.HandleFunc("POST /v1/chat", authH.requireAuth(chatH.stream))

	// Skill 清单 + 命令清单（/ 菜单）
	mux.HandleFunc("GET /v1/skills", authH.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		all := reg.All()
		items := make([]map[string]any, 0, len(all))
		for _, s := range all {
			items = append(items, map[string]any{
				"name":        s.Name(),
				"description": s.Description(),
				"modes":       s.Modes(),
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"skills":   items,
			"commands": reg.Commands(),
		})
	}))

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
		log.Printf("%s %s %s (%s)", r.Method, r.URL.Path, r.RemoteAddr, time.Since(start))
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
