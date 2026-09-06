// Package auth 提供认证：JWT 签发/校验、密码哈希、注册/登录/刷新服务与 HTTP 中间件。
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrInvalidToken = errors.New("auth: invalid token")
	ErrExpiredToken = errors.New("auth: token expired")
)

// Claims 是 JWT 载荷。
type Claims struct {
	UserID   string `json:"sub"`
	Username string `json:"username"`
	Role     string `json:"role"`
	Expires  int64  `json:"exp"`
	IssuedAt int64  `json:"iat"`
}

type jwtCodec struct {
	secret []byte
	ttl    time.Duration
}

func newJWTCodec(secret string, ttl time.Duration) *jwtCodec {
	return &jwtCodec{secret: []byte(secret), ttl: ttl}
}

func (c *jwtCodec) sign(header, payload string) string {
	mac := hmac.New(sha256.New, c.secret)
	mac.Write([]byte(header + "." + payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Issue 签发 HS256 access token。
func (c *jwtCodec) Issue(claims Claims) (string, error) {
	now := time.Now()
	if claims.IssuedAt == 0 {
		claims.IssuedAt = now.Unix()
	}
	if claims.Expires == 0 {
		claims.Expires = now.Add(c.ttl).Unix()
	}
	headerJSON, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	payloadJSON, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	header := base64.RawURLEncoding.EncodeToString(headerJSON)
	payload := base64.RawURLEncoding.EncodeToString(payloadJSON)
	return header + "." + payload + "." + c.sign(header, payload), nil
}

// Verify 校验 token 签名与有效期，返回 Claims。
func (c *jwtCodec) Verify(token string) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, ErrInvalidToken
	}
	expected := c.sign(parts[0], parts[1])
	if !hmac.Equal([]byte(expected), []byte(parts[2])) {
		return nil, ErrInvalidToken
	}
	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrInvalidToken
	}
	var claims Claims
	if err := json.Unmarshal(payloadJSON, &claims); err != nil {
		return nil, ErrInvalidToken
	}
	if claims.Expires > 0 && time.Now().Unix() > claims.Expires {
		return nil, ErrExpiredToken
	}
	return &claims, nil
}

// ExtractBearer 从 Authorization 头提取 access token。
func ExtractBearer(authHeader string) (string, error) {
	if authHeader == "" {
		return "", fmt.Errorf("%w: missing Authorization header", ErrInvalidToken)
	}
	parts := strings.Fields(authHeader)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return "", fmt.Errorf("%w: malformed Authorization header", ErrInvalidToken)
	}
	return parts[1], nil
}
