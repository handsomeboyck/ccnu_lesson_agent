package skill

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/codex"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// NewExecuteCode 创建 Python 代码沙箱平台原语。
// 模型/SKILL.md 可编写 Python 完成文件解析（.doc/OCR/复杂表格）、数据分析与可视化等；
// 代码在 Docker 一次性容器（非root/只读/禁网/限额/超时）中执行。
func NewExecuteCode() Skill {
	return &executeCode{}
}

type executeCode struct{}

func (s *executeCode) Name() string { return "execute_code" }
func (s *executeCode) Description() string {
	return "在 Python 代码沙箱中执行一段代码并返回运行结果。可处理：复杂文档解析（含老式 .doc、扫描件可用 pytesseract OCR）、" +
		"表格处理、数据分析、matplotlib 绘图、生成 .docx/.pptx/.xlsx/.pdf 等文件。当用户请求超出内置解析能力（如 .doc、OCR、复杂计算/绘图）、" +
		"或希望得到可下载的文件（如试卷 docx、课件 pptx、图表 png、表格 xlsx、报告 pdf）时调用。保存文件请写到当前工作目录（相对路径即可），" +
		"文件名用英文/拼音避免编码问题；生成的 png/docx/pptx/xlsx/pdf/csv 等会被自动收集为用户可下载的产物。**生成 .pptx 后系统会自动转出同名 .pdf 供网页预览**。" +
		"生成 PDF 可用 reportlab（中文用 UnicodeCIDFont('STSong-Light')）或 fpdf2；matplotlib 输出 pdf 亦可。"
}
func (s *executeCode) Modes() []string { return []string{} } // 全部模式

func (s *executeCode) Parameters() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"code":   map[string]any{"type": "string", "description": "要执行的 Python 代码"},
			"reason": map[string]any{"type": "string", "description": "这段代码要做什么（一句话，便于审计）"},
			"files": map[string]any{
				"type":        "array",
				"description": "需要读取的用户资料库文件（documents id 数组）",
				"items":       map[string]any{"type": "string"},
			},
		},
		"required": []string{"code"},
	}
}

// Commands：/py 你的任务（模型据此写代码执行）
func (s *executeCode) Commands() []string { return []string{"py", "执行", "run"} }

func (s *executeCode) CommandArgs(rawText string) map[string]any {
	return map[string]any{"request": strings.TrimSpace(rawText), "_run": true}
}

