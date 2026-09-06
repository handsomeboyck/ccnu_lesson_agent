// Package skill 定义 Skill 接口、执行环境与注册表。
// Skill 是 Agent 的能力单元：模型通过 function calling 触发（M1），
// 每个 Skill 提供 name/description/JSON Schema，并在 Execute 中完成真实动作。
package skill

import (
	"context"
	"encoding/json"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// Env 是 Skill 执行时可用的环境（由 Agent 注入）。
type Env struct {
	UserID    string
	CourseID  string
	Mode      string
	Store     store.Store
	Model     model.Provider
	ModelName string
}

// Result 是 Skill 执行结果，回填给模型继续推理。
type Result struct {
	Content   string `json:"content"`             // 给模型的文本结果（markdown 等）
	Summary   string `json:"summary"`             // 给前端卡片的结果摘要
	Artifacts []any  `json:"artifacts,omitempty"` // 结构化产物（题目 JSON 等）
	Done      bool   `json:"done"`                // true=任务完成无需再让模型总结
}

// Skill 接口：所有内置 Skill 实现之。
type Skill interface {
	Name() string               // 如 "quiz_generator"
	Description() string        // 给 LLM 看：何时用、做什么
	Parameters() map[string]any // JSON Schema（OpenAI tools.function.parameters）
	Modes() []string            // 可用会话模式（空 = 全部模式）
	Execute(ctx context.Context, env *Env, args json.RawMessage) (*Result, error)
}

// Registry 持有全部注册的 Skill。
type Registry struct {
	byName map[string]Skill
}

func NewRegistry() *Registry {
	return &Registry{byName: map[string]Skill{}}
}

// Register 注册 Skill。
func (r *Registry) Register(s Skill) {
	r.byName[s.Name()] = s
}

// Get 按名称取 Skill。
func (r *Registry) Get(name string) (Skill, bool) {
	s, ok := r.byName[name]
	return s, ok
}

// All 返回全部 Skill（保持注册顺序）。
func (r *Registry) All() []Skill {
	out := make([]Skill, 0, len(r.byName))
	for _, s := range r.byName {
		out = append(out, s)
	}
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

// ToolsForMode 返回某模式可用 Skill 的 tool 定义（供 function calling）。
func (r *Registry) ToolsForMode(mode string) []model.Tool {
	var tools []model.Tool
	for _, s := range r.byName {
		if !enabledFor(s, mode) {
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
	return tools
}

// Execute 执行一次调用；未知 Skill 或参数非法时返回错误。
func (r *Registry) Execute(ctx context.Context, env *Env, name string, args json.RawMessage) (*Result, error) {
	s, ok := r.byName[name]
	if !ok {
		return nil, &UnknownSkillError{Name: name}
	}
	return s.Execute(ctx, env, args)
}

// UnknownSkillError 未知 Skill 错误。
type UnknownSkillError struct{ Name string }

func (e *UnknownSkillError) Error() string {
	return "skill: unknown skill " + e.Name
}
