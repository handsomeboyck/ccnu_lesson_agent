// Package skill 定义 Skill 接口、执行环境与注册表。
// Skill 是 Agent 的能力单元：模型通过 function calling 触发（M1），
// 每个 Skill 提供 name/description/JSON Schema，并在 Execute 中完成真实动作。
package skill

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/codex"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// Env 是 Skill 执行时可用的环境（由 Agent 注入）。
type Env struct {
	UserID         string
	ConversationID string
	CourseID       string
	Mode           string
	Store          store.Store
	Model          model.Provider
	ModelName      string
	// UploadDir：用户资料库原件暂存目录（execute_code 取文件用）
	UploadDir string
	// ArtifactDir：产物持久化目录（execute_code 落盘用；空 = 不落盘仅对话展示）
	ArtifactDir string
	// Codex：Python 沙箱客户端（nil = 未启用）
	Codex *codex.Client
}

// Ask 表示 Skill 需要向用户澄清（agent 应暂停并把问题呈现给学生，等待回答）。
type Ask struct {
	Question string   `json:"question"`
	Options  []string `json:"options,omitempty"` // 快捷选项（可选）
}

// ArtifactView 是 Skill 产物的前端展示（经 SSE tool_result 旁路透传，不进模型上下文）。
type ArtifactView struct {
	ID   string `json:"id,omitempty"` // 持久化产物 id（ArtifactDir 启用时）
	Name string `json:"name"`
	Mime string `json:"mime"`
	Data string `json:"data,omitempty"` // 图片=base64；文本=csv 原样；空=仅声明文件名
}

// Result 是 Skill 执行结果，回填给模型继续推理。
type Result struct {
	Content   string         `json:"content"`             // 给模型的文本结果（markdown 等）
	Summary   string         `json:"summary"`             // 给前端卡片的结果摘要
	Artifacts []ArtifactView `json:"artifacts,omitempty"` // 前端产物视图（不走模型上下文）
	Done      bool           `json:"done"`                // true=任务完成无需再让模型总结
	Ask       *Ask           `json:"ask,omitempty"`       // 非空 = 需向学生提问并等待
}

// Skill 接口：所有内置 Skill 实现之。
type Skill interface {
	Name() string               // 如 "quiz_generator"
	Description() string        // 给 LLM 看：何时用、做什么
	Parameters() map[string]any // JSON Schema（OpenAI tools.function.parameters）
	Modes() []string            // 可用会话模式（空 = 全部模式）
	Execute(ctx context.Context, env *Env, args json.RawMessage) (*Result, error)
}

// CommandProvider 可选接口：提供斜杠命令别名与自然语言参数启发式抽取。
// 实现了 Commands 的 Skill 可通过 "/命令 参数" 被用户直接唤起。
type CommandProvider interface {
	Commands() []string // 如 ["quiz","出题"]；首个作为前端展示主命令
	// CommandArgs 把命令后的自然语言参数转为 Execute 参数（尽力而为）。
	CommandArgs(rawText string) map[string]any
}

// AskFor 便捷构造提问结果。
func AskFor(question string, options ...string) *Result {
	return &Result{
		Summary: "需要向你确认一个问题",
		Done:    true,
		Ask:     &Ask{Question: question, Options: options},
	}
}

// Registry 持有全部注册的 Skill。
type Registry struct {
	byName   map[string]Skill
	aliases  map[string]Skill // 命令别名 → skill（含 name 本身）
	disabled map[string]bool  // 动态禁用的技能（如沙箱不可用时摘除 execute_code）
}

func NewRegistry() *Registry {
	return &Registry{byName: map[string]Skill{}, aliases: map[string]Skill{}, disabled: map[string]bool{}}
}

// Register 注册 Skill（含命令别名）。
func (r *Registry) Register(s Skill) {
	r.byName[s.Name()] = s
	r.aliases[strings.ToLower(s.Name())] = s
	if cp, ok := s.(CommandProvider); ok {
		for _, c := range cp.Commands() {
			r.aliases[strings.ToLower(c)] = s
		}
	}
}

// Get 按名称取 Skill。
func (r *Registry) Get(name string) (Skill, bool) {
	s, ok := r.byName[name]
	return s, ok
}

