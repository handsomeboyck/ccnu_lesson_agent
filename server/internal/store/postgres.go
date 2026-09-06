// Postgres 版 Store：生产权威数据实现（pgx/v5 连接池）。
// 供 cmd/api 在配置了 DATABASE_URL 时使用；建表由 go:embed 迁移自动执行。
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
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

func (s *pgStore) ListAllConversations(ctx context.Context, limit int) ([]*ConvAudit, error) {
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	rows, err := s.pool.Query(ctx,
		`SELECT c.id, c.user_id, c.title, c.mode, c.course_id, c.created_at, c.updated_at,
		        u.username, coalesce(u.display_name,'')
		 FROM conversations c LEFT JOIN users u ON u.id = c.user_id
		 ORDER BY c.updated_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ConvAudit
	for rows.Next() {
		var ca ConvAudit
		if err := rows.Scan(&ca.ID, &ca.UserID, &ca.Title, &ca.Mode, &ca.CourseID, &ca.CreatedAt,
			&ca.UpdatedAt, &ca.Username, &ca.DisplayName); err != nil {
			return nil, err
		}
		cc := ca
		out = append(out, &cc)
	}
	return out, rows.Err()
}

func (s *pgStore) GetConversationAdmin(ctx context.Context, id string) (*ConvAudit, error) {
	var ca ConvAudit
	err := s.pool.QueryRow(ctx,
		`SELECT c.id, c.user_id, c.title, c.mode, c.course_id, c.created_at, c.updated_at,
		        u.username, coalesce(u.display_name,'')
		 FROM conversations c LEFT JOIN users u ON u.id = c.user_id
		 WHERE c.id=$1`, id).
		Scan(&ca.ID, &ca.UserID, &ca.Title, &ca.Mode, &ca.CourseID, &ca.CreatedAt,
			&ca.UpdatedAt, &ca.Username, &ca.DisplayName)
	if isNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &ca, nil
}

// ---- messages ----

func (s *pgStore) CreateMessage(ctx context.Context, m *Message) error {
	if m.ID == "" {
		m.ID = newID()
	}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO messages (id, conversation_id, role, content, model, usage_json, artifacts_json, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING created_at`,
		m.ID, m.ConversationID, m.Role, m.Content, m.Model, m.UsageJSON, m.ArtifactsJSON).
		Scan(&m.CreatedAt)
	return err
}

func (s *pgStore) ListMessages(ctx context.Context, conversationID string) ([]*Message, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, conversation_id, role, content, model, usage_json, artifacts_json, created_at
		 FROM messages WHERE conversation_id=$1 ORDER BY created_at, id`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.Model, &m.UsageJSON, &m.ArtifactsJSON, &m.CreatedAt); err != nil {
			return nil, err
		}
		mm := m
		out = append(out, &mm)
	}
	return out, rows.Err()
}

// ---- documents / chunks ----

func (s *pgStore) CreateDocument(ctx context.Context, d *Document) error {
	if d.ID == "" {
		d.ID = newID()
	}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO documents (id, user_id, filename, ext, size_bytes, status, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING created_at`,
		d.ID, d.UserID, d.Filename, d.Ext, d.SizeBytes, d.Status).Scan(&d.CreatedAt)
	return err
}

