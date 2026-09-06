package gateway

import (
	"net/http"
	"strings"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/skill"
)

type skillService struct {
	loader   *skill.Loader
	registry *skill.Registry
}

// skillView 列表项视图。
type skillView struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Commands    []string `json:"commands,omitempty"`
	Modes       []string `json:"modes,omitempty"`
	Doc         bool     `json:"doc"`       // 是否文档型（可管理）
	Primitive   bool     `json:"primitive"` // 是否平台原语（不可删改）
}

// list GET /v1/skills：全部技能（原语 + 文档）与命令清单。
func (s *skillService) list(w http.ResponseWriter, r *http.Request) {
	all := s.registry.All()
	items := make([]skillView, 0, len(all))
	for _, sk := range all {
		v := skillView{Name: sk.Name(), Description: sk.Description(), Modes: sk.Modes()}
		if cp, ok := sk.(skill.CommandProvider); ok {
			v.Commands = cp.Commands()
		}
		if _, ok := sk.(*skill.DocSkill); ok {
			v.Doc = true
		} else {
			v.Primitive = true
		}
		items = append(items, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"skills":   items,
		"commands": s.registry.Commands(),
	})
}

// docDetail GET /v1/skills/{name}：文档型技能详情（含 SKILL.md 全文）。
func (s *skillService) docDetail(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	sk, ok := s.registry.Get(name)
	if !ok {
		writeError(w, http.StatusNotFound, "skill not found")
		return
	}
	doc, isDoc := sk.(*skill.DocSkill)
	if !isDoc {
		writeError(w, http.StatusBadRequest, "skill is a platform primitive, not editable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":        doc.Meta.Name,
		"description": doc.Meta.Description,
		"commands":    doc.Meta.Commands,
		"modes":       doc.Meta.Modes,
		"files":       doc.Files,
		"content":     doc.Raw,
	})
}

// save PUT /v1/skills/{name}：新建或覆盖文档型技能（body: {content: 完整 SKILL.md}）。
func (s *skillService) save(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" {
		writeError(w, http.StatusBadRequest, "skill name required")
		return
	}
	if isPrimitiveName(name) {
		writeError(w, http.StatusBadRequest, "cannot modify platform primitive")
		return
	}
	var in struct {
		Content string `json:"content"`
	}
	if err := decodeJSON(r, &in); err != nil || strings.TrimSpace(in.Content) == "" {
		writeError(w, http.StatusBadRequest, "content (SKILL.md) required")
		return
	}
	doc, err := s.loader.Write(name, in.Content)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// 运行时热注册（先移除旧的避免命令别名残留）
	if _, existed := s.registry.Get(name); existed {
		s.registry.Remove(name)
	}
	s.registry.Register(doc)
	writeJSON(w, http.StatusOK, map[string]any{"name": doc.Name(), "status": "saved"})
}

// remove DELETE /v1/skills/{name}：删除文档型技能。
func (s *skillService) remove(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if isPrimitiveName(name) {
		writeError(w, http.StatusBadRequest, "cannot delete platform primitive")
		return
	}
	sk, ok := s.registry.Get(name)
	if !ok {
		writeError(w, http.StatusNotFound, "skill not found")
		return
	}
	if _, isDoc := sk.(*skill.DocSkill); !isDoc {
		writeError(w, http.StatusBadRequest, "cannot delete platform primitive")
		return
	}
	if err := s.loader.Delete(name); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	s.registry.Remove(name)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func isPrimitiveName(name string) bool {
	switch name {
	case "ask_user", "knowledge_retrieve":
		return true
	}
	return false
}
