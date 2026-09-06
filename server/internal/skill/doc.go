// Package skill 定义 Skill 体系。
//
// Skill 分为两类：
//  1. 平台原语（Go 实现）：ask_user（提问暂停）、knowledge_retrieve（资料检索）等交互/检索能力；
//  2. 文档型 Skill（Claude 官方风格）：目录内 SKILL.md（YAML frontmatter + markdown 正文 + 可选附件）。
//     对话中模型请求该 Skill 时，agent 把 SKILL.md 全文作为上下文回填给模型，由模型按文档引导执行；
//     用户/管理员可在 skills 目录动态新增或修改，无需改 Go 代码、无需重启。
package skill

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"gopkg.in/yaml.v3"
)

// DocMeta 是 SKILL.md 的 YAML frontmatter。
type DocMeta struct {
	Name        string   `yaml:"name"`        // 技能名（也用作 tool/命令标识）
	Description string   `yaml:"description"` // 给模型/用户看的一句话说明
	Commands    []string `yaml:"commands"`    // 斜杠命令别名，如 ["quiz","出题"]
	Modes       []string `yaml:"modes"`       // 可用会话模式；空 = 全部
	Version     string   `yaml:"version"`
	Author      string   `yaml:"author"`
}

// DocSkill 是文档型技能（对应目录 <dir>/SKILL.md）。
type DocSkill struct {
	Meta    DocMeta  // frontmatter
	Content string   // SKILL.md markdown 正文（不含 frontmatter）
	Raw     string   // SKILL.md 完整原文（含 frontmatter，供编辑器/详情展示）
	Dir     string   // 技能目录绝对路径
	Files   []string // 目录内附件相对路径（脚本/模板等，SKILL.md 之外）
}

// ---- SKILL.md 解析 ----

var errNotSkill = errors.New("skill: not a SKILL.md")

// parseSkillDoc 读取并解析一个 SKILL.md。
func parseSkillDoc(path string) (*DocSkill, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	s := string(raw)
	// 移除 BOM
	s = strings.TrimPrefix(s, "\uFEFF")
	if !strings.HasPrefix(strings.TrimSpace(s), "---") {
		return nil, fmt.Errorf("%w: missing yaml frontmatter in %s", errNotSkill, path)
	}
	rest := strings.TrimSpace(s)
	rest = rest[3:] // 去掉开头 ---
	// 找正文分隔行：行首 "---"
	endIdx := -1
	lines := strings.Split(rest, "\n")
	var bodyLines []string
	for i, ln := range lines {
		if strings.TrimSpace(ln) == "---" {
			endIdx = i
			break
		}
		bodyLines = append(bodyLines, ln)
	}
	if endIdx < 0 {
		return nil, fmt.Errorf("%w: unterminated frontmatter in %s", errNotSkill, path)
	}
	var meta DocMeta
	if err := yaml.Unmarshal([]byte(strings.Join(bodyLines, "\n")), &meta); err != nil {
		return nil, fmt.Errorf("%w: bad frontmatter: %v", errNotSkill, err)
	}
	body := strings.Join(lines[endIdx+1:], "\n")
	body = strings.TrimSpace(body)
	if meta.Name == "" {
		meta.Name = strings.TrimSuffix(filepath.Base(filepath.Dir(path)), ".md")
	}
	if meta.Description == "" {
		return nil, fmt.Errorf("%w: %s has empty description", errNotSkill, path)
	}
	return &DocSkill{Meta: meta, Content: body, Raw: s, Dir: filepath.Dir(path)}, nil
}

// Loader 扫描技能目录，目录需以 SKILL.md 为入口（一层子目录）。
type Loader struct {
	dir string
}

// NewLoader 指定技能根目录（如 ./skills 或 /app/skills）。
func NewLoader(dir string) *Loader { return &Loader{dir: dir} }

// Dir 返回技能根目录。
func (l *Loader) Dir() string { return l.dir }

// Load 加载全部技能（按名称排序）。
func (l *Loader) Load() ([]*DocSkill, error) {
	entries, err := os.ReadDir(l.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // 目录不存在 = 无文档技能
		}
		return nil, err
	}
	var out []*DocSkill
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		md := filepath.Join(l.dir, e.Name(), "SKILL.md")
		if _, err := os.Stat(md); err != nil {
			continue
		}
		doc, err := parseSkillDoc(md)
		if err != nil {
			continue // 解析失败跳过该技能（避免拖垮启动）
		}
		doc.listFiles()
		out = append(out, doc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Meta.Name < out[j].Meta.Name })
	return out, nil
}

// listFiles 收集目录内附件（相对路径）。
func (d *DocSkill) listFiles() {
	_ = filepath.WalkDir(d.Dir, func(p string, de os.DirEntry, err error) error {
		if err != nil || de.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(d.Dir, p)
		if err != nil || rel == "SKILL.md" {
			return nil
		}
		d.Files = append(d.Files, filepath.ToSlash(rel))
		return nil
	})
}

