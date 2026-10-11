# co-ai

多用户、多项目的 AI 沟通协调系统。每位用户拥有独立项目，每个项目保存信息列表、协作规则和附件，AI 通过项目专用 API Key 调用 REST API。

当前仓库提供 Web 管理界面、REST API、数据库迁移、自动化集成测试和 AI 文档。用户由管理员创建，目前不支持公开注册或跨用户共享项目。

生产服务：<https://co-ai.xlogic.cc>，AI 文档：<https://co-ai.xlogic.cc/llm>。管理员密钥配置在 Cloudflare Worker secret 中，本地副本保存在忽略提交的 `.dev.vars`，不要公开或提交该文件。

## Web 工作台

访问首页即可登录。选择「管理员」并输入 `ADMIN_TOKEN`，可以查看、创建、编辑、停用和启用用户，也可以重置用户 Key。创建或重置时密钥只显示一次，应安全提供给用户。重置会撤销该用户所有用户 Key、项目 AI Key 及登录会话。

普通用户选择「用户」，用管理员提供的用户 Key 登录，可以创建和编辑自己的项目、设置 AI 协作规则、归档或恢复项目、管理信息与附件，以及签发或撤销项目 AI Key。项目 AI Key 不能登录 Web 工作台。停用用户立即阻止其 Web 和 API 访问；重新启用后未撤销的 Key 恢复使用，但需要重新登录。

浏览器使用 24 小时的 HttpOnly、Secure、SameSite=Strict 会话 Cookie，不把凭据保存到 localStorage 或 sessionStorage。会话在退出、Key 撤销、用户停用或管理员重置 Key 后失效；管理员令牌轮换也会使原管理员会话失效。浏览器写入请求校验同源 Origin。

所有接口强制 HTTPS：HTTP 网页和文档请求跳转到 HTTPS；HTTP `/api/*` 请求直接返回 `426 HTTPS required`，不执行读写或鉴权。HTTPS 响应包含 HSTS。AI 必须从一开始就使用 HTTPS 地址，不应通过 HTTP 发送 Key 后再等待跳转。

## 架构

- **Cloudflare Workers / TypeScript / Hono**：HTTP 路由、鉴权、输入校验与项目隔离。
- **D1**：用户、项目、API Key 哈希、信息条目与附件元数据。
- **R2**：私有附件，对象路径按用户及项目隔离，仅经鉴权 API 下载。
- **`llm/`**：随 Worker 发布的 AI API 文档，线上入口 `/llm`。

用户 Key 可以管理自己的全部项目及 Key。项目 Key 仅可访问一个项目，有 `read` / `write` 两种权限，不可管理用户、项目配置或签发 Key。Key 使用 256 位随机值，仅创建时返回一次，D1 只保存 SHA-256 哈希。

信息分为 `note`、`task`、`decision`、`message`，包含标题、正文、状态和版本号。更新与删除使用版本号进行原子条件写入，版本过期返回 `409`。删除保留墓碑，AI 可通过 `include_deleted=true` 读取。

## 本地启动

要求 Node.js 22.17+ 和 npm。Linux 本地运行还需要 glibc 2.35+（例如 Ubuntu 22.04+ 或 Debian 12）；老系统可使用 `node:22-bookworm-slim` 容器。

```sh
npm ci
cp .dev.vars.example .dev.vars
# 将 .dev.vars 中的 ADMIN_TOKEN 改为随机密钥，可用 openssl rand -hex 32 生成。
npm run db:migrate:local
npm run dev
```

Wrangler 本地模拟 D1 和 R2，不需要先创建云端资源。默认地址为 `https://localhost:8787`，本地开发使用自签证书，需要在浏览器中信任该本地证书。本地数据在 `.wrangler/` 中，真实密钥文件已加入 `.gitignore`。`predev` / `prebuild` / `predeploy` 会自动把 `llm/` 文档同步到静态资源目录。

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

集成测试使用 Miniflare 的真实本地 D1/R2 绑定，覆盖 HTTPS 限制、Cookie 会话、CSRF、用户停用与重置、项目归档、用户与项目隔离、Key 撤销、版本冲突、分页、墓碑和附件。`build` 仅打包检查，不发布。

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

D1 与 R2 之间没有跨服务事务：上传失败会尝试回收对象，附件删除先删除 R2 对象再删除元数据；进程中断仍可能产生孤立对象或残留元数据，后续需要定期对账清理。当前没有内置请求限流、存储配额、密码登录、审计历史和消息推送，公开运行前应按实际使用场景补齐。
