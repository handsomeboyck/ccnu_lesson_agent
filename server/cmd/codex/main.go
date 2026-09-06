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
	"os/exec"
	"strconv"
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
	mux.HandleFunc("GET /metrics/sys", handleSysMetrics)

	// 并发限制（默认 2 个并发沙箱，防雪崩）
	concurrency := getenvInt("CODEX_CONCURRENCY", 2)
	sem := make(chan struct{}, concurrency)

	// 启动时清理历史残留作业
	cleanupJobs(hostJobs)

	mux.HandleFunc("POST /exec", func(w http.ResponseWriter, r *http.Request) {
		select {
		case sem <- struct{}{}:
			defer func() { <-sem }()
		default:
			writeErr(w, 429, "codex busy: too many concurrent executions")
			return
		}
		handleExec(w, r, runner, hostJobs)
	})

	log.Printf("codex-worker listening on :%s (image=%s jobs=%s concurrency=%d)",
		port, image, hostJobs, concurrency)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}

// cleanupJobs 清理 jobs 目录下的旧作业目录（残留）。
func cleanupJobs(hostJobs string) {
	entries, err := os.ReadDir(hostJobs)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-30 * time.Minute)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		p := hostJobs + "/" + e.Name()
		info, err := e.Info()
		if err != nil || info.ModTime().Before(cutoff) {
			_ = os.RemoveAll(p)
		}
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
	// LibreOffice 把 pptx 转同名 pdf 供前端预览（失败不阻塞，pdf 未生成则仅保留 pptx）
	if err == nil && resp != nil && len(resp.Artifacts) > 0 {
		convCtx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
		resp.Artifacts = runner.ConvertOfficeToPDF(convCtx, job, resp.Artifacts)
		cancel()
	}
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

// ---- 系统指标（宿主只读 + docker stats）----

// HostSnapshot 宿主概览（经 /host 只读挂载读 /proc；未挂载则各项为空）。
type HostSnapshot struct {
	Hostname    string   `json:"hostname"`
	LoadAvg     [3]float64 `json:"load_avg"`
	MemTotalKB  int64    `json:"mem_total_kb"`
	MemAvailKB  int64    `json:"mem_avail_kb"`
	CPUCores    int      `json:"cpu_cores"`
}

// ContainerStat 单个容器运行状态（docker stats 采样）。
type ContainerStat struct {
	Name    string `json:"name"`
	CPU     string `json:"cpu"`
	Mem     string `json:"mem"`
	MemPerc string `json:"mem_perc"`
}

type SysMetrics struct {
	Host       HostSnapshot     `json:"host"`
	Containers []ContainerStat  `json:"containers"`
	UpSince    time.Time        `json:"up_since"`
}

const hostRoot = "/host" // compose 以只读方式把宿主根挂到 worker 容器

func handleSysMetrics(w http.ResponseWriter, r *http.Request) {
	out := SysMetrics{UpSince: processStart}
	if hostname, err := os.ReadFile(hostRoot + "/proc/sys/kernel/hostname"); err == nil {
		out.Host.Hostname = strings.TrimSpace(string(hostname))
	}
	// loadavg
	if b, err := os.ReadFile(hostRoot + "/proc/loadavg"); err == nil {
		f := strings.Fields(string(b))
		for i := 0; i < 3 && i < len(f); i++ {
			v, _ := strconv.ParseFloat(f[i], 64)
			out.Host.LoadAvg[i] = v
		}
	}
	readMemInfo(&out.Host)
	out.Host.CPUCores = readCPUCount()
	collectContainerStats(&out.Containers)
	writeJSON(w, 200, out)
}

func readMemInfo(h *HostSnapshot) {
	data, err := os.ReadFile(hostRoot + "/proc/meminfo")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		v, _ := strconv.ParseInt(f[1], 10, 64)
		switch f[0] {
		case "MemTotal:":
			h.MemTotalKB = v
		case "MemAvailable:":
			h.MemAvailKB = v
		}
	}
}

func readCPUCount() int {
	data, err := os.ReadFile(hostRoot + "/proc/cpuinfo")
	if err != nil {
		return 0
	}
	return strings.Count(string(data), "processor\t:")
}

// collectContainerStats 采样本 compose 项目内容器（docker stats --no-stream）。
// 通过容器名前缀匹配：当前 compose 项目目录为 /opt/ccnu_lesson_agent（项目名同目录名）。
func collectContainerStats(out *[]ContainerStat) {
	// 1) 列出本项目容器名（name 前缀 ccnu_lesson_agent）
	ps, err := exec.CommandContext(context.Background(), "docker",
		"ps", "--filter", "name=ccnu_lesson_agent", "--format", "{{.Names}}").Output()
	if err != nil {
		return
	}
	var names []string
	for _, n := range strings.Fields(string(ps)) {
		if strings.HasPrefix(n, "ccnu_lesson_agent") {
			names = append(names, n)
		}
	}
	if len(names) == 0 {
		return
	}
	// 2) 对这批容器取一次 stats（每行一个容器）
	args := append([]string{"stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"}, names...)
	cmd := exec.CommandContext(context.Background(), "docker", args...)
	b, err := cmd.Output()
	if err != nil {
		return
	}
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) != 4 {
			continue
		}
		*out = append(*out, ContainerStat{Name: f[0], CPU: f[1], Mem: f[2], MemPerc: f[3]})
	}
}

var processStart = time.Now()

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
