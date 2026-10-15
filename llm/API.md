# REST API v1

统一文档入口为 `/llm`，`/llm/` 返回同一份 HTML 指南；HTML API 文档为 `/llm/API.html`。`/llm/README.md` 和 `/llm/API.md` 以 `text/plain; charset=utf-8` 返回原始 Markdown，供 AI 客户端直接读取。

未认证（`401`）或权限不足（`403`）的响应包含 `error.documentation`，值为当前站点的完整 HTTPS `/llm` 地址。AI 可直接读取该公开地址，了解认证方式和权限要求。

基础路径 `/api/v1`。受保护端点使用 `Authorization: Bearer <API_KEY 或 OAuth access_token>`。JSON 写入必须使用 `Content-Type: application/json`，未知字段返回 `400`。时间为 UTC ISO 8601，ID 为不透明字符串。

OAuth 使用本站授权服务器的授权码 + S256 PKCE 流程，支持客户端动态注册、浏览器项目/权限确认、短期访问令牌、刷新轮换和撤销。发现入口为 `/.well-known/oauth-authorization-server`，REST 用户/项目资源为 `/api/v1`，管理员资源为 `/api/admin`，MCP 资源为 `/mcp`；授权及令牌请求中必须明确发送完整 `resource` URI。端点和调用说明见 [OAuth 浏览器授权](./README.md#oauth-浏览器授权)。`401` 响应提供 `WWW-Authenticate` 发现头；OAuth scope 不足时返回 `403` 和所需 scope。

仅支持 HTTPS。生产基础地址为 `https://co-ai.xlogic.cc`。HTTP `/api/*` 请求直接返回 `426 HTTPS required`，不会执行鉴权或读写。项目发现入口也只提供 HTTPS URL。

## MCP 接口

`POST /mcp` 提供无状态 Streamable HTTP MCP 服务，覆盖本文和 OpenAPI 中 53 个 API 操作；临时上传链接的二进制 PUT 传输不作为 MCP 工具暴露。连接配置及附件、Web 会话说明见 [MCP 连接](./README.md#mcp-连接)。HTTP `/mcp` 请求返回 `426`，GET 支持 SSE 心跳流，POST 支持 JSON 或 SSE 格式响应，DELETE 返回 `405`；GET/POST 连接阶段即要求有效 OAuth Bearer、API Key、管理员令牌或 Web 会话，初始化及工具/文档资源发现也受保护；数据操作复用 REST 权限。HTTP `/llm` 文档与 OAuth 元数据仍公开。

MCP 2.0（`2026-07-28`）支持无初始化的 `server/discover`、工具和资源请求，响应带 `resultType: complete`；使用 JSON 响应及 `Accept: application/json`。同一认证端点提供 `events/list`、`events/subscribe`、`events/unsubscribe`，通过签名 Webhook 投递 `role.messages.received`。按项目和收件角色过滤、合并通知、5 分钟发送间隔及订阅生命周期详见 [角色消息通知](./README.md#角色消息通知mcp-events)。事件订阅不属于 REST 工具目录。

工具名称等于 REST `operationId`，路径和查询参数放在 `arguments` 顶层，JSON 正文放在 `arguments.body`。例如更新信息使用 `patch_api_v1_projects_projectId_items_itemId`，参数为 `{"projectId":"...","itemId":"...","body":{"version":1,"status":"done"}}`；角色工具为 `listProjectRoles`、`createProjectRole`、`updateProjectRole`。重复 TAG 查询使用 `tag: ["api", "urgent"]`，布尔和整数查询参数使用 JSON 布尔和整数。

普通成功与失败结果提供 `structuredContent.status` 和 `structuredContent.body`；REST 失败设置 `isError: true`。认证失败直接返回 HTTP `401`，OAuth 权限不足直接返回 HTTP `403`，并带 MCP 资源的 `WWW-Authenticate` 授权发现头。未知工具、未知参数、错误参数类型等协议错误返回 JSON-RPC `-32602`。无正文的 `204` 操作返回 `body: null`。附件下载返回 Base64 字节和内容类型、下载文件名头、ETag，均在 `body.data` 内。

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
| GET / POST | `P/workflows` | 列出 / 创建工作流模板 |
| GET / PATCH | `P/workflows/{workflowId}` | 读取模板修订版 / 更新模板 |
| GET / POST | `P/works` | 列出 / 创建工作 |
| GET / PATCH | `P/works/{workId}` | 读取 / 修改工作标题或当前状态备注 |
| POST | `P/works/{workId}/transitions` | 沿模板允许的边变更工作状态 |
| GET | `P/works/{workId}/history` | 分页读取追加式状态历史 |
| GET | `P/attachments` | 分页列出附件元数据 |
| POST | `P/attachments?filename=...` | 原始二进制正文上传附件，返回 `201` |
| POST | `P/attachments/uploads` | 写权限：创建 10 分钟有效的单次二进制上传链接，返回 `201` |
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

### 简单工作流

工作流模板定义允许的状态转换，工作绑定创建时的模板修订版。创建模板需要 `name`（1–200 字符）、可选 `description`（最多 2,000 字符），以及 `initial_state`、`states`、`transitions`。状态 ID 为 1–64 字符的 ASCII 字母、数字或下划线且首字符为字母。模板须包含 `{ "id": "end", "name": "结束" }`，初始状态不能是 `end`；结束状态无出边，每个状态必须从初始状态可达并能到达 `end`。最多 32 个状态、128 条有向边，不允许重复边和自环。

```json
{"name":"内容制作","initial_state":"draft","states":[{"id":"draft","name":"草稿"},{"id":"review","name":"审核"},{"id":"end","name":"结束"}],"transitions":[{"from":"draft","to":"review"},{"from":"review","to":"end"}]}
```

`PATCH P/workflows/{workflowId}` 必须带当前模板 `version`；修改定义时三个定义字段一起提交，并产生新的不可变修订版。`GET` 可用 `revision=1` 读取旧版。已有工作固定使用创建时的修订版，新工作使用当前修订版。工作创建正文为 `{workflow_id, title, desc?, message_item_id?}`，状态自动设为初始状态。`desc` 是简短描述，最多 2,000 字符，省略时为空字符串；列表和详情均返回该字段。`PATCH P/works/{workId}` 使用 `{version, title?, desc?, message_item_id?}`，可单独更新或清空 `desc`；`POST P/works/{workId}/transitions` 使用 `{version, to_state, message_item_id?}`，进入新状态时省略备注则清空。修改成功后工作 `version` 加 1；版本不符返回 `409`。工作不能直接修改 `current_state`，进入 `end` 后不能再转换。

`message_item_id` 可为 `null`，否则必须引用同项目未删除的 `kind=message` 信息。被工作历史引用的消息不能删除或改为其他 kind（`409`）。工作当前状态保存在 `current_state`，当前备注保存在 `current_message_item_id`；`GET P/works/{workId}/history` 按序返回 `created`、`transition`、`note_updated` 事件，支持 `limit`（1–100）和数字 `after` 游标。项目 read Key 可读，write Key 可创建和修改；MCP 工具与对应 REST `operationId` 同名，例如 `createWorkflowTemplate`、`createWork`、`transitionWork`、`listWorkHistory`。

`works.updated_at` 是最后修改时间，创建和每次 PATCH / 状态转换都会更新。`GET P/works` 可同时传 `state`、`updated_since` 和 `updated_until`：两个时间边界均包含，格式为带时区的 ISO 8601 时间，起点不得晚于终点；还可叠加 `workflow_id`。结果按工作 ID 升序分页，使用返回的 `next_cursor` 获取下一页，翻页时保持筛选条件不变。例如 `GET P/works?state=review&updated_since=2026-10-01T00%3A00%3A00Z`。

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

处理项目信息时，默认读取全部类型（`note`、`task`、`decision`、`message`），不要加 `kind` 筛选；只有明确只需某一类型时才筛选。使用 `limit=100` 一次获取一批，先在本地保存返回的信息与 `next_cursor`。处理完本地这批后才请求下一页；不要为处理每条信息重新查询整个列表。需要持续同步时，首次使用 `order=updated_oldest`，之后使用 `updated_since`；按 `(id, version)` 去重，读完并处理完本轮所有分页后再用返回的 `sync_until` 开始下一轮查询。

```sh
# 首批项目信息，包含所有类型；处理完这批后用 next_cursor 获取下一批。
curl --get "$BASE_URL/api/v1/projects/$PROJECT_ID/items" \
  -H "Authorization: Bearer $API_KEY" \
  --data-urlencode 'limit=100' --data-urlencode 'order=updated_oldest'
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

大文件可先 `POST P/attachments/uploads`，JSON 正文 `{ "filename": "recording.mp3", "content_type": "audio/mpeg", "size": 5200000 }`，size 可省略但提供时必须匹配精确字节数。返回 `data.upload_url`、`method: "PUT"`、`headers`、`expires_at`、`max_size: 10485760` 和 `attachment_id`。然后 `PUT /api/uploads/attachments/{token}` 发送完整原始二进制文件，使用返回的 Content-Type，不发送 Authorization 或 Cookie。成功返回 `201` 和普通附件元数据，链接随即失效；失败可在有效期内重试。链接绑定项目、文件名和签发时的写权限，不是可用于其他接口的 API Key。签发凭据、用户、OAuth 授权或项目失效后拒绝上传。未使用链接 10 分钟后过期。

上传返回 `400` 表示字节数不匹配，`404` 表示链接无效、过期、已成功使用或授权失效，`409` 表示并发上传冲突，`413` 表示超过 10 MiB，`415` 表示 Content-Type 与链接要求不符。URL 是短期上传凭据，应保密；不要存入项目内容。该能力不需要公开源文件，但发送文件的环境必须能够发起 HTTP PUT；仅有 MCP JSON 工具调用能力的客户端无法通过文件路径传输本地字节。

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

## 项目 D1 数据表

每个项目可以配置多张独立的 Cloudflare D1（SQLite）物理表。接口不接受任意 SQL；表、字段和过滤操作经验证后使用参数化语句执行，无法访问系统表或其他项目的数据。数据库升级需应用 `0007_project_tables.sql`。

入口：`/api/v1/projects/{projectId}/tables`。每张表创建时定义 1–32 个字段，字段名以英文字母开头，后续为字母、数字或下划线，最多 63 个字符，忽略大小写不能重名。`type` 支持 `text`、`integer`、`real`、`boolean`、`json`，`required` 默认 false。必填字段不允许缺失或 null；可选字段缺失保存为 null。integer 为安全整数；text/JSON 单字段最多 20000 个字符，请求正文最多 128 KiB。

| 方法与路径（相对此入口） | 功能 | 权限 |
| --- | --- | --- |
| GET `/` | 列出项目表 | read |
| POST `/` | 创建表，正文 `{name, description?, columns}` | 所有者 / OAuth manage |
| GET `/{tableId}` | 获取表及字段定义 | read |
| PATCH `/{tableId}` | 修改 name、description；字段定义固定 | 所有者 / OAuth manage |
| DELETE `/{tableId}` | 永久删除整张表及全部记录，无需正文 | 所有者 / OAuth manage |
| GET `/{tableId}/rows` | 分页查询记录及过滤 | read |
| POST `/{tableId}/rows` | 新增记录，正文 `{values: {...}}` | write |
| GET `/{tableId}/rows/{rowId}` | 读取单条记录 | read |
| PATCH `/{tableId}/rows/{rowId}` | 修改部分字段，正文 `{version, values: {...}}` | write |
| DELETE `/{tableId}/rows/{rowId}` | 永久删除记录，正文 `{version}` | write |

表和记录的分页均支持 `limit=1..100`（默认 50）、`after=next_cursor`，按服务端生成的 ID 升序返回 `{data, next_cursor}`。记录格式为 `{id, version, created_at, updated_at, values}`，新增记录的 version 为 1；PATCH 每次成功加一。更新/删除时版本不匹配返回 409，记录不存在返回 404。表名在项目内不区分大小写且唯一；重名返回 409。

记录查询的 `filters` 为 URL 编码的 JSON 数组，最多 20 个条件，全部以 AND 组合。例如 `[{"column":"amount","op":"gte","value":10},{"column":"title","op":"contains","value":"客户"}]`。支持 `eq/ne/gt/gte/lt/lte/contains/is_null`；字段名和 value 类型必须匹配定义；contains 仅用于文本，按字面量区分大小写匹配（不是 LIKE 模式）；is_null 不需 value，eq/ne 与 null 分别表示 IS NULL/IS NOT NULL。filters 最长 16000 字符。查询只有 GET，不会因读取数据要求 write scope。

```json
{
  "name": "customers",
  "description": "项目客户记录",
  "columns": [
    {"name": "title", "type": "text", "required": true},
    {"name": "amount", "type": "real"},
    {"name": "active", "type": "boolean"},
    {"name": "extra", "type": "json"}
  ]
}
```

项目只读 Key 无法新增/修改/删除记录，项目读写 Key 可以管理记录但不能创建、修改或删除表。项目归档后项目 Key 暂停访问；项目所有者仍能查看和维护表。MCP 对应工具为 `listProjectTables/createProjectTable/getProjectTable/updateProjectTable/deleteProjectTable` 和 `listTableRows/createTableRow/getTableRow/updateTableRow/deleteTableRow`；JSON 正文放入工具参数 `body`。使用 `getProjectTable` 读取字段定义后再写入，更新前读取记录版本。工作台的“数据表”页也可创建表、查看和编辑记录。
