package codex

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Runner 在 worker 侧执行 Docker 一次性沙箱容器。
type Runner struct {
	SandboxImage     string // 沙箱镜像名（如 ccnu-codex:latest）
	HostJobsDir      string // 宿主侧 jobs 根目录（docker -v 需要宿主路径）
	ContainerJobsDir string // worker 容器内同一 jobs 根目录
	Timeout          time.Duration
	MaxStdout        int64 // 收集 stdout/stderr 上限
}

// Job 单次运行上下文。
type Job struct {
	ID     string
	InDir  string // 宿主侧输入目录（code.py + 文件）
	OutDir string // 宿主侧输出目录
}

// Prepare 在 jobs 目录下创建一次运行的输入/输出目录，写入代码与输入文件。
// 返回 InDir/OutDir（worker 容器内路径由调用方映射）。
func (r *Runner) Prepare(jobID, code string, files []InFile) (*Job, error) {
	hostIn := filepath.Join(r.HostJobsDir, jobID, "in")
	hostOut := filepath.Join(r.HostJobsDir, jobID, "out")
	if err := os.MkdirAll(hostIn, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(hostOut, 0o755); err != nil {
		return nil, err
	}
	// 沙箱内以 --user 1000 运行：OutDir（宿主由 worker root 创建）须对 uid 1000 可写
	if err := os.Chmod(hostOut, 0o777); err != nil {
		return nil, err
	}
	// code.py
	if err := os.WriteFile(filepath.Join(hostIn, "code.py"), []byte(code), 0o644); err != nil {
		return nil, err
	}
	for _, f := range files {
		if f.Name == "" {
			continue
		}
		// 防路径穿越
		safe := filepath.Base(f.Name)
		if safe == "." || safe == "/" {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(f.Content)
		if err != nil {
			raw = []byte(f.Content) // 容忍非 base64（直接文本）
		}
		if len(raw) > 30<<20 {
			return nil, fmt.Errorf("input file %s too large", f.Name)
		}
		if err := os.WriteFile(filepath.Join(hostIn, safe), raw, 0o644); err != nil {
			return nil, err
		}
	}
	return &Job{ID: jobID, InDir: hostIn, OutDir: hostOut}, nil
}

// Run 在沙箱容器中执行 code.py（见 Prepare），捕获输出与产物。
func (r *Runner) Run(ctx context.Context, job *Job) (*ExecResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, r.Timeout)
	defer cancel()

	containerName := "codex_" + job.ID
	args := []string{
		"run", "--rm", "--name", containerName,
		"--network=none",
		"--memory=512m", "--cpus=1", "--pids-limit=128",
		"--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
		"--user", "1000:1000",
		"--security-opt", "no-new-privileges",
		"-e", "PYTHONDONTWRITEBYTECODE=1",
		"-e", "MPLCONFIGDIR=/tmp", // read-only rootfs：matplotlib 配置放 tmpfs
		"-e", "HOME=/tmp",
		"-v", job.InDir + ":/in:ro",
		"-v", job.OutDir + ":/out:rw",
		"-w", "/out",
		r.SandboxImage,
		// 镜像 ENTRYPOINT 为 ["python","-u"]，此处只传脚本路径
		"/in/code.py",
	}
	cmd := exec.CommandContext(ctx, "docker", args...)

	var stdout, stderr limitedBuffer
	stdout.limit = r.MaxStdout
	stderr.limit = r.MaxStdout
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	resp := &ExecResponse{Stdout: stdout.String(), Stderr: stderr.String()}
	if ctx.Err() == context.DeadlineExceeded {
		// 超时强杀容器
		_ = exec.CommandContext(context.Background(), "docker", "kill", containerName).Run()
		_ = exec.CommandContext(context.Background(), "docker", "rm", "-f", containerName).Run()
		resp.TimedOut = true
		return resp, nil
	}
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			resp.ExitCode = ee.ExitCode()
		} else {
			return nil, fmt.Errorf("docker run: %w", err)
		}
	}
	// 收集产物
	resp.Artifacts = collectArtifacts(job.OutDir)
	return resp, nil
}

