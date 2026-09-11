package model

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"sync/atomic"
	"time"
)

var currentKey atomic.Pointer[string]

// InitAPIKey 初始化 API Key：文件存在→读文件；否则用 envKey 写入文件。
func InitAPIKey(filePath, envKey string) error {
	if envKey == "" {
		return fmt.Errorf("apikey: no initial key")
	}
	// 文件存在就从中加载
	if data, err := os.ReadFile(filePath); err == nil && len(data) > 0 {
		key := string(data)
		currentKey.Store(&key)
		return nil
	}
	// 否则将 envKey 写入文件并加载
	if err := os.WriteFile(filePath, []byte(envKey), 0600); err != nil {
		return fmt.Errorf("apikey: write file: %w", err)
	}
	currentKey.Store(&envKey)
	return nil
}

// GetAPIKey 返回当前 API Key（线程安全）。
func GetAPIKey() string {
	if p := currentKey.Load(); p != nil {
		return *p
	}
	return ""
}

// ReplaceAPIKey 验证新 key 连通性 → 写文件 → 替换内存（即时生效，无需重启）。
func ReplaceAPIKey(filePath, baseURL, newKey string) error {
	if newKey == "" {
		return fmt.Errorf("apikey: key is empty")
	}
	// 1. 连通性验证：调 /user/balance
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/user/balance", nil)
	if err != nil {
		return fmt.Errorf("apikey: verify request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+newKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("apikey: verify connectivity failed: %w", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("apikey: verify got HTTP %d（key 无效或网络不通）", resp.StatusCode)
	}
	// 2. 持久化到文件
	if err := os.WriteFile(filePath, []byte(newKey), 0600); err != nil {
		return fmt.Errorf("apikey: persist file: %w", err)
	}
	// 3. 原子替换内存
	currentKey.Store(&newKey)
	return nil
}