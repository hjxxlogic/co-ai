# 简单工作流设计

## 目标与边界

在项目内增加两种对象：**工作流模板**定义允许的状态转换，**工作**是绑定某一模板修订版的运行实例。工作至少有 ID、当前状态、完整状态历史，以及当前状态备注。备注为空，或引用同项目一条 `kind=message` 的信息。所有数据存于 D1，通过 REST 和由 OpenAPI 生成的 MCP 工具访问。

第一版只提供人工或 AI 显式调用的转换，不提供条件表达式、自动执行、定时器、审批人或跨项目流转。现有 `items.kind=task` 仍是普通信息；工作是独立对象，不隐式同步 task 的 `status`。

## 状态机规则

- 模板属于一个项目，有 ID、名称、说明、初始状态、状态集合、转换边集合和递增版本。状态 ID 是稳定的 ASCII 标识符（1–64 字符，首字符为字母，后续为字母、数字或 `_`），展示名称为 1–100 字符。
- 每份模板必须显式包含状态 `{ "id": "end", "name": "结束" }`。第一版仅 `end` 是结束状态；初始状态不能是 `end`。状态数为 2–32，转换数最多 128。
- 转换是有向的 `{from, to}`。两端必须存在，不允许重复边或自环，`end` 没有出边。每个非结束状态都必须能从初始状态到达，并且有通往 `end` 的路径。这使模板既没有死路，也没有不可用状态；环路可以存在。
- 创建工作时自动进入模板的初始状态，并写入序号 1 的历史事件。后续只能沿绑定修订版中的一条边转换；进入 `end` 后不能再转换。需要重新开始时创建新工作。
- 模板的状态机定义每次修改都生成不可变的修订版；只改名称或说明仅增加模板版本号。已有工作固定使用创建时的修订版；新工作使用创建事务中读取的当前修订版。修改模板不会悄悄改变在途工作的合法转换。第一版不提供工作迁移修订版或删除模板。

例如：

```json
{
  "name": "内容制作",
  "description": "脚本到审核完成",
  "initial_state": "draft",
  "states": [
    {"id": "draft", "name": "草稿"},
    {"id": "review", "name": "审核"},
    {"id": "end", "name": "结束"}
  ],
  "transitions": [
    {"from": "draft", "to": "review"},
    {"from": "review", "to": "draft"},
    {"from": "review", "to": "end"}
  ]
}
```

## D1 数据模型

迁移 `0012_workflows.sql` 使用以下四张系统表，不复用用户自定义 `project_tables`；`0014_work_desc.sql` 为工作增加简短描述：

| 表 | 关键字段 | 作用 |
| --- | --- | --- |
| `workflow_templates` | `id`, `project_id`, `name`, `description`, `version`, `current_revision_id`, `created_by`, `updated_by`, `created_at`, `updated_at` | 模板元数据与当前修订版；同项目名称不区分大小写且唯一。 |
| `workflow_revisions` | `id`, `template_id`, `revision`（从 1 递增）, `definition`（JSON）, `created_by`, `created_at` | 不可变状态机快照；唯一约束 `(template_id, revision)`，JSON 用 `json_valid` 约束。 |
| `works` | `id`, `project_id`, `template_id`, `revision_id`, `title`, `desc`, `current_state`, `current_message_item_id`（可空）, `version`, `created_by`, `updated_by`, `created_at`, `updated_at` | 工作当前状态的快速读取；`desc` 是默认空字符串的简短描述，`version` 从 1 开始，用于乐观并发。 |
| `work_history` | `work_id`, `sequence`, `event_type`, `from_state`（可空）, `to_state`, `message_item_id`（可空）, `actor_key_id`, `created_at` | 追加式历史；主键 `(work_id, sequence)`，记录 `created`、`transition` 或 `note_updated`。 |

`definition` 保存完整的 `initial_state`、`states`、`transitions`；写入前用 Zod 完整校验，读取历史定义时不依赖模板当前版本。`workflow_revisions` 不允许经 API 修改。`works.current_state` 和 `current_message_item_id` 等于最后一条历史事件的 `to_state` 和 `message_item_id`；每次状态或备注变更都在同一 D1 事务中更新工作并追加历史，避免两者分叉。`works.updated_at` 是最后修改时间；迁移 `0013_work_state_updated.sql` 增加 `(project_id, current_state, updated_at, id)` 联合索引，按 `(work_id, sequence)` 顺序读取历史。

消息引用只接受同项目、未软删除且 `kind=message` 的现有 item ID。迁移中的触发器应约束引用的项目、类型与删除状态，并阻止被引用消息的软删除或改为其他 kind，返回可识别的 `409`。历史中的消息引用永久保留；修改当前备注不会改写旧事件。消息正文的编辑仍遵循现有 item 版本规则，历史记录的是消息 ID，不是正文快照。

