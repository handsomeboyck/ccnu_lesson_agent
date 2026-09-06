package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"
)

// ErrNotFound 表示记录不存在。
var ErrNotFound = errors.New("store: not found")

// ErrUsernameTaken 表示用户名已存在。
var ErrUsernameTaken = errors.New("store: username already taken")

type memoryStore struct {
	mu sync.RWMutex

	users        map[string]*User         // id -> user
	usernames    map[string]string        // username -> id
	refresh      map[string]*RefreshToken // hash -> token
	conversation map[string]*Conversation // id -> conv
	messages     map[string][]*Message    // conversationID -> messages (有序)
	documents    map[string]*Document     // id -> doc
	docChunks    map[string][]*Chunk      // docID -> chunks
}

// NewMemory 创建内存版 Store（M0 本地演示用，进程退出数据即失）。
func NewMemory() Store {
	return &memoryStore{
		users:        map[string]*User{},
		usernames:    map[string]string{},
		refresh:      map[string]*RefreshToken{},
		conversation: map[string]*Conversation{},
		messages:     map[string][]*Message{},
		documents:    map[string]*Document{},
		docChunks:    map[string][]*Chunk{},
	}
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// ---- users ----

func (s *memoryStore) CreateUser(ctx context.Context, u *User) error {
	if u.ID == "" {
		u.ID = newID()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.usernames[u.Username]; ok {
		return ErrUsernameTaken
	}
	now := time.Now()
	u.CreatedAt = now
	clone := *u
	s.users[u.ID] = &clone
	s.usernames[u.Username] = u.ID
	return nil
}

func (s *memoryStore) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.usernames[username]
	if !ok {
		return nil, ErrNotFound
	}
	u := s.users[id]
	if u == nil {
		return nil, ErrNotFound
	}
	clone := *u
	return &clone, nil
}

func (s *memoryStore) GetUserByID(ctx context.Context, id string) (*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u := s.users[id]
	if u == nil {
		return nil, ErrNotFound
	}
	clone := *u
	return &clone, nil
}

// ---- refresh tokens ----

func (s *memoryStore) CreateRefreshToken(ctx context.Context, t *RefreshToken) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	clone := *t
	s.refresh[t.Hash] = &clone
	return nil
}

func (s *memoryStore) GetRefreshToken(ctx context.Context, hash string) (*RefreshToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t := s.refresh[hash]
	if t == nil {
		return nil, ErrNotFound
	}
	clone := *t
	return &clone, nil
}

func (s *memoryStore) DeleteRefreshToken(ctx context.Context, hash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.refresh, hash)
	return nil
}

// ---- conversations ----

func (s *memoryStore) CreateConversation(ctx context.Context, c *Conversation) error {
	if c.ID == "" {
		c.ID = newID()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	c.CreatedAt = now
	c.UpdatedAt = now
	clone := *c
	s.conversation[c.ID] = &clone
	s.messages[c.ID] = []*Message{}
	return nil
}

func (s *memoryStore) GetConversation(ctx context.Context, id, userID string) (*Conversation, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c := s.conversation[id]
	if c == nil || c.UserID != userID {
		return nil, ErrNotFound
	}
	clone := *c
	return &clone, nil
}

func (s *memoryStore) ListConversations(ctx context.Context, userID string) ([]*Conversation, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Conversation
	for _, c := range s.conversation {
		if c.UserID == userID {
			clone := *c
			out = append(out, &clone)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

func (s *memoryStore) UpdateConversation(ctx context.Context, c *Conversation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.conversation[c.ID]
	if old == nil || old.UserID != c.UserID {
		return ErrNotFound
	}
	old.Title = c.Title
	old.UpdatedAt = time.Now()
	return nil
}

func (s *memoryStore) DeleteConversation(ctx context.Context, id, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.conversation[id]
	if c == nil || c.UserID != userID {
		return ErrNotFound
	}
	delete(s.conversation, id)
	delete(s.messages, id)
	return nil
}

func (s *memoryStore) TouchConversation(ctx context.Context, id, userID string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.conversation[id]
	if c == nil || c.UserID != userID {
		return ErrNotFound
	}
	c.UpdatedAt = at
	return nil
}

// ---- messages ----

func (s *memoryStore) CreateMessage(ctx context.Context, m *Message) error {
	if m.ID == "" {
		m.ID = newID()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.conversation[m.ConversationID]; !ok {
		return ErrNotFound
	}
	now := time.Now()
	m.CreatedAt = now
	clone := *m
	s.messages[m.ConversationID] = append(s.messages[m.ConversationID], &clone)
	return nil
}

func (s *memoryStore) ListMessages(ctx context.Context, conversationID string) ([]*Message, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.conversation[conversationID]; !ok {
		return nil, ErrNotFound
	}
	var out []*Message
	for _, m := range s.messages[conversationID] {
		clone := *m
		out = append(out, &clone)
	}
	return out, nil
}

// ---- documents / chunks ----

func (s *memoryStore) CreateDocument(ctx context.Context, d *Document) error {
	if d.ID == "" {
		d.ID = newID()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	d.CreatedAt = now
	clone := *d
	s.documents[d.ID] = &clone
	s.docChunks[d.ID] = nil
	return nil
}

func (s *memoryStore) GetDocument(ctx context.Context, id, userID string) (*Document, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d := s.documents[id]
	if d == nil || d.UserID != userID {
		return nil, ErrNotFound
	}
	clone := *d
	return &clone, nil
}

func (s *memoryStore) ListDocuments(ctx context.Context, userID string) ([]*Document, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Document
	for _, d := range s.documents {
		if d.UserID == userID {
			clone := *d
			out = append(out, &clone)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (s *memoryStore) UpdateDocumentStatus(ctx context.Context, id, userID, status, errMsg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.documents[id]
	if d == nil || d.UserID != userID {
		return ErrNotFound
	}
	d.Status = status
	d.Error = errMsg
	return nil
}

func (s *memoryStore) DeleteDocument(ctx context.Context, id, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.documents[id]
	if d == nil || d.UserID != userID {
		return ErrNotFound
	}
	delete(s.documents, id)
	delete(s.docChunks, id)
	return nil
}

func (s *memoryStore) ReplaceChunks(ctx context.Context, docID string, chunks []Chunk) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.documents[docID]; !ok {
		return ErrNotFound
	}
	store := make([]*Chunk, 0, len(chunks))
	for i := range chunks {
		if chunks[i].ID == "" {
			chunks[i].ID = newID()
		}
		c := chunks[i]
		store = append(store, &c)
	}
	s.docChunks[docID] = store
	return nil
}

// SearchChunks 关键词检索：把 query 按空白拆分，任一关键词命中即返回（简单起步）。
func (s *memoryStore) SearchChunks(ctx context.Context, userID, query string, topK int) ([]ChunkHit, error) {
	keywords := strings.Fields(query)
	if len(keywords) == 0 {
		return nil, nil
	}
	if topK <= 0 {
		topK = 5
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var hits []ChunkHit
	for _, d := range s.documents {
		if d.UserID != userID {
			continue
		}
		for _, c := range s.docChunks[d.ID] {
			if c == nil {
				continue
			}
			lower := strings.ToLower(c.Content)
			for _, kw := range keywords {
				if strings.Contains(lower, strings.ToLower(kw)) {
					hits = append(hits, ChunkHit{Chunk: *c, Filename: d.Filename})
					break
				}
			}
		}
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].Filename < hits[j].Filename })
	if len(hits) > topK {
		hits = hits[:topK]
	}
	return hits, nil
}
