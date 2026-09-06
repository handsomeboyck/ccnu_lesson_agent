// ccnu_lesson_agent server — 教育版 Web 智能体 Agent 服务端入口。
// 生产：配置 DATABASE_URL 启用 Postgres；配置 WEB_DIST 由 Go 托管前端静态资源（单端口）。
// 本地开发：无 DATABASE_URL 时回退内存 store；前端用 Vite dev（:5173 + 代理）。
package main

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/auth"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/config"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/gateway"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/skill"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

func main() {
	cfg := config.Load()

	// 数据访问：DATABASE_URL 存在 → Postgres（自动迁移）；否则内存（本地演示）。
	var st store.Store
	if cfg.DatabaseURL != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		pg, err := store.NewPostgres(ctx, cfg.DatabaseURL)
		cancel()
		if err != nil {
			log.Fatalf("postgres init failed: %v", err)
		}
		st = pg
		log.Println("storage: postgres")
	} else {
		st = store.NewMemory()
		log.Println("storage: memory (no DATABASE_URL; set it for persistence)")
	}
	// 关闭时释放（内存/连接池统一接口）
	defer closeStore(st)

	// 目录准备：UPLOAD_DIR 确保存在；SKILLS_DIR 为空且存在默认副本时初始化默认技能。
	prepareDirs(cfg)

	authSvc := auth.NewService(st, cfg)

	// Skill 注册：
	// 1) 平台原语（ask_user / knowledge_retrieve 等，Go 实现）；
	// 2) 文档型 Skill（skills/ 目录下每个 SKILL.md）——动态加载，无需改代码。
	reg := skill.NewRegistry()
	skill.RegisterDefaults(reg)
	loader := skill.NewLoader(cfg.SkillsDir)
	if docs, err := loader.Load(); err != nil {
		log.Printf("skill loader: %v", err)
	} else {
		for _, d := range docs {
			reg.Register(d)
			log.Printf("skill: loaded doc skill %q (from %s)", d.Name(), d.Dir)
		}
	}

	// LLM Provider：OPENAI_API_KEY 存在 → OpenAI 兼容；否则 Demo。
	prov := model.New(cfg)

	apiHandler := gateway.New(cfg, authSvc, st, prov, reg, loader, cfg.OpenAIModel)

	// 前端静态托管（SPA）：/v1、/healthz 走 API，其余回退 index.html。
	handler := withStatic(apiHandler, cfg.WebDist)

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("ccnu_lesson_agent server listening on :%s (model=%s, provider=%s)",
			cfg.Port, cfg.OpenAIModel, providerName(cfg))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	// 优雅退出
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

// closeStore 兼容释放：Postgres 实现带 Close()。
func closeStore(st store.Store) {
	type closer interface{ Close() }
	if c, ok := st.(closer); ok {
		c.Close()
	}
}

// prepareDirs 准备运行目录：
//  1. UPLOAD_DIR（若配置）确保存在；
//  2. SKILLS_DIR 为空目录 且 SKILLS_DEFAULT 存在 → 把默认 SKILL.md 复制进 SKILLS_DIR
//     （容器内 skills 挂载持久卷首次为空时仍开箱自带默认技能）。
func prepareDirs(cfg *config.Config) {
	if cfg.UploadDir != "" {
		if err := os.MkdirAll(cfg.UploadDir, 0o755); err != nil {
			log.Printf("upload dir: %v", err)
		}
	}
	if cfg.SkillsDefault == "" {
		return
	}
	// SkillsDir 已含任何 SKILL.md 则跳过
	if hasSkillDoc(cfg.SkillsDir) {
		return
	}
	if _, err := os.Stat(cfg.SkillsDefault); err != nil {
		return // 默认目录不存在（本地开发），无需处理
	}
	// 复制默认技能目录内容
	entries, err := os.ReadDir(cfg.SkillsDefault)
	if err != nil {
		log.Printf("skills default read: %v", err)
		return
	}
	copied := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		src := filepath.Join(cfg.SkillsDefault, e.Name())
		if _, err := os.Stat(filepath.Join(src, "SKILL.md")); err != nil {
			continue
		}
		dst := filepath.Join(cfg.SkillsDir, e.Name())
		if err := os.MkdirAll(dst, 0o755); err != nil {
			continue
		}
		if err := copyFile(filepath.Join(src, "SKILL.md"), filepath.Join(dst, "SKILL.md")); err == nil {
			copied++
		}
	}
	log.Printf("skills: initialized %d default skill(s) into %s", copied, cfg.SkillsDir)
}

// hasSkillDoc 判断目录下是否存在任意 SKILL.md。
func hasSkillDoc(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.IsDir() {
			if _, err := os.Stat(filepath.Join(dir, e.Name(), "SKILL.md")); err == nil {
				return true
			}
		}
	}
	return false
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}

// withStatic 把 /v1 与 /healthz 交给 api，其余路径从 webDist 提供 SPA 静态资源。
// webDist 为空或目录不存在时仅提供 API（本地开发模式）。
func withStatic(api http.Handler, webDist string) http.Handler {
	fileHandler := http.Handler(nil)
	if webDist != "" {
		if info, err := os.Stat(webDist); err == nil && info.IsDir() {
			fileServer := http.FileServer(http.Dir(webDist))
			fileHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				clean := filepath.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
				// 若请求对应真实文件则直接提供；否则 SPA fallback 到 index.html
				if _, err := fs.Stat(os.DirFS(webDist), filepath.ToSlash(strings.TrimPrefix(clean, "/"))); err == nil && clean != "/" {
					fileServer.ServeHTTP(w, r)
					return
				}
				http.ServeFile(w, r, filepath.Join(webDist, "index.html"))
			})
			log.Printf("static: serving web dist from %s", webDist)
		} else {
			log.Printf("static: WEB_DIST=%s not found, skip static hosting", webDist)
		}
	}
	if fileHandler == nil {
		return api
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/") || strings.HasPrefix(r.URL.Path, "/healthz") {
			api.ServeHTTP(w, r)
			return
		}
		fileHandler.ServeHTTP(w, r)
	})
}

func providerName(cfg *config.Config) string {
	if cfg.OpenAIAPIKey != "" {
		return "openai-compatible (" + cfg.OpenAIBaseURL + ")"
	}
	return "demo (no OPENAI_API_KEY)"
}
