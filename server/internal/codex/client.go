// Package codex 提供 Python 代码沙箱：app 通过 HTTP 调用独立的 codex-worker，
// worker 以 Docker 一次性容器（非root/只读/禁网/限额/超时）执行用户代码。
package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// InFile 传给沙箱的输入文件（base64 编码内容）。
type InFile struct {
	Name    string `json:"name"`
	Content string `json:"content"` // base64
}

// ExecRequest 执行请求。
type ExecRequest struct {
	Code  string   `json:"code"`
	Files []InFile `json:"files"`
}

// Artifact 沙箱产物（图片/csv/文本等）。
type Artifact struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Mime string `json:"mime"`
	Data string `json:"data,omitempty"` // base64（≤ maxArtifactBytes 时返回）
}

// ExecResponse 执行结果。
type ExecResponse struct {
	ExitCode  int        `json:"exit_code"`
	Stdout    string     `json:"stdout"`
	Stderr    string     `json:"stderr"`
	TimedOut  bool       `json:"timed_out"`
	Artifacts []Artifact `json:"artifacts,omitempty"`
	Error     string     `json:"error,omitempty"` // worker 层错误（非用户代码错误）
}

// Client 是 app → codex-worker 的 HTTP 客户端。
type Client struct {
	baseURL string
	hc      *http.Client
}

// NewClient 创建 codex 客户端；baseURL 如 http://codex:9090。
func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		hc:      &http.Client{Timeout: 120 * time.Second},
	}
}

// Health 探测 worker 是否可用（app 健康轮询用，短超时）。
func (c *Client) Health() error {
	if !c.Enabled() {
		return fmt.Errorf("codex not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/healthz", nil)
	if err != nil {
		return err
	}
	resp, err := c.hc.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("codex healthz status %d", resp.StatusCode)
	}
	return nil
}

// Enabled 是否配置了 codex-worker。
func (c *Client) Enabled() bool { return c != nil && c.baseURL != "" }

// SysMetricsResponse worker 返回的系统概览（宿主 + 容器）。
type SysMetricsResponse struct {
	Host struct {
		Hostname   string     `json:"hostname"`
		LoadAvg    [3]float64 `json:"load_avg"`
		MemTotalKB int64      `json:"mem_total_kb"`
		MemAvailKB int64      `json:"mem_avail_kb"`
		CPUCores   int        `json:"cpu_cores"`
		DiskTotalKB int64     `json:"disk_total_kb"`
		DiskFreeKB  int64     `json:"disk_free_kb"`
		DiskUsePct  float64   `json:"disk_use_pct"`
	} `json:"host"`
	Containers []struct {
		Name    string `json:"name"`
		CPU     string `json:"cpu"`
		Mem     string `json:"mem"`
		MemPerc string `json:"mem_perc"`
	} `json:"containers"`
	UpSince time.Time `json:"up_since"`
}

// SysMetrics 拉取 worker 侧系统指标（监控页用；worker 不可用时返回错误）。
func (c *Client) SysMetrics() (*SysMetricsResponse, error) {
	if !c.Enabled() {
		return nil, fmt.Errorf("codex not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/metrics/sys", nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.hc.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("codex sys status %d", resp.StatusCode)
	}
	var out SysMetricsResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Exec 执行一次沙箱运行。
func (c *Client) Exec(ctx context.Context, req ExecRequest) (*ExecResponse, error) {
	if !c.Enabled() {
		return nil, fmt.Errorf("codex sandbox 未启用（CODEX_URL 未配置）")
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/exec", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := c.hc.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("codex: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("codex: status %d: %s", resp.StatusCode, string(b))
	}
	var out ExecResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}
