// Package config 负责加载服务端配置（.env 文件 + 环境变量 + 默认值）。
package config

import (
	"bufio"
	"os"
	"strings"
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
	DatabaseURL     string // 空 = 使用内存 store（本地开发演示）
	WebDist         string // 前端静态资源目录（空 = 不托管前端）
	SkillsDir       string // SKILL.md 技能目录（默认 ./skills）
	SkillsDefault   string // 默认技能副本目录（SkillsDir 为空时初始化用，容器场景）
	UploadDir       string // 上传原文件暂存目录（空 = 仅存解析文本）
	ArtifactDir     string // 沙箱产物持久化目录（空 = 产物不落盘）
	CodexURL        string // Python 沙箱 worker 地址（空 = 沙箱未启用）
}

// LoadDotEnv 读取 .env 文件（KEY=VALUE，支持 # 注释与可选引号）。
// 优先级：已存在的系统环境变量 > .env 文件值（即 .env 不覆盖已 export 的变量）。
// 文件路径：ENV_FILE 环境变量指定，否则默认 "./.env"；文件不存在时静默跳过。
func LoadDotEnv() {
	path := os.Getenv("ENV_FILE")
	if path == "" {
		path = "./.env"
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.Index(line, "=")
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		val = strings.Trim(val, `"'`)
		if key == "" {
			continue
		}
		if _, ok := os.LookupEnv(key); !ok {
			_ = os.Setenv(key, val)
		}
	}
}

// Load 从环境变量读取配置（先加载 .env），未设置时使用默认值（适合本地开发）。
func Load() *Config {
	LoadDotEnv()
	cfg := &Config{
		Port:            getenv("PORT", "8080"),
		JWTSecret:       getenv("JWT_SECRET", "dev-secret-change-me-in-production"),
		AccessTokenTTL:  time.Duration(getenvInt("ACCESS_TOKEN_TTL_MIN", 120)) * time.Minute,
		RefreshTokenTTL: time.Duration(getenvInt("REFRESH_TOKEN_TTL_HOURS", 24*14)) * time.Hour,
		OpenAIAPIKey:    os.Getenv("OPENAI_API_KEY"),
		OpenAIBaseURL:   getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		OpenAIModel:     getenv("OPENAI_MODEL", "gpt-4o-mini"),
		DatabaseURL:     os.Getenv("DATABASE_URL"),
		WebDist:         os.Getenv("WEB_DIST"),
		SkillsDir:       getenv("SKILLS_DIR", "skills"),
		SkillsDefault:   os.Getenv("SKILLS_DEFAULT"),
		UploadDir:       os.Getenv("UPLOAD_DIR"),
		ArtifactDir:     os.Getenv("ARTIFACT_DIR"),
		CodexURL:        os.Getenv("CODEX_URL"),
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
