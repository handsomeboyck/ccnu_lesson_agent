// Package config 负责加载服务端配置（环境变量 + 默认值）。
package config

import (
	"os"
	"time"
)

type Config struct {
	Port            string
	JWTSecret       string
	AccessTokenTTL  time.Duration
	RefreshTokenTTL time.Duration
	CORSOrigins     []string
	OpenAIAPIKey    string
	OpenAIBaseURL   string
	OpenAIModel     string
}

// Load 从环境变量读取配置，未设置时使用默认值（适合本地开发）。
func Load() *Config {
	cfg := &Config{
		Port:            getenv("PORT", "8080"),
		JWTSecret:       getenv("JWT_SECRET", "dev-secret-change-me-in-production"),
		AccessTokenTTL:  time.Duration(getenvInt("ACCESS_TOKEN_TTL_MIN", 120)) * time.Minute,
		RefreshTokenTTL: time.Duration(getenvInt("REFRESH_TOKEN_TTL_HOURS", 24*14)) * time.Hour,
		OpenAIAPIKey:    os.Getenv("OPENAI_API_KEY"),
		OpenAIBaseURL:   getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		OpenAIModel:     getenv("OPENAI_MODEL", "gpt-4o-mini"),
	}
	if v := os.Getenv("CORS_ORIGINS"); v != "" {
		for _, o := range splitCSV(v) {
			cfg.CORSOrigins = append(cfg.CORSOrigins, o)
		}
	} else {
		cfg.CORSOrigins = []string{"http://localhost:5173", "http://127.0.0.1:5173"}
	}
	return cfg
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getenvInt(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n := 0
	for _, r := range v {
		if r < '0' || r > '9' {
			return def
		}
		n = n*10 + int(r-'0')
	}
	return n
}

func splitCSV(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == ',' {
			if cur != "" {
				out = append(out, cur)
			}
			cur = ""
			continue
		}
		cur += string(r)
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}
