package model

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// BalanceInfo DeepSeek 余额信息。
type BalanceInfo struct {
	IsAvailable   bool            `json:"is_available"`
	BalanceInfos  []BalanceItem   `json:"balance_infos"`
}

// BalanceItem 单币种余额。
type BalanceItem struct {
	Currency        string `json:"currency"`
	TotalBalance    string `json:"total_balance"`
	GrantedBalance  string `json:"granted_balance"`
	ToppedUpBalance string `json:"topped_up_balance"`
}

// QueryBalance 查询 DeepSeek 账户余额（GET /user/balance）。
func QueryBalance(ctx context.Context, baseURL, apiKey string) (*BalanceInfo, error) {
	if baseURL == "" || apiKey == "" {
		return nil, fmt.Errorf("balance: baseURL or apiKey empty")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/user/balance", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	cl := &http.Client{Timeout: 10 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return nil, fmt.Errorf("balance: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("balance: status %d", resp.StatusCode)
	}
	var info BalanceInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, err
	}
	return &info, nil
}