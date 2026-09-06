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

type Message struct {
	ID             string
	ConversationID string
	Role           string // user | assistant | tool（M1 起）
	Content        string
	Model          string
	UsageJSON      string // 预留：token 用量序列化
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

	// messages
	CreateMessage(ctx context.Context, m *Message) error
	ListMessages(ctx context.Context, conversationID string) ([]*Message, error)

	// documents / chunks（文件知识库）
	CreateDocument(ctx context.Context, d *Document) error
	GetDocument(ctx context.Context, id, userID string) (*Document, error)
	ListDocuments(ctx context.Context, userID string) ([]*Document, error)
	UpdateDocumentStatus(ctx context.Context, id, userID, status, errMsg string) error
	DeleteDocument(ctx context.Context, id, userID string) error
	// ReplaceChunks 全量写入/覆盖某文档的检索块（解析完成时调用）。
	ReplaceChunks(ctx context.Context, docID string, chunks []Chunk) error
	// SearchChunks 关键词检索用户资料库（ILIKE 简单实现，预留 embedding 升级点）。
	SearchChunks(ctx context.Context, userID, query string, topK int) ([]ChunkHit, error)
}
