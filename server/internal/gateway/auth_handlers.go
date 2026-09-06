package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/auth"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// authService 是认证相关 HTTP 处理器。
type authService struct {
	svc *auth.Service
}

type ctxKey string

const claimsKey ctxKey = "claims"

func (a *authService) register(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username    string `json:"username"`
		Password    string `json:"password"`
		DisplayName string `json:"display_name"`
	}
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// 安全：注册一律 student，忽略/拒绝请求中的 role（管理员由受控方式提升，见部署文档）
	u, err := a.svc.Register(r.Context(), auth.RegisterInput{
		Username:    in.Username,
		Password:    in.Password,
		DisplayName: in.DisplayName,
		Role:        store.RoleStudent,
	})
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrInvalidInput):
			writeError(w, http.StatusBadRequest, "username >= 3 chars, password >= 8 chars")
		case errors.Is(err, auth.ErrUserExists):
			writeError(w, http.StatusConflict, "username already exists")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

func (a *authService) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	u, pair, err := a.svc.Login(r.Context(), in.Username, in.Password)
	if err != nil {
		if errors.Is(err, auth.ErrBadCredentials) {
			writeError(w, http.StatusUnauthorized, "invalid username or password")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":          u,
		"access_token":  pair.AccessToken,
		"refresh_token": pair.RefreshToken,
		"token_type":    "bearer",
		"expires_in":    pair.ExpiresIn,
	})
}

func (a *authService) refresh(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	u, pair, err := a.svc.Refresh(r.Context(), in.RefreshToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid or expired refresh token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":          u,
		"access_token":  pair.AccessToken,
		"refresh_token": pair.RefreshToken,
		"token_type":    "bearer",
		"expires_in":    pair.ExpiresIn,
	})
}

func (a *authService) logout(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RefreshToken string `json:"refresh_token"`
	}
	_ = decodeJSON(r, &in) // body 可选
	_ = a.svc.Logout(r.Context(), in.RefreshToken)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *authService) me(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	u, err := a.svc.GetUserByID(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	writeJSON(w, http.StatusOK, u)
}

// requireAuth 包装受保护接口：解析 Bearer token 并把 Claims 放入 context。
func (a *authService) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, err := auth.ExtractBearer(r.Header.Get("Authorization"))
		if err != nil {
			writeError(w, http.StatusUnauthorized, "missing or malformed authorization header")
			return
		}
		claims, err := a.svc.VerifyAccess(token)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid or expired token")
			return
		}
		ctx := context.WithValue(r.Context(), claimsKey, claims)
		next(w, r.WithContext(ctx))
	}
}

// requireRole 在 requireAuth 基础上校验角色（如 teacher/admin 才可管理技能）。
// 用法：authH.requireRole(next, store.RoleTeacher, store.RoleAdmin)
func (a *authService) requireRole(next http.HandlerFunc, roles ...string) http.HandlerFunc {
	allowed := map[string]bool{}
	for _, r := range roles {
		allowed[r] = true
	}
	return a.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		claims := claimsFrom(r.Context())
		if claims == nil || !allowed[claims.Role] {
			writeError(w, http.StatusForbidden, "permission denied")
			return
		}
		next(w, r)
	})
}

// claimsFrom 从 context 取 Claims。
func claimsFrom(ctx context.Context) *auth.Claims {
	c, _ := ctx.Value(claimsKey).(*auth.Claims)
	return c
}

func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	return dec.Decode(v)
}