## REST 契约

以下路径均相对于 `P=/api/v1/projects/{projectId}`。成功响应沿用 `{data: ...}`；列表沿用 `{data: [...], next_cursor}`、`limit=1..100`、`after`。ID 均由服务端生成 UUID，时间为 UTC ISO 8601。输入对象严格拒绝未知字段。

| 方法 | 路径 | 输入与行为 |
| --- | --- | --- |
| GET | `P/workflows` | 分页列出模板当前版本摘要。 |
| POST | `P/workflows` | 提交完整模板定义；返回模板及版本 1，HTTP 201。 |
| GET | `P/workflows/{workflowId}` | 返回模板元数据和当前完整定义；可带 `revision` 读取指定历史修订版。 |
| PATCH | `P/workflows/{workflowId}` | 必填当前 `version`；可改 `name`、`description`，或同时提供完整的 `initial_state`、`states`、`transitions` 来替换状态机。定义变更创建新修订版；成功版本加 1。 |
| GET | `P/works` | 分页列出工作摘要；可组合 `workflow_id`、`state`、`updated_since`、`updated_until` 筛选，时间范围包含边界。 |
| POST | `P/works` | `{workflow_id, title, desc?, message_item_id?}`；使用模板当前修订版和初始状态，写入初始历史；返回 201。 |
| GET | `P/works/{workId}` | 返回工作、当前备注 ID、绑定的模板修订版及版本。 |
| PATCH | `P/works/{workId}` | `{version, title?, desc?, message_item_id?}`；至少有一个改动字段。`message_item_id` 可为 `null`，改变备注时追加 `note_updated` 历史事件，状态不变。 |
| POST | `P/works/{workId}/transitions` | `{version, to_state, message_item_id?}`；沿模板边转换，未提供备注时新状态备注为 `null`；追加 `transition` 历史并返回更新后的工作。 |
| GET | `P/works/{workId}/history` | 按 `sequence` 升序分页，返回创建、转换和备注变更事件；历史不可修改或删除。 |

工作和模板的修改要求 `version` 与服务器当前值一致；冲突返回 `409`，客户端重新读取后重试。不存在、属于别的项目或引用无权访问的对象返回 `404`，非法状态机、非法转换或错误消息类型返回 `400`；终态再次转换返回 `409`。工作创建在一个事务中读取模板当前修订版并写入绑定关系，确保并发修改模板时使用一个确定的修订版。状态更新使用 `UPDATE ... WHERE id=? AND project_id=? AND version=?`，与历史插入在同一事务内完成；失败不留下半条历史。

创建工作示例：

```http
POST /api/v1/projects/PROJECT_ID/works
Content-Type: application/json

{"workflow_id":"WORKFLOW_ID","title":"MW-U03-S05 音频审核","message_item_id":null}
```

状态转换示例（审核结论先作为 `message` 写入 items）：

```http
POST /api/v1/projects/PROJECT_ID/works/WORK_ID/transitions
Content-Type: application/json

{"version":2,"to_state":"end","message_item_id":"MESSAGE_ITEM_ID"}
```

## 权限与 MCP

沿用项目路由的认证与隔离：项目 read Key/OAuth read 可读取模板、工作与历史；项目 write Key/OAuth write 可创建模板、工作和执行修改或转换。项目所有者也可操作，归档项目时项目 Key 继续按现有规则暂停访问。角色仅用于消息分发，不授予工作流额外权限。所有 SQL 按项目 ID 限定并参数化；不能以另一个项目的消息作为备注。

每个 REST 操作写入 `llm/openapi.json`，设置稳定的 `operationId`，例如 `createWorkflowTemplate`、`updateWorkflowTemplate`、`createWork`、`updateWork`、`transitionWork`、`listWorkHistory`。现有 `src/mcp-tools.ts` 从 OpenAPI 生成同名 MCP 工具，JSON 正文放在 `arguments.body`，因此无需另建一套工作流执行语义。`llm/API.md`、`llm/README.md` 和 `GET P/llm` 的端点列表也同步更新。生产环境仍需先应用迁移并部署新 Worker。

## 验收要点

1. 模板校验拒绝缺少 `end`、终态出边、不可达状态、无法到达终态的状态和重复边。
2. 模板更新后，旧工作仍按旧修订版转换，新工作按新修订版转换。
3. 同版本并发转换仅一个成功；当前状态、备注和历史序号始终一致。
4. 备注拒绝其他项目、非 `message` 或已删除的 item；被引用消息不能删除或改 kind。
5. read Key 不能写，项目 Key 不能跨项目读取；REST 与 MCP 得到相同结果和错误语义。
6. 历史分页按序完整返回，`end` 不允许继续转换，直接改 `current_state` 的请求被拒绝。
