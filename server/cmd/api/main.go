// ccnu_lesson_agent server — 教育版 Web 智能体 Agent 服务端入口。
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
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

	// 数据访问：M0 默认内存实现（本地演示）；生产切换 Postgres 实现（M1+）。
	st := store.NewMemory()

	authSvc := auth.NewService(st, cfg)

	// Skill 注册表（内置 Skill 全部注册）
	reg := skill.NewRegistry()
	skill.RegisterDefaults(reg)

	// LLM Provider：配置了 OPENAI_API_KEY 用 OpenAI，否则 Demo 模式。
	prov := model.New(cfg)

	handler := gateway.New(cfg, authSvc, st, prov, reg, cfg.OpenAIModel)

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

func providerName(cfg *config.Config) string {
	if cfg.OpenAIAPIKey != "" {
		return "openai (" + cfg.OpenAIBaseURL + ")"
	}
	return "demo (no OPENAI_API_KEY)"
}