// ConvertOfficeToPDF 在作业产物里查找 .pptx，用沙箱镜像内置 LibreOffice headless
// 转出同名 .pdf（供前端网页预览），并合并回产物列表。转换失败不影响原产物。
func (r *Runner) ConvertOfficeToPDF(ctx context.Context, job *Job, arts []Artifact) []Artifact {
	type pdfPlan struct {
		pptx string // out 目录内 pptx 相对名
		pdf  string
	}
	var plans []pdfPlan
	for _, a := range arts {
		if strings.ToLower(filepath.Ext(a.Name)) != ".pptx" {
			continue
		}
		pdfName := strings.TrimSuffix(a.Name, filepath.Ext(a.Name)) + ".pdf"
		if _, err := os.Stat(filepath.Join(job.OutDir, pdfName)); err == nil {
			continue // 已有同名 pdf（代码里自己转了）
		}
		plans = append(plans, pdfPlan{pptx: a.Name, pdf: pdfName})
	}
	if len(plans) == 0 {
		return arts
	}
	for _, p := range plans {
		convCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
		containerName := "codex_conv_" + job.ID
		// 复用沙箱镜像（含 LibreOffice）；--entrypoint soffice 覆盖 python
		cmd := exec.CommandContext(convCtx, "docker",
			"run", "--rm", "--name", containerName,
			"--network=none",
			"--memory=1g", "--cpus=1",
			"--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
			"--user", "1000:1000",
			"--security-opt", "no-new-privileges",
			"-e", "HOME=/tmp",
			"-v", job.OutDir+":/out:rw",
			"-w", "/out",
			"--entrypoint", "soffice",
			r.SandboxImage,
			"--headless", "--norestore", "--nologo",
			"-env:UserInstallation=file:///tmp/lo_profile",
			"--convert-to", "pdf", "--outdir", "/out", p.pptx,
		)
		var stderr limitedBuffer
		stderr.limit = 8 << 10
		cmd.Stderr = &stderr
		_ = cmd.Run()
		cancel()
		_ = exec.CommandContext(context.Background(), "docker", "rm", "-f", containerName).Run()
		// 成功与否不强求：若 /out 出现同名 pdf 则 collectArtifacts 自会捕获
	}
	return collectArtifacts(job.OutDir)
}

func collectArtifacts(outDir string) []Artifact {
	var out []Artifact
	_ = filepath.WalkDir(outDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if info.Size() == 0 || info.Size() > 2<<20 {
			return nil // 跳过空/超大
		}
		a := Artifact{Name: d.Name(), Size: info.Size()}
		switch strings.ToLower(filepath.Ext(d.Name())) {
		case ".png":
			a.Mime = "image/png"
		case ".jpg", ".jpeg":
			a.Mime = "image/jpeg"
		case ".gif":
			a.Mime = "image/gif"
		case ".csv":
			a.Mime = "text/csv"
		case ".txt", ".md", ".json", ".html", ".py", ".log":
			a.Mime = "text/plain"
		case ".pdf":
			a.Mime = "application/pdf"
		case ".docx":
			a.Mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
		case ".pptx":
			a.Mime = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
		case ".xlsx":
			a.Mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
		default:
			return nil // 只保留可展示/可下载类型
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		// 文本原样（前端/模型预览）；图片与二进制文档 base64 内嵌传输
		if strings.HasPrefix(a.Mime, "text/") {
			a.Data = string(raw)
		} else {
			a.Data = base64.StdEncoding.EncodeToString(raw)
		}
		out = append(out, a)
		return nil
	})
	return out
}

// limitedBuffer 限制累积上限的 buffer。
type limitedBuffer struct {
	buf   []byte
	limit int64
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.limit > 0 && int64(len(b.buf)) >= b.limit {
		return len(p), nil // 静默丢弃超出部分
	}
	remain := b.limit - int64(len(b.buf))
	if remain < int64(len(p)) {
		b.buf = append(b.buf, p[:remain]...)
		return len(p), nil
	}
	b.buf = append(b.buf, p...)
	return len(p), nil
}

func (b *limitedBuffer) String() string { return string(b.buf) }