// SetDisabled 动态启用/禁用某 Skill（如沙箱不可用时摘除 execute_code）。
// 仅影响对外暴露（工具/命令/列表），注册信息保留，恢复时无需重建。
func (r *Registry) SetDisabled(name string, disabled bool) {
	if disabled {
		r.disabled[name] = true
	} else {
		delete(r.disabled, name)
	}
}

// IsDisabled 查询某 Skill 是否被禁用。
func (r *Registry) IsDisabled(name string) bool { return r.disabled[name] }

// Remove 按名称移除 Skill（含命令别名），供运行时技能管理使用。
func (r *Registry) Remove(name string) {
	s, ok := r.byName[name]
	if !ok {
		return
	}
	delete(r.byName, name)
	if cp, ok := s.(CommandProvider); ok {
		for _, c := range append(cp.Commands(), s.Name()) {
			delete(r.aliases, strings.ToLower(c))
		}
	}
	delete(r.aliases, strings.ToLower(name))
}

// LookupCommand 按命令别名（不含 "/"）查找 Skill（禁用技能不可命中）。
func (r *Registry) LookupCommand(cmd string) (Skill, bool) {
	s, ok := r.aliases[strings.ToLower(strings.TrimSpace(cmd))]
	if !ok || r.disabled[s.Name()] {
		return nil, false
	}
	return s, ok
}

// All 返回全部未禁用 Skill。
func (r *Registry) All() []Skill {
	out := make([]Skill, 0, len(r.byName))
	for _, s := range r.byName {
		if r.disabled[s.Name()] {
			continue
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name() < out[j].Name() })
	return out
}

// CommandInfo 描述一个命令入口（供前端 / 菜单）。
type CommandInfo struct {
	Skill       string         `json:"skill"`   // skill 名（发给模型用）
	Command     string         `json:"command"` // 主命令（不含 /）
	Aliases     []string       `json:"aliases"` // 全部别名（含主命令）
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

// Commands 返回实现了 CommandProvider 的 Skill 的命令清单（禁用技能不列出）。
func (r *Registry) Commands() []CommandInfo {
	var out []CommandInfo
	for _, s := range r.byName {
		if r.disabled[s.Name()] {
			continue
		}
		cp, ok := s.(CommandProvider)
		if !ok {
			continue
		}
		cmds := cp.Commands()
		if len(cmds) == 0 {
			continue
		}
		out = append(out, CommandInfo{
			Skill:       s.Name(),
			Command:     cmds[0],
			Aliases:     cmds,
			Description: s.Description(),
			Parameters:  s.Parameters(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Command < out[j].Command })
	return out
}

// enabledFor 判断 Skill 是否可用于某模式。
func enabledFor(s Skill, mode string) bool {
	modes := s.Modes()
	if len(modes) == 0 {
		return true
	}
	for _, m := range modes {
		if m == mode {
			return true
		}
	}
	return false
}

// ToolsForMode 返回某模式可用 Skill 的 tool 定义（供 function calling；禁用技能不暴露）。
// 注意：必须按 Name 排序输出——Go map 迭代顺序随机，若顺序不定则 tools JSON 每次不同，
// 直接导致 DeepSeek 前缀缓存命中率崩塌（实测路由轮仅 24%）。
func (r *Registry) ToolsForMode(mode string) []model.Tool {
	var tools []model.Tool
	for _, s := range r.byName {
		if r.disabled[s.Name()] || !enabledFor(s, mode) {
			continue
		}
		tools = append(tools, model.Tool{
			Type: "function",
			Function: model.ToolFunction{
				Name:        s.Name(),
				Description: s.Description(),
				Parameters:  s.Parameters(),
			},
		})
	}
	sort.Slice(tools, func(i, j int) bool { return tools[i].Function.Name < tools[j].Function.Name })
	return tools
}

// Execute 执行一次调用；未知 Skill、禁用中 或参数非法时返回错误。
func (r *Registry) Execute(ctx context.Context, env *Env, name string, args json.RawMessage) (*Result, error) {
	s, ok := r.byName[name]
	if !ok {
		return nil, &UnknownSkillError{Name: name}
	}
	if r.disabled[name] {
		return nil, fmt.Errorf("skill: %s 当前不可用（依赖的服务暂不可用）", name)
	}
	return s.Execute(ctx, env, args)
}

// UnknownSkillError 未知 Skill 错误。
type UnknownSkillError struct{ Name string }

func (e *UnknownSkillError) Error() string {
	return "skill: unknown skill " + e.Name
}
