# REST API v1

基础路径 `/api/v1`。所有端点使用 `Authorization: Bearer <API_KEY>`。JSON 写入必须使用 `Content-Type: application/json`，未知字段返回 `400`。时间为 UTC ISO 8601，ID 为不透明字符串。

仅支持 HTTPS。生产基础地址为 `https://co-ai.xlogic.cc`。HTTP `/api/*` 请求直接返回 `426 HTTPS required`，不会执行鉴权或读写。项目发现入口也只提供 HTTPS URL。

## 项目 AI 接口

下表中 `P` 表示 `/api/v1/projects/{projectId}`。所有查询都只在当前项目内生效。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `P` | 项目详情 |
| GET | `P/llm` | 项目规则、权限和 API 发现 |
| GET | `P/items` | 分页列出信息 |
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
| `version` | 不传 | 必填 | 正整数；创建为 1，每次更新 / 删除递增 |

PATCH 至少包含一个要修改的字段。未传字段保持原值；不接受 `null`。接口管理的字段 `id`、`project_id`、`created_by`、`updated_by`、`created_at`、`updated_at`、`deleted_at` 不可写入。

示例更新：

```http
PATCH /api/v1/projects/PROJECT_ID/items/ITEM_ID
Authorization: Bearer API_KEY
Content-Type: application/json

{"version":1,"status":"done","content":"已确认接口契约。"}
```

### 列表分页

项目、信息和附件列表支持 `limit`（1–100，默认 50）与 `after`（上一页 `next_cursor`）。返回 `next_cursor: null` 表示遍历结束。用户项目列表默认不含归档项目，传 `include_archived=true` 可包含归档项目。

信息列表额外支持 `status` 和 `include_deleted=true|false`（默认 false）。没有全文搜索或增量时间游标；完整同步需要重新遍历全部分页。

### 附件

上传使用原始正文，不使用 multipart。`filename` 为 URL 编码的查询参数，1–200 字符，禁止路径分隔符和控制字符。`Content-Type` 可指定真实类型，默认 `application/octet-stream`。正文最多 10 MiB。

```sh
curl "$BASE_URL/api/v1/projects/$PROJECT_ID/attachments?filename=design.md" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: text/markdown' \
  --data-binary @design.md
```

返回元数据包括 `id`、`filename`、`content_type`、`size`（字节数）、`created_by`、`created_at`。附件链接为 `P/attachments/{id}`，需要鉴权；在信息正文中保存这个 ID 或相对链接即可关联。下载统一按二进制附件返回，不直接执行上传的 HTML 或脚本。

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

`POST /api/admin/users` 使用 `Authorization: Bearer <ADMIN_TOKEN>`，JSON 为 `{"email":"alice@example.com","name":"Alice"}`。管理员令牌由 Worker secret 提供，至少 32 字符。邮箱最长 254 字符，忽略大小写且唯一；姓名去空白后为 1–200 字符。

成功返回 `201`：`{"data":{"user":{...},"key":{"id":"...","api_key":"...",...}}}`。用户及初始管理 Key 在 D1 中以一个事务创建。管理员令牌不能用于 `/api/v1`。

管理员还可使用 `GET /api/admin/users` 分页查询用户，`PATCH /api/admin/users/{userId}` 修改 `{name?, email?, disabled?}`，以及 `POST /api/admin/users/{userId}/reset-key` 重置凭据。重置撤销此用户全部 Key 和登录会话，响应 `201` 返回新的用户 Key。停用用户会清除登录会话并阻止所有 Key 访问；启用后未撤销的 Key 恢复使用。

公开接口为 `GET /health`、Web 首页 `GET /`、静态页面资源及 `GET /llm`、`GET /llm/*`，不包含任何项目数据。浏览器通过 `/api/web/login`、`/api/web/session` 和 `/api/web/logout` 管理安全会话；AI 继续使用 Bearer Key。