func (s *executeCode) Execute(ctx context.Context, env *Env, args json.RawMessage) (*Result, error) {
	var in struct {
		Code    string   `json:"code"`
		Reason  string   `json:"reason"`
		Files   []string `json:"files"`
		Request string   `json:"request"` // 命令路径传入的自然语言任务
		Run     bool     `json:"_run"`
	}
	if len(args) > 0 {
		_ = json.Unmarshal(args, &in)
	}
	// 命令路径（/py 任务描述）：无现成代码 → 需要模型撰写，这里提示沙箱已就绪并给指引；
	// 实际完整代码由模型在自然对话中调用 execute_code 时提供。
	if in.Code == "" {
		if in.Request != "" {
			return &Result{
				Content: "（沙箱就绪）请为任务编写完整 Python 代码并通过 execute_code 执行：" + in.Request + "\n若涉及资料库文件，请说明文件用途以便读取。",
				Summary: "等待你提供可执行的 Python 代码",
				Done:    true,
			}, nil
		}
		return &Result{Content: "缺少 code 参数，请提供要执行的 Python 代码。", Summary: "缺少代码", Done: true}, nil
	}

	if env.Codex == nil || !env.Codex.Enabled() {
		return &Result{
			Content: "代码沙箱（execute_code）当前未启用：服务端未配置 CODEX_URL，无法执行代码。请基于其他 Skill 或知识完成请求。",
			Summary: "沙箱未启用",
			Done:    true,
		}, nil
	}

	req := codex.ExecRequest{Code: in.Code}
	// 读取用户资料库原件（uploadDir/<docID>_<filename>）
	for _, docID := range in.Files {
		if docID == "" {
			continue
		}
		doc, err := env.Store.GetDocument(ctx, docID, env.UserID)
		if err != nil || env.UploadDir == "" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(env.UploadDir, doc.ID+"_"+sanitizeName(doc.Filename)))
		if err != nil {
			req.Files = append(req.Files, codex.InFile{
				Name: doc.Filename,
				// 未找到原件：退回说明（不会让沙箱读空文件）
				Content: base64.StdEncoding.EncodeToString([]byte("original file unavailable")),
			})
			continue
		}
		req.Files = append(req.Files, codex.InFile{
			Name:    doc.Filename,
			Content: base64.StdEncoding.EncodeToString(raw),
		})
	}

	resp, err := env.Codex.Exec(ctx, req)
	recordCodexRun(ctx, env, err, resp)
	if err != nil {
		// 沙箱不稳定：不打断对话，降级为明确提示（模型可改用其它能力）。
		return &Result{
			Content: "代码沙箱（execute_code）暂时不可用（" + err.Error() + "）。请勿再重试 execute_code，" +
				"改用其它 Skill 或内置解析能力完成请求，或请用户稍后重试。",
			Summary: "沙箱暂不可用",
			Done:    true,
		}, nil
	}
	if resp == nil {
		return &Result{Content: "沙箱无响应。", Summary: "执行无结果", Done: true}, nil
	}
	if resp.Error != "" {
		return &Result{Content: "沙箱执行失败：" + resp.Error, Summary: "沙箱错误", Done: true}, nil
	}

	var sb strings.Builder
	if resp.TimedOut {
		sb.WriteString("⏱ 代码执行超时（60s），已强制终止。请简化代码或拆小任务。\n\n")
	}
	sb.WriteString(fmt.Sprintf("**运行结果（退出码 %d）**\n\n", resp.ExitCode))
	if resp.ExitCode != 0 {
		sb.WriteString("> 代码执行出错，请阅读错误并修正代码后重试。\n\n")
	}
	if stdout := strings.TrimSpace(resp.Stdout); stdout != "" {
		sb.WriteString("**标准输出：**\n```text\n" + truncateRune(stdout, 3000) + "\n```\n")
	}
	if stderr := strings.TrimSpace(resp.Stderr); stderr != "" {
		sb.WriteString("**错误输出：**\n```text\n" + truncateRune(stderr, 2000) + "\n```\n")
	}
	if sb.Len() == 0 {
		sb.WriteString("（无输出，代码正常结束）\n")
	}

	// 产物：落盘到 ArtifactDir + 写 artifacts 表（可持久化浏览）；再转预览用 data（仅图片/短文本）
	var views []ArtifactView
	if len(resp.Artifacts) > 0 {
		names := make([]string, 0, len(resp.Artifacts))
		for _, a := range resp.Artifacts {
			names = append(names, a.Name)
			v := ArtifactView{Name: a.Name, Mime: a.Mime}
			// 1) 持久化（配置了 ArtifactDir 时有数据）
			if id := persistArtifact(ctx, env, a); id != "" {
				v.ID = id
			}
			// 2) 对话内即时预览 data：图片给 base64；文本给明文；二进制文档不给
			//   （数据已在服务器落盘，前端经 /raw 下载/查看，避免 SSE 膨胀）
			switch {
			case strings.HasPrefix(a.Mime, "image/"):
				if len(a.Data) > 0 && len(a.Data) <= 4<<20 { // base64 ≤ 4MB 可展示
					v.Data = a.Data
				}
			case strings.HasPrefix(a.Mime, "text/"):
				if len(a.Data) > 0 && len(a.Data) <= 300<<10 {
					v.Data = a.Data
				}
			}
			views = append(views, v)
		}
		sb.WriteString("\n**生成文件：** " + strings.Join(names, "、") + "\n")
	}
	return &Result{
		Content:   sb.String(),
		Summary:   fmt.Sprintf("代码已执行（退出码 %d%s）", resp.ExitCode, map[bool]string{true: "，超时", false: ""}[resp.TimedOut]),
		Artifacts: views,
		Done:      false, // 交给模型基于 stdout 组织答复
	}, nil
}

// recordCodexRun 记录一次沙箱执行指标（监控用；失败静默）。
func recordCodexRun(ctx context.Context, env *Env, err error, resp *codex.ExecResponse) {
	if env == nil || env.Store == nil {
		return
	}
	ev := &store.MetricEvent{Kind: "codex", Status: "ok", Skill: "execute_code", At: time.Now()}
	if err != nil || resp == nil {
		ev.Status = "error"
	} else if resp.Error != "" || resp.ExitCode != 0 || resp.TimedOut {
		ev.Status = "error"
	}
	_ = env.Store.AppendMetric(ctx, ev)
}

// persistArtifact 把沙箱产物写入 ArtifactDir + artifacts 表，返回新 id（失败返回空）。
func persistArtifact(ctx context.Context, env *Env, a codex.Artifact) string {
	if env == nil || env.ArtifactDir == "" || env.Store == nil {
		return ""
	}
	// 文本原样写入；图片/二进制文档 base64 解码后写入
	var raw []byte
	if strings.HasPrefix(a.Mime, "text/") {
		raw = []byte(a.Data)
	} else {
		dec, err := base64.StdEncoding.DecodeString(a.Data)
		if err != nil {
			return ""
		}
		raw = dec
	}
	if len(raw) == 0 {
		return ""
	}
	name := sanitizeName(a.Name)
	rec := &store.Artifact{
		UserID:         env.UserID,
		ConversationID: env.ConversationID,
		Skill:          "execute_code",
		Filename:       name,
		Mime:           a.Mime,
		SizeBytes:      int64(len(raw)),
	}
	if err := env.Store.CreateArtifact(ctx, rec); err != nil {
		return ""
	}
	rec.StorageKey = rec.ID + "_" + name
	// 更新 storageKey（Create 时不带，这里回填一次）
	_ = env.Store.UpdateArtifactStorageKey(ctx, rec.ID, env.UserID, rec.StorageKey)
	if err := os.MkdirAll(env.ArtifactDir, 0o755); err == nil {
		_ = os.WriteFile(filepath.Join(env.ArtifactDir, rec.StorageKey), raw, 0o644)
	}
	return rec.ID
}

func sanitizeName(s string) string {
	s = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return '_'
		}
		return r
	}, s)
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

func truncateRune(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
