// Package store 定义数据访问抽象与领域模型。
// M0 提供内存实现（本地无 DB 可跑通演示）；阿里云部署接入 PostgreSQL 时
// 实现同一 Store 接口并切换（见 migrations/ 下的建表 SQL）。
package store

import (
	"context"
	"time"
)

// 角色常量
const (
	RoleStudent = "student"
	RoleTeacher = "teacher"
	RoleAdmin   = "admin"
)

// 会话模式常量（对应 Agent.md 的教育模式）
const (
	ModeCompanion = "companion" // 学伴（智能答疑）
	ModePractice  = "practice"  // 练习与测评
	ModeTeacher   = "teacher"   // 教师辅助
)

type User struct {
	ID           string
	Username     string
	DisplayName  string
	Role         string
	PasswordHash string
	CreatedAt    time.Time
}

type RefreshToken struct {
	Hash      string
	UserID    string
	ExpiresAt time.Time
}

type Conversation struct {
	ID        string
	UserID    string
	Title     string
	Mode      string
	CourseID  string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ConvAudit 会话 + 所有者信息（admin 审计视图）。
type ConvAudit struct {
	Conversation
	Username    string
	DisplayName string
}

type Message struct {
	ID             string
	ConversationID string
	Role           string // user | assistant | tool（M1 起）
	Content        string
	Model          string
	UsageJSON      string // token 用量序列化
	ArtifactsJSON  string // 该消息关联的产物摘要（[{id,name,mime}]），供历史回看
	CreatedAt      time.Time
}

// Document 是用户资料库中的一份上传文件（解析后文本按块存 document_chunks）。
type Document struct {
	ID        string
	UserID    string
	Filename  string
	Ext       string
	SizeBytes int64
	Status    string // parsing | ready | failed
	Error     string
	CreatedAt time.Time
}

// Chunk 是文档解析后的一个检索块。
type Chunk struct {
	ID         string
	DocumentID string
	Seq        int
	Content    string
}

// ChunkHit 检索命中（含来源文档信息）。
type ChunkHit struct {
	Chunk
	Filename string
}

// Artifact 是技能（如 execute_code 沙箱）产生的持久化产物（图片/csv/文本）。
type Artifact struct {
	ID             string
	UserID         string
	ConversationID string
	MessageID      string
	Skill          string
	Filename       string
	Mime           string
	SizeBytes      int64
	StorageKey     string // ARTIFACT_DIR 下的相对文件名
	CreatedAt      time.Time
}

// MetricEvent 是一条运行指标（对话/工具/沙箱）。
type MetricEvent struct {
	ID               int64
	Kind             string // chat | tool | codex
	Mode             string // companion/practice/teacher
	Status           string // ok | error | ask | ...
	Skill            string // kind=tool/codex 时使用
	PromptTokens     int64
	CompletionTokens int64
	DurationMs       int64
	At               time.Time
}

// HourBucket 是按小时聚合的一桶指标。
type HourBucket struct {
	Hour        time.Time
	Chats       int64
	ChatOK      int64
	ChatErr     int64
	PromptTok   int64
	Completion  int64
	DurationSum int64
	ToolCalls   int64
	CodexRuns   int64
	CodexOK     int64
	Asks        int64
}

// MetricSummary 返回最近 windowHours 小时的逐小时聚合。
type MetricSummary struct {
	WindowHours int
	Buckets     []HourBucket
}

// MetricDistribution 统计最近 windowHours 内按模式/技能分组的计数。
type MetricDistribution struct {
	ByMode  map[string]int64 `json:"by_mode"`
	BySkill map[string]int64 `json:"by_skill"`
}

// 可选能力：数据库/宿主系统状态（仅 Postgres store 实现）。
type SystemStats struct {
	PGVersion     string  `json:"pg_version"`
	DBName        string  `json:"db_name"`
	Connections   int     `json:"connections"`
	MaxConnections int    `json:"max_connections"`
	DBBytes       int64   `json:"db_bytes"`
	CacheHitRatio float64 `json:"cache_hit_ratio"`
	CommitCount   int64   `json:"xact_commit"`
	RollbackCount int64   `json:"xact_rollback"`
	UptimeSec     int64   `json:"uptime_sec"`
}

type SystemStatsProvider interface {
	SystemStats(ctx context.Context) (*SystemStats, error)
	PingDB(ctx context.Context) error
}

// Store 是统一的数据访问接口。
type Store interface {
	// users
	CreateUser(ctx context.Context, u *User) error
	GetUserByUsername(ctx context.Context, username string) (*User, error)
	GetUserByID(ctx context.Context, id string) (*User, error)

	// refresh tokens
	CreateRefreshToken(ctx context.Context, t *RefreshToken) error
	GetRefreshToken(ctx context.Context, hash string) (*RefreshToken, error)
	DeleteRefreshToken(ctx context.Context, hash string) error

	// conversations
	CreateConversation(ctx context.Context, c *Conversation) error
	GetConversation(ctx context.Context, id, userID string) (*Conversation, error)
	ListConversations(ctx context.Context, userID string) ([]*Conversation, error)
	UpdateConversation(ctx context.Context, c *Conversation) error
	DeleteConversation(ctx context.Context, id, userID string) error
	TouchConversation(ctx context.Context, id, userID string, at time.Time) error
	// ListAllConversations 全站会话（admin 审计用；Conversation.UserID 为所有者 id，Username/Display 带所有者信息）
	ListAllConversations(ctx context.Context, limit int) ([]*ConvAudit, error)
	// GetConversationAdmin 按 id 无归属校验取会话（admin 审计）。
	GetConversationAdmin(ctx context.Context, id string) (*ConvAudit, error)
	// ListConversationAttachments 会话关联的文档（多轮附件记忆；按 added_at 升序）
	ListConversationAttachments(ctx context.Context, convID string) ([]*Document, error)
	// LinkConversationDocuments 将会话与会话刚用到的文档建立关联（幂等）。
	LinkConversationDocuments(ctx context.Context, convID string, docIDs []string) error

	// messages
	CreateMessage(ctx context.Context, m *Message) error
	ListMessages(ctx context.Context, conversationID string) ([]*Message, error)

	// documents / chunks（文件知识库）
	CreateDocument(ctx context.Context, d *Document) error
	GetDocument(ctx context.Context, id, userID string) (*Document, error)
	GetDocumentsByIDs(ctx context.Context, userID string, ids []string) ([]*Document, error)
	ListDocuments(ctx context.Context, userID string) ([]*Document, error)
	UpdateDocumentStatus(ctx context.Context, id, userID, status, errMsg string) error
	DeleteDocument(ctx context.Context, id, userID string) error
	// ReplaceChunks 全量写入/覆盖某文档的检索块（解析完成时调用）。
	ReplaceChunks(ctx context.Context, docID string, chunks []Chunk) error
	// SearchChunks 关键词检索用户资料库（ILIKE 简单实现，预留 embedding 升级点）。
	SearchChunks(ctx context.Context, userID, query string, topK int) ([]ChunkHit, error)
	// GetDocumentChunks 取某文档的全部文本块（按 seq；用于附件全量注入）。
	GetDocumentChunks(ctx context.Context, docID string) ([]Chunk, error)

	// artifacts（产物库）
	CreateArtifact(ctx context.Context, a *Artifact) error
	GetArtifact(ctx context.Context, id, userID string) (*Artifact, error)
	ListArtifacts(ctx context.Context, userID string, limit int) ([]*Artifact, error)
	UpdateArtifactStorageKey(ctx context.Context, id, userID, storageKey string) error
	DeleteArtifact(ctx context.Context, id, userID string) error

	// metrics（运行监控）
	AppendMetric(ctx context.Context, ev *MetricEvent) error
	MetricSummary(ctx context.Context, hours int) (*MetricSummary, error)
	MetricDistribution(ctx context.Context, hours int) (*MetricDistribution, error)
	RecentLatencies(ctx context.Context, hours int, limit int) ([]int64, error)
}
