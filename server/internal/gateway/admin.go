package gateway

import (
	"encoding/json"
	"net/http"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// adminService 提供管理员专用功能（API Key 热替换等）。
type adminService struct {
	apiKeyFile string
	baseURL    string
}

func newAdminService(apiKeyFile, baseURL string) *adminService {
	return &adminService{apiKeyFile: apiKeyFile, baseURL: baseURL}
}

// replaceAPIKey 替换 API Key：验证连通性 → 持久化 → 内存原子替换。
func (a *adminService) replaceAPIKey(w http.ResponseWriter, r *http.Request) {
	if a.apiKeyFile == "" || a.baseURL == "" {
		writeError(w, http.StatusServiceUnavailable, "apikey 热替换未配置（APIKEY_FILE 或 OPENAI_BASE_URL 为空）")
		return
	}
	var body struct {
		APIKey string `json:"api_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.APIKey == "" {
		writeError(w, http.StatusBadRequest, "缺少 api_key 字段")
		return
	}
	if err := model.ReplaceAPIKey(a.apiKeyFile, a.baseURL, body.APIKey); err != nil {
		writeError(w, http.StatusBadRequest, "替换失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "message": "API Key 已更新，验证通过，即时生效"})
}

// 复用 store.RoleAdmin 常量——gateway 包已有 import store
var _ = store.RoleAdmin