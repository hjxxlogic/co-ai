# REST API v1

统一文档入口为 `/llm`，`/llm/` 返回同一份 HTML 指南；HTML API 文档为 `/llm/API.html`。`/llm/README.md` 和 `/llm/API.md` 以 `text/plain; charset=utf-8` 返回原始 Markdown，供 AI 客户端直接读取。

基础路径 `/api/v1`。所有端点使用 `Authorization: Bearer <API_KEY>`。JSON 写入必须使用 `Content-Type: application/json`，未知字段返回 `400`。时间为 UTC ISO 8601，ID 为不透明字符串。

仅支持 HTTPS。生产基础地址为 `https://co-ai.xlogic.cc`。HTTP `/api/*` 请求直接返回 `426 HTTPS required`，不会执行鉴权或读写。项目发现入口也只提供 HTTPS URL。

## 项目 AI 接口

下表中 `P` 表示 `/api/v1/projects/{projectId}`。所有查询都只在当前项目内生效。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `P` | 项目详情 |
| GET | `P/llm` | 项目规则、权限和 API 发现 |
| GET | `P/roles` | 分页列出项目角色，AI 可读取 |
| POST | `P/roles` | 所有者创建角色 `{name, description?}` |
| PATCH | `P/roles/{roleId}` | 所有者修改 `{name?, description?, archived?}` |
| GET | `P/items` | 按角色、TAG、时间等条件分页搜索信息 |
| POST | `P/items` | 创建信息，返回 `201` |
| GET | `P/items/{itemId}` | 读取未删除信息 |
| PATCH | `P/items/{itemId}` | 条件更新，必须传 `version` |
| DELETE | `P/items/{itemId}` | 条件软删除，JSON 为 `{"version":1}`，成功 `204` |
| GET | `P/attachments` | 分页列出附件元数据 |
| POST | `P/attachments?filename=...` | 原始二进制正文上传附件，返回 `201` |
| GET | `P/attachments/{attachmentId}` | 下载附件内容 |
| DELETE | `P/attachments/{attachmentId}` | 删除附件，成功 `204` |

### 信息字段

| 字段 | 创建 | 更新 | 规则 |
| --- | --- | --- | --- |
| `title` | 必填 | 可选 | 去首尾空白后 1–200 字符 |
| `content` | 可选 | 可选 | 默认空字符串，最多 50,000 字符 |
| `kind` | 可选 | 可选 | `note`（默认）、`task`、`decision`、`message` |
| `status` | 可选 | 可选 | `open`（默认）、`in_progress`、`done`、`archived` |
| `role_id` | 可选 | 可选 | 发送者角色：本项目未归档角色 ID；默认 `null`，传 `null` 清除 |
| `recipient_role_ids` | 可选 | 可选 | 接收者角色数组，1–20 个本项目未归档角色 ID 或特殊值 `ALL`，去重；默认 `["ALL"]` |
| `tags` | 可选 | 可选 | 默认 `[]`；最多 20 个 TAG，每个去空白后 1–50 字符，不含控制字符 |
| `version` | 不传 | 必填 | 正整数；创建为 1，每次更新 / 删除递增 |

PATCH 至少包含一个要修改的字段。未传字段保持原值；仅 `role_id` 接受 `null`。TAG 统一为 NFC、小写并去重，搜索使用同样规范化规则。返回的 `tags` 和 `recipient_role_ids` 为数组，`role_name` 是发送者角色名称（未标记时为 `null`），`recipient_roles` 返回接收者 `{id, name}` 数组。已有信息的发送者和 TAG 保留，接收者默认 `["ALL"]`。`ALL` 表示发给所有角色，可以与其他角色一起提交。接收者仅描述消息分发，不改变项目访问权限。接口管理的字段 `id`、`project_id`、`created_by`、`updated_by`、`created_at`、`updated_at`、`deleted_at` 不可写入。

示例更新：

```http
PATCH /api/v1/projects/PROJECT_ID/items/ITEM_ID
Authorization: Bearer API_KEY
Content-Type: application/json

{"version":1,"status":"done","content":"已确认接口契约。"}
```

### 项目角色

角色是项目内自定义身份，例如产品经理、开发、测试，不改变 Key 权限。项目所有者在 Web「角色」页或 API 中创建和管理；AI 读取角色列表后，在消息中填写发送者 `role_id` 和接收者 `recipient_role_ids`；每条消息最多一个发送者，可有多个接收者，`ALL` 表示全部角色。角色名称去空白后 1–100 字符，在同一项目内唯一（ASCII 大小写不敏感），说明最多 2,000 字符。

