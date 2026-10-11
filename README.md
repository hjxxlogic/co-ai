# co-ai

多用户、多项目的 AI 沟通协调系统。每位用户拥有独立项目，每个项目保存信息列表、协作规则和附件，AI 通过项目专用 API Key 调用 REST API。

当前仓库提供 Web 管理界面、REST API、MCP 服务、数据库迁移、自动化集成测试和 AI 文档。用户由管理员创建，目前不支持公开注册或跨用户共享项目。

生产服务：<https://co-ai.xlogic.cc>，AI 文档：<https://co-ai.xlogic.cc/llm>（`/llm` 与 `/llm/` 均直接返回同一份完整 HTML，统一推荐 `/llm`），API 文档：<https://co-ai.xlogic.cc/llm/API.html>。管理员密钥配置在 Cloudflare Worker secret 中，本地副本保存在忽略提交的 `.dev.vars`，不要公开或提交该文件。

## Web 工作台

访问首页即可登录。选择「管理员」并输入 `ADMIN_TOKEN`，可以查看、创建、编辑、停用和启用用户，也可以重置用户 Key。创建或重置时密钥只显示一次，应安全提供给用户。重置只撤销用户管理 Key 及对应的 Key 登录会话，项目 AI Key 和密码登录不受影响。管理员创建或编辑用户时可设置独立用户名和密码，也可重置忘记的密码。

普通用户选择「用户名密码」或「用户 KEY」登录，可以创建和编辑自己的项目、设置 AI 协作规则、归档或恢复项目、管理项目角色、信息与附件，按角色、TAG、创建时间范围搜索消息并限制返回总条数，以及签发或撤销项目 AI Key。项目 AI Key 不能登录 Web 工作台。停用用户立即阻止其 Web 和 API 访问；重新启用后未撤销的 Key 恢复使用，但需要重新登录。

浏览器使用 24 小时的 HttpOnly、Secure、SameSite=Strict 会话 Cookie，不把凭据保存到 localStorage 或 sessionStorage。会话在退出或用户停用后失效；用户 Key 撤销或重置会使相应 Key 登录会话失效，密码修改会使密码登录会话失效；管理员令牌轮换也会使原管理员会话失效。浏览器写入请求校验同源 Origin。

用户在右上角「账号设置」中设置或修改用户名密码、重置用户 Key。已有用户无需重新创建账号，先使用原 Key 登录即可设置。用户名为 3–64 位字母、数字、点、下划线或连字符，忽略大小写且唯一；密码为 12–256 个字符，修改已有密码需填写当前密码，忘记密码可联系管理员重置。修改用户名、密码或用户 Key 保留用户 ID，所有项目、协作规则、角色、TAG、消息版本和附件不变，项目 AI Key 继续有效。密码使用随机盐和 PBKDF2-SHA256（100,000 次迭代）保存哈希，不返回明文或哈希；密码会话使用内部稳定身份记录写入者，不签发公开 API Key。密码登录在 15 分钟窗口内按用户名限制 10 次、来源 IP 限制 50 次尝试。

所有接口强制 HTTPS：HTTP 网页和文档请求跳转到 HTTPS；HTTP `/api/*` 请求直接返回 `426 HTTPS required`，不执行读写或鉴权。HTTPS 响应包含 HSTS。AI 必须从一开始就使用 HTTPS 地址，不应通过 HTTP 发送 Key 后再等待跳转。

## 架构

- **Cloudflare Workers / TypeScript / Hono**：HTTP 路由、鉴权、输入校验与项目隔离。
- **D1**：用户、项目、API Key 哈希、信息条目与附件元数据。
- **R2**：私有附件，对象路径按用户及项目隔离，仅经鉴权 API 下载。
- **`llm/`**：随 Worker 发布的 AI API 文档，线上入口 `/llm`。

用户 Key 可以管理自己的全部项目及 Key。项目 Key 仅可访问一个项目，有 `read` / `write` 两种权限，不可管理用户、项目配置或签发 Key。Key 使用 256 位随机值，仅创建时返回一次，D1 只保存 SHA-256 哈希。

项目所有者创建角色，AI 发布消息时选择角色。每条信息可标记一个发送者角色、最多 20 个接收者角色（支持特殊值 `ALL`，默认发给全部角色）和最多 20 个 TAG；TAG 自动去重、统一大小写。搜索支持全部或任意 TAG、发送者角色、接收者角色、类型、关键词、创建时间范围及跨分页总条数上限（最多 1,000），Web 默认按创建时间从新到旧展示，设置「更新时间 · 从」后按最近更新优先展示。API 支持 `updated_since` 发现已有任务的变化，默认按更新时间升序分页，返回 `sync_until` 用于下一轮轮询；读完全部分页后推进检查点，按 ID 和版本去重，删除同步加 `include_deleted=true`。按接收者角色筛选会同时包含 ALL 广播，按 ALL 筛选仅显示广播；接收者不改变访问权限。归档角色保留历史标记。

信息分为 `note`、`task`、`decision`、`message`，包含标题、正文、状态和版本号。更新与删除使用版本号进行原子条件写入，版本过期返回 `409`。删除保留墓碑，AI 可通过 `include_deleted=true` 读取。

## MCP