func scanDoc(row pgx.Row) (*Document, error) {
	var d Document
	err := row.Scan(&d.ID, &d.UserID, &d.Filename, &d.Ext, &d.SizeBytes, &d.Status, &d.Error, &d.CreatedAt)
	if isNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (s *pgStore) GetDocument(ctx context.Context, id, userID string) (*Document, error) {
	return scanDoc(s.pool.QueryRow(ctx,
		`SELECT id, user_id, filename, ext, size_bytes, status, error, created_at
		 FROM documents WHERE id=$1 AND user_id=$2`, id, userID))
}

func (s *pgStore) ListDocuments(ctx context.Context, userID string) ([]*Document, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, user_id, filename, ext, size_bytes, status, error, created_at
		 FROM documents WHERE user_id=$1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Document
	for rows.Next() {
		var d Document
		if err := rows.Scan(&d.ID, &d.UserID, &d.Filename, &d.Ext, &d.SizeBytes, &d.Status, &d.Error, &d.CreatedAt); err != nil {
			return nil, err
		}
		dd := d
		out = append(out, &dd)
	}
	return out, rows.Err()
}

func (s *pgStore) UpdateDocumentStatus(ctx context.Context, id, userID, status, errMsg string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE documents SET status=$1, error=$2 WHERE id=$3 AND user_id=$4`,
		status, errMsg, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *pgStore) DeleteDocument(ctx context.Context, id, userID string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM documents WHERE id=$1 AND user_id=$2`, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *pgStore) GetDocumentsByIDs(ctx context.Context, userID string, ids []string) ([]*Document, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	args := make([]any, 0, len(ids)+1)
	args = append(args, userID)
	ph := make([]string, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
		ph = append(ph, fmt.Sprintf("$%d", len(args)))
	}
	rows, err := s.pool.Query(ctx,
		fmt.Sprintf(`SELECT id, user_id, filename, ext, size_bytes, status, error, created_at
		 FROM documents WHERE user_id=$1 AND id IN (%s)`, strings.Join(ph, ",")), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Document
	for rows.Next() {
		var d Document
		if err := rows.Scan(&d.ID, &d.UserID, &d.Filename, &d.Ext, &d.SizeBytes, &d.Status, &d.Error, &d.CreatedAt); err != nil {
			return nil, err
		}
		dd := d
		out = append(out, &dd)
	}
	return out, rows.Err()
}

func (s *pgStore) GetDocumentChunks(ctx context.Context, docID string) ([]Chunk, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, document_id, seq, content FROM document_chunks
		 WHERE document_id=$1 ORDER BY seq`, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Chunk
	for rows.Next() {
		var c Chunk
		if err := rows.Scan(&c.ID, &c.DocumentID, &c.Seq, &c.Content); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ---- conversation attachments（多轮附件记忆）----

func (s *pgStore) ListConversationAttachments(ctx context.Context, convID string) ([]*Document, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT d.id, d.user_id, d.filename, d.ext, d.size_bytes, d.status, d.error, d.created_at
		 FROM conversation_attachments ca
		 JOIN documents d ON d.id = ca.doc_id
		 WHERE ca.conv_id=$1 ORDER BY ca.added_at`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Document
	for rows.Next() {
		var d Document
		if err := rows.Scan(&d.ID, &d.UserID, &d.Filename, &d.Ext, &d.SizeBytes, &d.Status, &d.Error, &d.CreatedAt); err != nil {
			return nil, err
		}
		dd := d
		out = append(out, &dd)
	}
	return out, rows.Err()
}

func (s *pgStore) LinkConversationDocuments(ctx context.Context, convID string, docIDs []string) error {
	if len(docIDs) == 0 {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, id := range docIDs {
		if _, err := tx.Exec(ctx,
			`INSERT INTO conversation_attachments (conv_id, doc_id) VALUES ($1,$2)
			 ON CONFLICT DO NOTHING`, convID, id); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *pgStore) ReplaceChunks(ctx context.Context, docID string, chunks []Chunk) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM document_chunks WHERE document_id=$1`, docID); err != nil {
		return err
	}
	for i := range chunks {
		if chunks[i].ID == "" {
			chunks[i].ID = newID()
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO document_chunks (id, document_id, seq, content)
			 VALUES ($1,$2,$3,$4) ON CONFLICT (document_id, seq) DO UPDATE SET content=EXCLUDED.content`,
			chunks[i].ID, docID, chunks[i].Seq, chunks[i].Content); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// SearchChunks 关键词检索：任一查询词命中即返回，按文档名+序号排序，预留 embedding 升级点。
func (s *pgStore) SearchChunks(ctx context.Context, userID, query string, topK int) ([]ChunkHit, error) {
	terms := splitQueryTerms(query)
	if len(terms) == 0 || topK <= 0 {
		return nil, nil
	}
	conds := make([]string, 0, len(terms))
	args := []any{userID}
	for _, t := range terms {
		args = append(args, "%"+t+"%")
		conds = append(conds, fmt.Sprintf("content ILIKE $%d", len(args)))
	}
	sql := fmt.Sprintf(`SELECT c.id, c.document_id, c.seq, c.content, d.filename
		FROM document_chunks c JOIN documents d ON d.id = c.document_id
		WHERE d.user_id = $1 AND (%s)
		ORDER BY d.filename, c.seq LIMIT %d`, strings.Join(conds, " OR "), topK)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChunkHit
	for rows.Next() {
		var h ChunkHit
		if err := rows.Scan(&h.ID, &h.DocumentID, &h.Seq, &h.Content, &h.Filename); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// splitQueryTerms 拆出检索词：空白分词 + 中文 2-gram（便于 ILIKE 命中短语）。
func splitQueryTerms(q string) []string {
	var terms []string
	seen := map[string]bool{}
	add := func(t string) {
		t = strings.TrimSpace(t)
		if t == "" || len([]rune(t)) < 2 {
			return
		}
		if !seen[t] {
			seen[t] = true
			terms = append(terms, t)
		}
	}
	for _, f := range strings.Fields(q) {
		add(f)
	}
	runes := []rune(q)
	for i := 0; i+2 <= len(runes); i++ {
		if isCJK(runes[i]) && isCJK(runes[i+1]) {
			add(string(runes[i : i+2]))
		}
	}
	return terms
}

func isCJK(r rune) bool {
	return (r >= 0x4E00 && r <= 0x9FFF) || (r >= 0x3400 && r <= 0x4DBF)
}

// ---- artifacts ----

func (s *pgStore) CreateArtifact(ctx context.Context, a *Artifact) error {
	if a.ID == "" {
		a.ID = newID()
	}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO artifacts (id, user_id, conversation_id, message_id, skill, filename, mime, size_bytes, storage_key, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now()) RETURNING created_at`,
		a.ID, a.UserID, a.ConversationID, a.MessageID, a.Skill, a.Filename, a.Mime, a.SizeBytes, a.StorageKey).
		Scan(&a.CreatedAt)
	return err
}

func scanArtifact(row pgx.Row) (*Artifact, error) {
	var a Artifact
	err := row.Scan(&a.ID, &a.UserID, &a.ConversationID, &a.MessageID, &a.Skill,
		&a.Filename, &a.Mime, &a.SizeBytes, &a.StorageKey, &a.CreatedAt)
	if isNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *pgStore) GetArtifact(ctx context.Context, id, userID string) (*Artifact, error) {
	return scanArtifact(s.pool.QueryRow(ctx,
		`SELECT id, user_id, conversation_id, message_id, skill, filename, mime, size_bytes, storage_key, created_at
		 FROM artifacts WHERE id=$1 AND user_id=$2`, id, userID))
}

func (s *pgStore) ListArtifacts(ctx context.Context, userID string, limit int) ([]*Artifact, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id, user_id, conversation_id, message_id, skill, filename, mime, size_bytes, storage_key, created_at
		 FROM artifacts WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Artifact
	for rows.Next() {
		var a Artifact
		if err := rows.Scan(&a.ID, &a.UserID, &a.ConversationID, &a.MessageID, &a.Skill,
			&a.Filename, &a.Mime, &a.SizeBytes, &a.StorageKey, &a.CreatedAt); err != nil {
			return nil, err
		}
		aa := a
		out = append(out, &aa)
	}
	return out, rows.Err()
}

func (s *pgStore) DeleteArtifact(ctx context.Context, id, userID string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM artifacts WHERE id=$1 AND user_id=$2`, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *pgStore) UpdateArtifactStorageKey(ctx context.Context, id, userID, storageKey string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE artifacts SET storage_key=$1 WHERE id=$2 AND user_id=$3`, storageKey, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- metrics（运行监控）----

func (s *pgStore) AppendMetric(ctx context.Context, ev *MetricEvent) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO metric_events (kind, mode, status, skill, prompt_tokens, completion_tokens, duration_ms, ts)
		 VALUES ($1,$2,$3,$4,$5,$6,$7, $8)`,
		ev.Kind, ev.Mode, ev.Status, ev.Skill, ev.PromptTokens, ev.CompletionTokens, ev.DurationMs, ev.At)
	return err
}

// MetricSummary 把最近 N 小时的事件按小时聚合（不足的桶填零）。
func (s *pgStore) MetricSummary(ctx context.Context, hours int) (*MetricSummary, error) {
	if hours <= 0 || hours > 168 {
		hours = 24
	}
	// 逐小时桶：小时起点 -> 聚合行
	type acc struct{ b HourBucket }
	accs := map[int64]*acc{}
	cutoff := time.Now().Add(-time.Duration(hours+1) * time.Hour).Truncate(time.Hour)
	rows, err := s.pool.Query(ctx, `
		SELECT date_trunc('hour', ts) AS h,
		       count(*) FILTER (WHERE kind='chat')::bigint,
		       count(*) FILTER (WHERE kind='chat' AND status='ok')::bigint,
		       count(*) FILTER (WHERE kind='chat' AND status='error')::bigint,
		       coalesce(sum(prompt_tokens) FILTER (WHERE kind='chat'),0)::bigint,
		       coalesce(sum(completion_tokens) FILTER (WHERE kind='chat'),0)::bigint,
		       coalesce(sum(duration_ms) FILTER (WHERE kind='chat'),0)::bigint,
		       count(*) FILTER (WHERE kind='tool')::bigint,
		       count(*) FILTER (WHERE kind='codex')::bigint,
		       count(*) FILTER (WHERE kind='codex' AND status='ok')::bigint,
		       count(*) FILTER (WHERE kind='chat' AND status='ask')::bigint
		FROM metric_events WHERE ts >= $1 GROUP BY h`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var h time.Time
		var b HourBucket
		if err := rows.Scan(&h, &b.Chats, &b.ChatOK, &b.ChatErr, &b.PromptTok,
			&b.Completion, &b.DurationSum, &b.ToolCalls, &b.CodexRuns, &b.CodexOK, &b.Asks); err != nil {
			return nil, err
		}
		accs[h.Unix()] = &acc{b: b}
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}
	// 对齐输出（从旧到新，含 0 桶）
	sum := &MetricSummary{WindowHours: hours}
	nowH := time.Now().Truncate(time.Hour)
	for i := hours - 1; i >= 0; i-- {
		h := nowH.Add(-time.Duration(i) * time.Hour)
		if a, ok := accs[h.Unix()]; ok {
			sum.Buckets = append(sum.Buckets, a.b)
		} else {
			sum.Buckets = append(sum.Buckets, HourBucket{Hour: h})
		}
	}
	return sum, nil
}

// MetricDistribution 按模式/技能分组统计最近 N 小时事件数。
func (s *pgStore) MetricDistribution(ctx context.Context, hours int) (*MetricDistribution, error) {
	if hours <= 0 || hours > 168 {
		hours = 24
	}
	cut := time.Now().Add(-time.Duration(hours) * time.Hour)
	out := &MetricDistribution{ByMode: map[string]int64{}, BySkill: map[string]int64{}}

	// 模式分布（chat 事件）
	rows, err := s.pool.Query(ctx,
		`SELECT coalesce(nullif(mode,''),'none') AS m, count(*) FROM metric_events
		 WHERE kind='chat' AND ts >= $1 GROUP BY m`, cut)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var m string
		var n int64
		if err := rows.Scan(&m, &n); err != nil {
			rows.Close()
			return nil, err
		}
		out.ByMode[m] = n
	}
	rows.Close()
	if rows.Err() != nil {
		return nil, rows.Err()
	}

	// 技能分布（tool + codex 事件，取 skill 列）
	rows, err = s.pool.Query(ctx,
		`SELECT coalesce(nullif(skill,''),'none') AS s, count(*) FROM metric_events
		 WHERE kind IN ('tool','codex') AND ts >= $1 GROUP BY s`, cut)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var sk string
		var n int64
		if err := rows.Scan(&sk, &n); err != nil {
			return nil, err
		}
		out.BySkill[sk] = n
	}
	return out, rows.Err()
}

// RecentLatencies 取最近 chat 事件的耗时（毫秒），供延迟分位数计算。
func (s *pgStore) RecentLatencies(ctx context.Context, hours int, limit int) ([]int64, error) {
	if hours <= 0 || hours > 168 {
		hours = 24
	}
	if limit <= 0 || limit > 5000 {
		limit = 500
	}
	cut := time.Now().Add(-time.Duration(hours) * time.Hour)
	rows, err := s.pool.Query(ctx,
		`SELECT duration_ms FROM metric_events WHERE kind='chat' AND ts >= $1
		 ORDER BY ts DESC LIMIT $2`, cut, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var d int64
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// SystemStats 读取当前库基础状态（pg_stat_database + 库大小）。
func (s *pgStore) SystemStats(ctx context.Context) (*SystemStats, error) {
	var st SystemStats
	err := s.pool.QueryRow(ctx, `
		SELECT current_database(),
		       (SELECT version()),
		       (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
		       (SELECT setting::int FROM pg_settings WHERE name='max_connections'),
		       coalesce((SELECT pg_database_size(current_database())),0),
		       (SELECT coalesce(sum(blks_hit)*1.0 / nullif(sum(blks_hit)+sum(blks_read),0), 1) FROM pg_stat_database WHERE datname=current_database()),
		       (SELECT coalesce(sum(xact_commit),0) FROM pg_stat_database WHERE datname=current_database()),
		       (SELECT coalesce(sum(xact_rollback),0) FROM pg_stat_database WHERE datname=current_database()),
		       (SELECT coalesce(extract(epoch FROM now() - pg_postmaster_start_time()),0)::bigint)
	`).Scan(&st.DBName, &st.PGVersion, &st.Connections, &st.MaxConnections, &st.DBBytes,
		&st.CacheHitRatio, &st.CommitCount, &st.RollbackCount, &st.UptimeSec)
	if err != nil {
		return nil, err
	}
	if len(st.PGVersion) > 32 {
		st.PGVersion = st.PGVersion[:32]
	}
	return &st, nil
}

func (s *pgStore) PingDB(ctx context.Context) error {
	return s.pool.Ping(ctx)
}
