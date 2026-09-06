package auth

import (
	"context"
	"errors"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/config"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

var (
	ErrUserExists     = errors.New("auth: username already exists")
	ErrBadCredentials = errors.New("auth: invalid username or password")
	ErrInvalidRefresh = errors.New("auth: invalid or expired refresh token")
	ErrInvalidInput   = errors.New("auth: invalid input")
	ErrWeakPassword   = errors.New("auth: password must be at least 8 characters")
)

// TokenPair 是登录/刷新返回的令牌对。
type TokenPair struct {
	AccessToken  string
	RefreshToken string
	ExpiresIn    int64 // access token 有效秒数
}

// Service 封装注册/登录/刷新逻辑。
type Service struct {
	store store.Store
	codec *jwtCodec
	cfg   *config.Config
}

func NewService(s store.Store, cfg *config.Config) *Service {
	return &Service{
		store: s,
		codec: newJWTCodec(cfg.JWTSecret, cfg.AccessTokenTTL),
		cfg:   cfg,
	}
}

type RegisterInput struct {
	Username    string
	Password    string
	DisplayName string
	Role        string
}

type UserView struct {
	ID          string    `json:"id"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name"`
	Role        string    `json:"role"`
	CreatedAt   time.Time `json:"created_at"`
}

// Register 注册新用户（默认 student 角色）。
func (s *Service) Register(ctx context.Context, in RegisterInput) (*UserView, error) {
	if len(in.Username) < 3 || len(in.Password) < 8 {
		return nil, ErrInvalidInput
	}
	if in.DisplayName == "" {
		in.DisplayName = in.Username
	}
	if in.Role == "" {
		in.Role = store.RoleStudent
	}
	if !validRole(in.Role) {
		return nil, ErrInvalidInput
	}
	hash, err := HashPassword(in.Password)
	if err != nil {
		return nil, err
	}
	u := &store.User{
		Username:     in.Username,
		DisplayName:  in.DisplayName,
		Role:         in.Role,
		PasswordHash: hash,
	}
	if err := s.store.CreateUser(ctx, u); err != nil {
		if errors.Is(err, store.ErrUsernameTaken) {
			return nil, ErrUserExists
		}
		return nil, err
	}
	return toView(u), nil
}

// Login 校验凭据并签发令牌对。
func (s *Service) Login(ctx context.Context, username, password string) (*UserView, *TokenPair, error) {
	u, err := s.store.GetUserByUsername(ctx, username)
	if err != nil {
		return nil, nil, ErrBadCredentials
	}
	if !VerifyPassword(u.PasswordHash, password) {
		return nil, nil, ErrBadCredentials
	}
	pair, err := s.issueTokens(ctx, u)
	if err != nil {
		return nil, nil, err
	}
	return toView(u), pair, nil
}

// Refresh 用 refresh token 换新令牌对。
func (s *Service) Refresh(ctx context.Context, rawRefresh string) (*UserView, *TokenPair, error) {
	if rawRefresh == "" {
		return nil, nil, ErrInvalidRefresh
	}
	hash := HashToken(rawRefresh)
	rt, err := s.store.GetRefreshToken(ctx, hash)
	if err != nil || time.Now().After(rt.ExpiresAt) {
		_ = s.store.DeleteRefreshToken(ctx, hash)
		return nil, nil, ErrInvalidRefresh
	}
	u, err := s.store.GetUserByID(ctx, rt.UserID)
	if err != nil {
		return nil, nil, ErrInvalidRefresh
	}
	// 轮换 refresh token（防重放）。
	_ = s.store.DeleteRefreshToken(ctx, hash)
	pair, err := s.issueTokens(ctx, u)
	if err != nil {
		return nil, nil, err
	}
	return toView(u), pair, nil
}

// Logout 吊销 refresh token。
func (s *Service) Logout(ctx context.Context, rawRefresh string) error {
	if rawRefresh == "" {
		return nil
	}
	return s.store.DeleteRefreshToken(ctx, HashToken(rawRefresh))
}

func (s *Service) issueTokens(ctx context.Context, u *store.User) (*TokenPair, error) {
	claims := Claims{UserID: u.ID, Username: u.Username, Role: u.Role}
	access, err := s.codec.Issue(claims)
	if err != nil {
		return nil, err
	}
	raw, err := NewRefreshToken()
	if err != nil {
		return nil, err
	}
	rt := &store.RefreshToken{
		Hash:      HashToken(raw),
		UserID:    u.ID,
		ExpiresAt: time.Now().Add(s.cfg.RefreshTokenTTL),
	}
	if err := s.store.CreateRefreshToken(ctx, rt); err != nil {
		return nil, err
	}
	return &TokenPair{
		AccessToken:  access,
		RefreshToken: raw,
		ExpiresIn:    int64(s.cfg.AccessTokenTTL.Seconds()),
	}, nil
}

// GetUserByID 供中间件解析后取用户详情（me 接口）。
func (s *Service) GetUserByID(ctx context.Context, id string) (*UserView, error) {
	u, err := s.store.GetUserByID(ctx, id)
	if err != nil {
		return nil, err
	}
	return toView(u), nil
}

// VerifyAccess 校验 access token，返回 Claims（供 HTTP 中间件使用）。
func (s *Service) VerifyAccess(token string) (*Claims, error) {
	return s.codec.Verify(token)
}

func toView(u *store.User) *UserView {
	return &UserView{ID: u.ID, Username: u.Username, DisplayName: u.DisplayName, Role: u.Role, CreatedAt: u.CreatedAt}
}

func validRole(r string) bool {
	switch r {
	case store.RoleStudent, store.RoleTeacher, store.RoleAdmin:
		return true
	}
	return false
}
