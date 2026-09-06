// Postgres 版 Store：生产权威数据实现（pgx/v5 连接池）。
// 供 cmd/api 在配置了 DATABASE_URL 时使用；建表由 go:embed 迁移自动执行。
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// pgStore 基于 pgxpool 的 Store 实现。
type pgStore struct {
	pool *pgxpool.Pool
}

// NewPostgres 用 DSN 连接 Postgres（连接串形如
// postgres://user:pass@host:5432/dbname?sslmode=disable），返回即已建表。
func NewPostgres(ctx context.Context, dsn string) (Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("store: connect: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("store: ping: %w", err)
	}
	if err := migrations.Run(ctx, pool); err != nil {
		pool.Close()
		return nil, fmt.Errorf("store: migrate: %w", err)
	}
	return &pgStore{pool: pool}, nil
}

// Close 关闭连接池。
func (s *pgStore) Close() { s.pool.Close() }

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

// ---- users ----

func (s *pgStore) CreateUser(ctx context.Context, u *User) error {
	if u.ID == "" {
		u.ID = newID()
	}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO users (id, username, password_hash, display_name, role, created_at)
		 VALUES ($1,$2,$3,$4,$5, now()) RETURNING created_at`,
		u.ID, u.Username, u.PasswordHash, u.DisplayName, u.Role).
		Scan(&u.CreatedAt)
	if isUniqueViolation(err) {
		return ErrUsernameTaken
	}
	return err
}

func scanUser(row pgx.Row) (*User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.DisplayName, &u.Role, &u.CreatedAt)
	if isNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *pgStore) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	return scanUser(s.pool.QueryRow(ctx,
		`SELECT id, username, password_hash, display_name, role, created_at FROM users WHERE username=$1`, username))
}

func (s *pgStore) GetUserByID(ctx context.Context, id string) (*User, error) {
	return scanUser(s.pool.QueryRow(ctx,
		`SELECT id, username, password_hash, display_name, role, created_at FROM users WHERE id=$1`, id))
}

// ---- refresh tokens ----

func (s *pgStore) CreateRefreshToken(ctx context.Context, t *RefreshToken) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO refresh_tokens (hash, user_id, expires_at) VALUES ($1,$2,$3)`,
		t.Hash, t.UserID, t.ExpiresAt)
	return err
}

func (s *pgStore) GetRefreshToken(ctx context.Context, hash string) (*RefreshToken, error) {
	var t RefreshToken
	err := s.pool.QueryRow(ctx,
		`SELECT hash, user_id, expires_at FROM refresh_tokens WHERE hash=$1`, hash).
		Scan(&t.Hash, &t.UserID, &t.ExpiresAt)
	if isNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *pgStore) DeleteRefreshToken(ctx context.Context, hash string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM refresh_tokens WHERE hash=$1`, hash)
	return err
}

// ---- conversations ----

func (s *pgStore) CreateConversation(ctx context.Context, c *Conversation) error {
	if c.ID == "" {
		c.ID = newID()
	}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO conversations (id, user_id, title, mode, course_id, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5, now(), now())
		 RETURNING created_at, updated_at`,
		c.ID, c.UserID, c.Title, c.Mode, c.CourseID).
		Scan(&c.CreatedAt, &c.UpdatedAt)
	return err
}

func scanConv(row pgx.Row) (*Conversation, error) {
	var c Conversation
	err := row.Scan(&c.ID, &c.UserID, &c.Title, &c.Mode, &c.CourseID, &c.CreatedAt, &c.UpdatedAt)
	if isNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *pgStore) GetConversation(ctx context.Context, id, userID string) (*Conversation, error) {
	return scanConv(s.pool.QueryRow(ctx,
		`SELECT id, user_id, title, mode, course_id, created_at, updated_at
		 FROM conversations WHERE id=$1 AND user_id=$2`, id, userID))
}

func (s *pgStore) ListConversations(ctx context.Context, userID string) ([]*Conversation, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, user_id, title, mode, course_id, created_at, updated_at
		 FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Conversation
	for rows.Next() {
		var c Conversation
		if err := rows.Scan(&c.ID, &c.UserID, &c.Title, &c.Mode, &c.CourseID, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		cc := c
		out = append(out, &cc)
	}
	return out, rows.Err()
}

func (s *pgStore) UpdateConversation(ctx context.Context, c *Conversation) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE conversations SET title=$1, updated_at=now() WHERE id=$2 AND user_id=$3`,
		c.Title, c.ID, c.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *pgStore) DeleteConversation(ctx context.Context, id, userID string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM conversations WHERE id=$1 AND user_id=$2`, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *pgStore) TouchConversation(ctx context.Context, id, userID string, at time.Time) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE conversations SET updated_at=$1 WHERE id=$2 AND user_id=$3`, at, id, userID)
	return err
}

// ---- messages ----

func (s *pgStore) CreateMessage(ctx context.Context, m *Message) error {
	if m.ID == "" {
		m.ID = newID()
	}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO messages (id, conversation_id, role, content, model, usage_json, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING created_at`,
		m.ID, m.ConversationID, m.Role, m.Content, m.Model, m.UsageJSON).
		Scan(&m.CreatedAt)
	return err
}

func (s *pgStore) ListMessages(ctx context.Context, conversationID string) ([]*Message, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, conversation_id, role, content, model, usage_json, created_at
		 FROM messages WHERE conversation_id=$1 ORDER BY created_at, id`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.Model, &m.UsageJSON, &m.CreatedAt); err != nil {
			return nil, err
		}
		mm := m
		out = append(out, &mm)
	}
	return out, rows.Err()
}