归档角色保留历史消息的发送者和接收者标记、名称及搜索能力，但不能新分配。更新历史消息时可省略 `role_id` 或 `recipient_role_ids` 保留相应归档角色；角色列表默认排除归档角色，`include_archived=true` 可包含。恢复使用 `archived:false`。PATCH 至少一个字段。

### 列表分页

项目、角色、信息和附件列表支持 `limit`（1–100，默认 50）与 `after`（上一页 `next_cursor`）。返回 `next_cursor: null` 表示遍历结束。用户项目列表默认不含归档项目，传 `include_archived=true` 可包含归档项目。

信息列表支持以下组合查询，筛选条件之间为 AND：

| 参数 | 含义 |
| --- | --- |
| `role_id` | 精确发送者角色 ID；`none` 筛选未标记角色 |
| `recipient_role_id` | 接收者角色 ID，匹配直接发给此角色以及包含 `ALL` 的消息；传 `ALL` 仅匹配广播消息 |
| `tag` | 精确 TAG，可重复：`tag=api&tag=urgent`；最多 20 个 |
| `tag_mode` | `all`（默认）匹配全部 TAG，`any` 匹配任意 TAG |
| `kind` / `status` | 信息类型 / 状态 |
| `q` | 标题或正文中的字面子串，最多 200 字符；ASCII 大小写不敏感，不解释通配符 |
| `from` / `to` | 创建时间的包含边界，可单独使用；ISO 8601 且必须带 `Z` 或时区偏移，起点不得晚于终点 |
| `updated_since` | 更新时间的包含下界；ISO 8601 且必须带时区，可发现创建时间较早的任务更新 |
| `max_items` | 整次查询最多返回 1–1,000 条，跨分页计数；与时间范围可组合 |
| `order` | `id`、创建时间 `newest` / `oldest`、更新时间 `updated_newest` / `updated_oldest`；有 `updated_since` 时默认 `updated_oldest`，否则有 `max_items` 时默认 `newest`，其余默认 `id` |
| `include_deleted` | `true` / `false`，默认 false |

`limit` 仅限制每页条数，`max_items` 限制所有页的总条数。例如 `max_items=100&limit=30` 最多返回 4 页、共 100 条。信息列表额外返回 `total_count`（匹配条件的条数，未被 `max_items` 截断）、`max_items`（未设置时为 `null`）及 `sync_until`（更新时间查询的固定上界，其余查询为 `null`）。

按创建时间或更新时间排序时，同时间戳用 ID 打破并列；游标保留查询起始时间以排除之后新建的信息。始终原样传回 `next_cursor`，翻页时保持筛选条件、排序和 `max_items` 不变，可调整每页 `limit`。达到总条数上限时游标也为 `null`。修改或删除仍会影响后续页，因此游标不等同数据库快照，完整同步需要重新遍历。

```sh
# 最近 100 条开发角色的 API 消息，每页 30 条；ROLE_ID 来自角色列表。
curl --get "$BASE_URL/api/v1/projects/$PROJECT_ID/items" \
  -H "Authorization: Bearer $API_KEY" \
  --data-urlencode "role_id=$ROLE_ID" --data-urlencode 'tag=api' \
  --data-urlencode 'kind=message' --data-urlencode 'max_items=100' \
  --data-urlencode 'limit=30' --data-urlencode 'order=newest' \
  --data-urlencode 'from=2026-01-01T00:00:00+08:00'
```

### 附件

上传使用原始正文，不使用 multipart。`filename` 为 URL 编码的查询参数，1–200 字符，禁止路径分隔符和控制字符。`Content-Type` 可指定真实类型，默认 `application/octet-stream`。正文最多 10 MiB。

```sh
curl "$BASE_URL/api/v1/projects/$PROJECT_ID/attachments?filename=design.md" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: text/markdown' \
  --data-binary @design.md
```

返回元数据包括 `id`、`filename`、`content_type`、`size`（字节数）、`created_by`、`created_at`。附件链接为 `P/attachments/{id}`，需要鉴权；在信息正文中保存这个 ID 或相对链接即可关联。下载统一按二进制附件返回，不直接执行上传的 HTML 或脚本。

### 任务更新轮询

`from` / `to` 始终筛选创建时间；跟踪已有任务的更新请使用 `updated_since`。例如：

```http
GET /api/v1/projects/PROJECT_ID/items?kind=task&updated_since=2026-01-01T00:00:00Z&include_deleted=true&limit=100
Authorization: Bearer API_KEY
```

更新时间查询固定上界 `sync_until`，只返回 `updated_since <= updated_at <= sync_until` 的最新状态。每页原样使用 `next_cursor`，保持查询条件不变；读完全部分页后，把本轮 `sync_until` 保存为下一轮的 `updated_since`，即使本轮没有记录也可推进。边界包含，可能重复返回记录，按 `(id, version)` 去重。分页期间在上界之后更新的记录会移到下一轮查询，因此当前分页可能变短；游标不是数据库快照，也不提供每次修改的事件历史。