// LoadOne 加载指定技能目录（<root>/<name>/SKILL.md）。
func (l *Loader) LoadOne(name string) (*DocSkill, error) {
	if name == "" || strings.ContainsAny(name, `/\`+"..") {
		return nil, fmt.Errorf("skill: illegal name %q", name)
	}
	md := filepath.Join(l.dir, name, "SKILL.md")
	doc, err := parseSkillDoc(md)
	if err != nil {
		return nil, err
	}
	doc.listFiles()
	return doc, nil
}

// Write 创建/覆盖技能（<root>/<name>/SKILL.md），要求 frontmatter name 与目录名一致。
func (l *Loader) Write(name, content string) (*DocSkill, error) {
	if name == "" || strings.ContainsAny(name, `/\`+"..") {
		return nil, fmt.Errorf("skill: illegal name %q", name)
	}
	dir := filepath.Join(l.dir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o644); err != nil {
		return nil, err
	}
	doc, err := parseSkillDoc(filepath.Join(dir, "SKILL.md"))
	if err != nil {
		return nil, err
	}
	if doc.Meta.Name != name {
		return nil, fmt.Errorf("skill: frontmatter name %q != folder name %q", doc.Meta.Name, name)
	}
	doc.listFiles()
	return doc, nil
}

// Delete 删除技能目录。
func (l *Loader) Delete(name string) error {
	if name == "" || strings.ContainsAny(name, `/\`+"..") {
		return fmt.Errorf("skill: illegal name %q", name)
	}
	return os.RemoveAll(filepath.Join(l.dir, name))
}

// Name / Description 供 Skill 接口与 UI 使用。
func (d *DocSkill) Name() string        { return d.Meta.Name }
func (d *DocSkill) Description() string { return d.Meta.Description }

// Modes 可用会话模式（空 = 全部）。
func (d *DocSkill) Modes() []string { return d.Meta.Modes }

// Parameters 供 function calling 注册。
func (d *DocSkill) Parameters() map[string]any { return d.ToolParameters() }

// Execute 文档型技能：把 SKILL.md 完整文档作为系统指令、用户请求作为输入，
// 调用模型按文档引导完成并返回结果（skill 行为完全由 SKILL.md 定义，无需 Go 业务代码）。
func (d *DocSkill) Execute(ctx context.Context, env *Env, args json.RawMessage) (*Result, error) {
	req := d.resolveArgs(args)
	sys := "你是教育版智能体的技能执行引擎。请严格按下面的技能文档逐步执行。\n\n" + d.Document()
	if req == "" {
		req = "请按技能说明执行。"
	}
	content, _, err := env.Model.Complete(ctx, model.ChatRequest{
		Messages: []model.Msg{
			{Role: model.RoleSystem, Content: sys},
			{Role: model.RoleUser, Content: req},
		},
		Model: env.ModelName,
	})
	if err != nil {
		return nil, fmt.Errorf("%s: %w", d.Meta.Name, err)
	}
	content = strings.TrimSpace(content)
	if content == "" {
		content = "（技能执行未返回内容，请重试）"
	}
	// 文档型技能约定：若需要澄清，首行输出 "ASK_QUESTION：问题"（或含选项行 ASK_OPTION：）
	// agent 据此转成 Ask 暂停等待学生回答，而不会臆测继续。
	if strings.HasPrefix(content, "ASK_QUESTION") {
		lines := strings.Split(content, "\n")
		q := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(lines[0], "ASK_QUESTION:"), "："))
		var opts []string
		for _, ln := range lines[1:] {
			ln = strings.TrimSpace(ln)
			if strings.HasPrefix(ln, "ASK_OPTION:") || strings.HasPrefix(ln, "ASK_OPTION：") {
				opts = append(opts, strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(ln, "ASK_OPTION:"), "：")))
			}
		}
		if q != "" {
			return &Result{Summary: "需要向你确认一个问题", Done: true, Ask: &Ask{Question: q, Options: opts}}, nil
		}
	}
	return &Result{
		Content: content,
		Summary: fmt.Sprintf("技能「%s」执行完成", d.Meta.Name),
		Done:    true,
	}, nil
}

// IsDocSkill 判断某 Skill 是否为文档型（命令路径需注入模型执行而非原文直出）。
func IsDocSkill(s Skill) bool {
	_, ok := s.(*DocSkill)
	return ok
}

// Commands 命令别名（CommandProvider 实现）。
func (d *DocSkill) Commands() []string {
	if len(d.Meta.Commands) > 0 {
		return d.Meta.Commands
	}
	return nil
}

// CommandArgs 文档技能把剩余文本整体作为任务描述。
func (d *DocSkill) CommandArgs(rawText string) map[string]any {
	return map[string]any{"request": strings.TrimSpace(rawText), "_doc": true}
}

// Document 返回完整文档（frontmatter 摘要 + 正文 + 附件清单）。
func (d *DocSkill) Document() string {
	var sb strings.Builder
	sb.WriteString("## 技能：")
	sb.WriteString(d.Meta.Name)
	sb.WriteString("\n")
	if d.Meta.Description != "" {
		sb.WriteString("说明：" + d.Meta.Description + "\n")
	}
	if len(d.Meta.Commands) > 0 {
		sb.WriteString("命令别名：" + strings.Join(d.Meta.Commands, ", ") + "\n")
	}
	if len(d.Files) > 0 {
		sb.WriteString("附带资源：" + strings.Join(d.Files, ", ") + "\n")
	}
	sb.WriteString("\n---- 执行指引（请严格遵循本说明逐步完成） ----\n\n")
	sb.WriteString(d.Content)
	return sb.String()
}

// resolveArgs 解析工具参数：request 或 {task} 均可。
func (d *DocSkill) resolveArgs(args json.RawMessage) string {
	var in struct {
		Request string `json:"request"`
		Task    string `json:"task"`
		Input   string `json:"input"`
	}
	if len(args) > 0 {
		_ = json.Unmarshal(args, &in)
	}
	switch {
	case in.Request != "":
		return in.Request
	case in.Task != "":
		return in.Task
	default:
		return in.Input
	}
}

// ToolParameters doc 技能的 function schema（自由文本输入）。
func (d *DocSkill) ToolParameters() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"request": map[string]any{"type": "string", "description": "用户请求/任务描述，自然语言即可"},
		},
		"required": []string{"request"},
	}
}
