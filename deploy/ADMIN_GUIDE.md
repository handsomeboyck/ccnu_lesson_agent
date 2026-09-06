# 角色与技能管理（管理员指南）

> 适用：线上 https://www.ccnu.chat 及本地部署。

## 1. 角色说明

| 角色 | 可做什么 | 怎么获得 |
|---|---|---|
| `student` | 对话、上传资料、使用技能、查看技能 | 注册默认角色（安全：注册接口不接受 role） |
| `teacher` | student 全部 + **新增/编辑/删除 SKILL.md 技能** | 由管理员提升（见下） |
| `admin` | teacher 全部 + （预留管理接口） | 由管理员提升 |

## 2. 没有内置管理员账号；怎么把某账号提升为 teacher/admin

注册入口一律是 student（已加固，拒绝自提权）。提升角色需在服务器数据库执行 SQL。

**ECS（线上）**，登录服务器后：

```bash
cd /opt/ccnu_lesson_agent
# 查看用户
docker compose exec db psql -U agent -d lesson_agent \
  -c "SELECT username, display_name, role FROM users ORDER BY created_at;"

# 提升（把 <用户名> 换成目标，如 邵风华）
docker compose exec db psql -U agent -d lesson_agent \
  -c "UPDATE users SET role='teacher' WHERE username='<用户名>';"

# 验证
docker compose exec db psql -U agent -d lesson_agent \
  -c "SELECT username, role FROM users;"
```

> 提升后，让该用户**重新登录**（新 JWT 才携带新角色）。之后左侧菜单出现「🧩 技能管理」的增删改按钮。

## 3. 如何新增一个 Skill（两种方式）

### 方式 A：网页管理（推荐，teacher/admin）
1. 登录 teacher/admin 账号 → 左侧「🧩 技能管理」
2. 点「＋ 新建技能」→ 得到模板（YAML frontmatter + markdown 正文）
3. 修改 `name` / `description` / `commands`，正文写清「目标 / 执行步骤 / 输出格式 / 边界」
4. 点「保存并生效」→ 立即生效：对话可被模型自动调用，`/` 菜单出现你定义的命令

### 方式 B：服务器目录（本地/ECS 均可）
```bash
# 目录结构（一个技能 = 一个文件夹 + SKILL.md）
mkdir -p skills/<skill_name>
# 编辑 SKILL.md：
cat > skills/<skill_name>/SKILL.md <<'EOF'
---
name: my_skill                # 技能名（英文标识，工具名）
description: 一句话说明何时用、做什么（给模型看）
commands: [mycmd, 别名]        # /命令；可留空 []（仅靠模型自动触发）
modes: []                     # 可用模式；[] = 全部
---
# 标题

## 目标
什么请求时使用。

## 执行步骤
1. …（模型严格按此逐步做）

## 输出格式
Markdown，简体中文。

## 边界
- 不该做的（如：不替学生作答 / 不确定要澄清）
EOF
# ECS 上 skill 是持久卷，目录：docker compose exec app ls /app/skills
# 写完后调用管理接口热注册，或直接经网页/API 保存：
#   PUT /v1/skills/<skill_name>  body: {"content": "<SKILL.md 全文>"}
```

### SKILL.md 要点（Claude 风格）
- `description` 越具体越好 —— 决定模型何时调用它
- 正文是给模型的**执行指令**：模型会按步骤完成，不写 Go 代码
- 需要向学生澄清时：正文约定在回复首行输出
  `ASK_QUESTION：你的问题`（可加 `ASK_OPTION：选项` 行）→ 系统自动转成提问卡片等待学生回答
- 需要引用资料：正文可要求「若涉及用户上传资料，先说明需检索」

## 4. 平台原语（不可删改，勿命名冲突）
`ask_user`、`knowledge_retrieve` 是系统能力（Go 实现）。新建技能**不要**用这两个名字，否则会被拒绝。

## 5. 删除 / 修改技能
- 网页：列表项右侧 🗑 删除；点开任意 doc 技能可改正文后保存
- 只能改**文档型**技能；平台原语显示「原语」标记不可操作