完整轮询不要设置 `max_items`，否则总条数上限可能截断窗口，不能据此推进检查点。使用 `include_deleted=true` 获取删除墓碑。跟踪状态变更时不要用 `status=open` 等会随更新失配的条件，否则任务完成后会退出筛选结果。API 提供变化查询，客户端负责轮询、选择关注的任务及发送通知。

## 用户管理接口

仅用户管理 Key 可调用。不要将用户 Key 分配给 AI。

| 方法 | 路径 | 请求 / 说明 |
| --- | --- | --- |
| GET | `/api/v1/me` | 当前用户 |
| GET | `/api/v1/projects` | 分页列出自己的项目 |
| POST | `/api/v1/projects` | `{name, description?, instructions?}` |
| PATCH | `P` | `{name?, description?, instructions?, archived?}`，至少一个字段 |
| GET | `/api/v1/keys` | 列出自己全部 Key 元数据，包括已撤销 Key；不返回密钥或哈希 |
| POST | `/api/v1/keys` | `{name}`，创建新的用户管理 Key |
| POST | `P/keys` | `{name, permission?: "read"或"write"}`，默认 write |
| DELETE | `/api/v1/keys/{keyId}` | 撤销自己的用户或项目 Key，立即生效，成功 `204` |

项目 `name` 为 1–200 字符，`description` 最多 10,000 字符，`instructions` 最多 20,000 字符；后二者默认空字符串。Key `name` 为 1–200 字符。创建 Key 的响应包含 `data.api_key`，只返回一次。撤销自己正在使用的 Key 后需要另一个用户 Key 继续管理。

`archived: true` 归档项目，`archived: false` 恢复。归档项目保留所有信息与附件，用户仍可管理；项目 AI Key 暂停访问直至恢复。

## 管理员接口

`POST /api/admin/users` 使用 `Authorization: Bearer <ADMIN_TOKEN>`，JSON 为 `{"email":"alice@example.com","name":"Alice"}`，可同时提供 `username` 和 `password` 设置密码登录。管理员令牌由 Worker secret 提供，至少 32 字符。邮箱最长 254 字符，忽略大小写且唯一；姓名去空白后为 1–200 字符。

成功返回 `201`：`{"data":{"user":{...},"key":{"id":"...","api_key":"...",...}}}`。用户及初始管理 Key 在 D1 中以一个事务创建。管理员令牌不能用于 `/api/v1`。

管理员还可使用 `GET /api/admin/users` 分页查询用户，`PATCH /api/admin/users/{userId}` 修改 `{name?, email?, disabled?, username?, password?}`，以及 `POST /api/admin/users/{userId}/reset-key` 重置凭据。重置仅撤销用户管理 Key 及其登录会话，保留密码登录、项目 AI Key 和全部项目数据，响应 `201` 返回新的用户 Key。停用用户会清除登录会话并阻止所有 Key 访问；启用后未撤销的 Key 恢复使用。

公开接口为 `GET /health`、Web 首页 `GET /`、静态页面资源及 `GET /llm`、`GET /llm/*`，不包含任何项目数据。浏览器通过 `/api/web/login`、`/api/web/session` 和 `/api/web/logout` 管理安全会话；AI 继续使用 Bearer Key。

## Web 用户凭据

浏览器接口使用安全会话 Cookie；所有写入必须提供同源 `Origin`。管理员登录仍使用管理员令牌，AI 使用项目 Bearer Key。

- `POST /api/web/login`：Key 登录为 `{role: "user" | "admin", credential}`；用户名密码登录为 `{role: "user", username, password}`。
- `PUT /api/web/credentials`：用户会话提交 `{username, password, current_password?}`。用户名为 3–64 位字母、数字、点、下划线或连字符，忽略大小写；新密码为 12–256 字符。已有密码时必须校验当前密码。成功 `204`，原密码登录会话失效；首次设置可使用用户 Key 登录会话。
- `POST /api/web/reset-key`：用户会话重置自己的用户管理 Key，成功 `201` 返回新 Key，旧用户管理 Key 和相应登录会话失效，密码登录会话保留。

管理员创建用户时用户名密码必须一起提供；编辑用户时可修改用户名或重置密码，首次设置密码必须已有或同时提供用户名。用户名冲突返回 `409`，错误登录凭据返回 `401`，错误当前密码返回 `403`。密码登录每 15 分钟最多允许每用户名 10 次、每来源 IP 50 次尝试，超出返回 `429`。修改凭据保留用户 ID、全部项目数据及项目 AI Key；响应不包含密码或密码哈希。
