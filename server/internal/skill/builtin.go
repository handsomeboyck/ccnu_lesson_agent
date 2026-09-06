package skill

// RegisterDefaults 注册平台原语 Skill（Go 实现，交互/检索能力）。
// 业务型技能（出题/讲解等）由 SKILL.md 文档驱动，经 Loader 从 skills 目录加载后
// 由 main 逐一 reg.Register(docSkill) 注册（见 cmd/api/main.go）。
func RegisterDefaults(reg *Registry) {
	reg.Register(NewKnowledgeRetrieve()) // 检索平台原语
	reg.Register(NewAskUser())           // 提问平台原语
}