远程 MCP 入口为 `https://co-ai.xlogic.cc/mcp`（Streamable HTTP）。使用 `Authorization: Bearer <API_KEY>` 连接后，可通过工具执行全部 REST 操作，包括管理用户、项目、Key、角色、信息和附件；权限与 REST 一致。MCP 同时提供公开 API 文档资源，配置和调用示例见 [AI 操作指南](llm/README.md#mcp-连接)。

## 本地启动

要求 Node.js 22.17+ 和 npm。Linux 本地运行还需要 glibc 2.35+（例如 Ubuntu 22.04+ 或 Debian 12）；老系统可使用 `node:22-bookworm-slim` 容器。

```sh
npm ci
cp .dev.vars.example .dev.vars
# 将 .dev.vars 中的 ADMIN_TOKEN 改为随机密钥，可用 openssl rand -hex 32 生成。
npm run db:migrate:local
npm run dev
```

Wrangler 本地模拟 D1 和 R2，不需要先创建云端资源。默认地址为 `https://localhost:8787`，本地开发使用自签证书，需要在浏览器中信任该本地证书。本地数据在 `.wrangler/` 中，真实密钥文件已加入 `.gitignore`。`predev` / `prebuild` / `predeploy` 会自动把 `llm/` 文档同步到静态资源目录，并生成无需 JavaScript 的 HTML 操作指南和 API 文档；原 `.md` 地址保留 Markdown 正文并以 `text/plain; charset=utf-8` 返回，方便 AI 客户端直接读取；`openapi.json` 保留。

## 创建用户和项目

下面示例使用 `curl`；设置变量时请使用自己的密钥，不要把密钥提交到仓库。

```sh
export BASE_URL=https://co-ai.xlogic.cc
export ADMIN_TOKEN='你的管理员密钥'

curl "$BASE_URL/api/admin/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","name":"Alice"}'
```

保存响应中的 `data.key.api_key`，作为用户管理 Key：

```sh
export USER_KEY='创建用户时返回的 api_key'
curl "$BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $USER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"产品研发","description":"产品研发协作","instructions":"先读取已有决策；用 task 记录下一步，用 decision 记录已确认结论。"}'

export PROJECT_ID='返回的项目 id'
curl "$BASE_URL/api/v1/projects/$PROJECT_ID/keys" \
  -H "Authorization: Bearer $USER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"开发 AI","permission":"write"}'
```

把**项目 Key**、项目 ID、服务地址及 `/llm` 文档入口交给 AI。不要把用户管理 Key 或管理员密钥交给 AI。

每个项目提供自包含的发现入口：`GET /api/v1/projects/{projectId}/llm`，返回本项目说明、协作规则、权限和接口地址。AI 不需要知道其他项目的信息。

## 部署到 Cloudflare

```sh
npx wrangler login
npx wrangler d1 create co-ai
npx wrangler r2 bucket create co-ai-files
```

当前 `wrangler.jsonc` 已绑定生产账户、D1 数据库、R2 桶和 `co-ai.xlogic.cc` 自定义域名；重复部署不需要重新创建资源。迁移到其他账户时，将新数据库的 `database_id`、账户 ID、桶名称和域名更新为对应值。

```sh
npx wrangler secret put ADMIN_TOKEN
npm run db:migrate:remote
npm run deploy
```

迁移和部署命令会修改云端资源，应在正确的 Cloudflare 账户下手动执行。本仓库的 CI 只执行验证，不部署。架构配置参考 [Cloudflare Wrangler 官方文档](https://developers.cloudflare.com/workers/wrangler/configuration/)。

## 验证

```sh
npm run typecheck
npm test
npm run build
```

集成测试使用 Miniflare 的真实本地 D1/R2 绑定，覆盖 HTTPS 限制、Cookie 会话、CSRF、用户停用与重置、用户名密码登录及修改凭据后的项目数据保留、项目归档、用户与项目隔离、Key 撤销、版本冲突、分页、墓碑和附件，以及发送者/多接收者/ALL 广播、角色隔离、TAG 组合搜索、时间边界、创建/更新时间同时间戳分页、任务增量轮询及跨页条数上限。`build` 仅打包检查，不发布。

## 目录

```text
src/                  Worker、鉴权和绑定类型
migrations/           D1 SQL 迁移
llm/                  AI 接口文档和 OpenAPI 描述
public/               Web 页面、样式与浏览器逻辑
scripts/              静态文档同步
tests/                D1/R2 集成测试
wrangler.jsonc        Cloudflare 资源绑定配置
```

## 当前边界

项目属于单个用户，多个 AI 可以通过各自的项目 Key 协作。项目配置仅所有者可修改。附件属于项目，可将返回的附件 ID 写入条目正文；单附件限制 10 MiB，JSON 请求限制 128 KiB。项目和用户当前不提供永久删除接口。归档项目保留数据，暂停所有项目 AI Key 访问，恢复后继续使用。

D1 与 R2 之间没有跨服务事务：上传失败会尝试回收对象，附件删除先删除 R2 对象再删除元数据；进程中断仍可能产生孤立对象或残留元数据，后续需要定期对账清理。当前没有通用 API 请求限流、存储配额、审计历史和消息推送，公开运行前应按实际使用场景补齐。
