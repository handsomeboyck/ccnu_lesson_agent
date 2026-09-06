// codex-worker：Python 沙箱执行服务（独立容器运行，挂 docker.sock）。
// 仅监听内部网络（默认 :9090），提供 /exec 供 app 调用。
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/codex"
)

func main() {
	port := getenv("CODEX_PORT", "9090")
	image := getenv("CODEX_SANDBOX_IMAGE", "ccnu-codex:latest")
	hostJobs := getenv("CODEX_HOST_JOBS", "/opt/ccnu_codex_jobs") // 宿主侧（docker -v 可见）
	timeout := time.Duration(getenvInt("CODEX_TIMEOUT_SEC", 60)) * time.Second

	if err := os.MkdirAll(hostJobs, 0o755); err != nil {
		log.Fatalf("mkdir jobs: %v", err)
	}

	runner := &codex.Runner{
		SandboxImage: image,
		HostJobsDir:  hostJobs,
		Timeout:      timeout,
		MaxStdout:    64 << 10,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("POST /exec", func(w http.ResponseWriter, r *http.Request) {
		handleExec(w, r, runner, hostJobs)
	})

	log.Printf("codex-worker listening on :%s (image=%s jobs=%s)", port, image, hostJobs)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}

func handleExec(w http.ResponseWriter, r *http.Request, runner *codex.Runner, hostJobs string) {
	var req codex.ExecRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 40<<20)).Decode(&req); err != nil {
		writeErr(w, 400, "bad request: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Code) == "" {
		writeErr(w, 400, "code is required")
		return
	}
	jobID := fmt.Sprintf("j%d", time.Now().UnixNano())
	// worker 容器与宿主共享同一 jobs 目录（compose bind），故宿主路径即可写。
	job, err := runner.Prepare(jobID, req.Code, req.Files)
	if err != nil {
		writeErr(w, 500, "prepare: "+err.Error())
		return
	}
	resp, err := runner.Run(r.Context(), job)
	_ = os.RemoveAll(hostJobs + "/" + jobID) // 清理（产物已读入内存）
	if err != nil {
		writeErr(w, 500, "run: "+err.Error())
		return
	}
	writeJSON(w, 200, resp)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getenvInt(k string, def int) int {
	v := os.Getenv(k)
	n := 0
	for _, r := range v {
		if r < '0' || r > '9' {
			return def
		}
		n = n*10 + int(r-'0')
	}
	if n == 0 {
		return def
	}
	return n
}

var _ = context.Background
