# co-ai 线上 D1 优化建议（待执行）

状态：**原始待执行计划，主要优化已于 2026-11-01 实施并部署**。下文保留最初计划及检查时的数据，复选框不代表最新执行状态；最新实现、验证和保留事项见 [执行记录](./d1-optimization-release-2026-11-01.md)。

## 检查依据

- 检查日期：2026-11-01。
- 用量窗口：UTC `2026-11-01 00:00:00` 至 `2026-11-01 01:25:40`，不含结束时刻；不是滚动 24 小时。
- 数据库：生产账号下的 `co-ai`，ID 为 `0a23f076-441c-4fd3-aaa4-e28250c91297`。
- 方法：Wrangler 列出数据库、读取数据库信息及 SQL Insights；使用 Wrangler 凭据通过 GraphQL 查询明确 UTC 边界的汇总和 SQL 明细；使用只读 SQL 核实迁移记录及 schema。
- `wrangler d1 info` 的 24 小时指标未混入本文件的今日统计。
- SQL Insights 属于采样数据，用于定位原因，明细不能与汇总逐行对账；下述明细数值不作为精确节省量或账单预测。

| 今日指标 | 数值 |
| --- | ---: |
| 读查询次数 | 3,394 |
| 写查询次数 | 93 |
| 读取行数 | 168,224 |
| 写入行数 | 73,794 |
| 数据库列表存储快照 | 463,433,728 字节（约 463.43 MB） |

存储快照是数据库总量，不代表今日增长量；不同查询时点和接口的存储快照可能不同。

UTC `00:00—00:15` 集中写入 71,499 行，占该库本窗口写入的约 96.9%。线上迁移记录确认，`0015_items_query_performance.sql` 于 UTC `2026-11-01 00:04:29` 应用，包含三个 items 部分索引、标签表与历史标签回填，SQL Insights 也捕获了创建索引操作。判断该峰值主要来自此次迁移，不能按该窗口直接外推全天持续写入。

该迁移是检查前已完成的历史操作，不属于本文件待执行事项。

## 待执行事项

### 1. 减少 items 精确计数（优先级：高，待执行）

依据：两类 `SELECT COUNT(*)` 在 Insights 中累计扫描约 45,006 行。当前 `include_total` 默认 `true`；浏览器后续翻页已经传 `include_total=false`，但首次加载及其他调用方仍可能触发计数。

- [ ] 核查 MCP 客户端、同步程序和轮询调用方，令不展示总数的请求显式传 `include_total=false`。
- [ ] 页面仅首次加载、筛选变化或用户明确刷新总数时计算；审查其他刷新路径是否重复计数。
- [ ] 保留 API 当前默认值和 `total_count: null` 语义，避免影响现有客户端。
- [ ] 比较相同筛选条件和请求量下的读取行数、计数执行次数与响应耗时。

收益：避免每次轮询、同步或翻页重复扫描完整匹配集合。实际节省取决于调用频率和筛选范围，不把全部 45,006 行视为必然可消除。

涉及位置：[src/items.ts](../src/items.ts)、[public/app.js](../public/app.js)、[llm/API.md](../llm/API.md) 及项目外部调用方。

### 2. 优化 works 按 ID 分页（优先级：高，待执行）

依据：`WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?` 在 Insights 中执行约 4 次，累计扫描约 5,368 行，返回 404 行。现有复合索引主要面向更新时间、模板及状态。

- [ ] 对无额外筛选及带状态、模板、更新时间筛选的查询分别检查 `EXPLAIN QUERY PLAN`。
- [ ] 验证候选索引 `works(project_id, id)` 对实际分页查询的收益；验证后再决定是否添加迁移。
- [ ] 对比扫描行数、返回行数及查询耗时，同时评估新增索引的写入和存储成本。
- [ ] 验证多项目隔离、游标连续性、筛选结果和分页边界。

收益：让常见分页直接按项目和 ID 范围定位，减少扫描及排序；具体降幅待执行计划和实测确认。

涉及位置：[src/workflows.ts](../src/workflows.ts)、[migrations/0012_workflows.sql](../migrations/0012_workflows.sql)、[migrations/0013_work_state_updated.sql](../migrations/0013_work_state_updated.sql)。

### 3. 核查 items 索引与写入放大（优先级：中，待执行）

依据：Insights 捕获的 20 次 items 插入累计计入 360 行写入。索引、标签及全文搜索触发器会增加写入；目前没有逐项归因，不能认定某个索引就是主要原因。

- [ ] 建立现有索引与常见查询的对应关系，以执行计划和代表性工作负载验证必要性。
- [ ] 重点核查旧 `items_created` 与新 `items_live_created` 的覆盖范围；前者覆盖含已删除数据，后者仅覆盖未删除数据，不视为完全重复。
- [ ] 检查其他 items 索引是否有可合并或可移除项，并验证包含已删除数据、角色过滤和增量同步等路径。
- [ ] 比较新增、修改、软删除操作的 `rows_written`、读取性能及存储，再决定调整方案。

收益：减少不必要的索引维护和空间占用。具体索引删改方案尚未确定；今天的建索引峰值不构成回退现有迁移的充分依据。

涉及位置：[migrations/0001_initial.sql](../migrations/0001_initial.sql)、[migrations/0003_roles_and_tags.sql](../migrations/0003_roles_and_tags.sql)、[migrations/0011_items_search.sql](../migrations/0011_items_search.sql)、[migrations/0015_items_query_performance.sql](../migrations/0015_items_query_performance.sql)。

### 4. 评估调试日志清理频率（优先级：中低，待执行）

依据：当前每分钟执行过期 MCP 调试日志清理，单批最多 500 条主记录，关联块通过外键级联删除。Insights 捕获约 84 次清理、约 1,682 行写入。当前配置 `MCP_DEBUG_LOGS` 已为 `false`，关闭新增日志后仍需清理历史过期数据。

- [ ] 评估将日志清理改为每 5 分钟执行一次，保持事件投递现有频率。
- [ ] 验证清理吞吐能追上积压，并限制单次运行的批次数和耗时。
- [ ] 继续按需开启调试日志，明确开启时长和保留周期，避免持续生成大量日志块。
- [ ] 验证主记录与日志块级联删除，检查过期积压和清理耗时。

收益边界：降频主要减少查询次数和调度开销；相同数据最终仍要删除，不能将降频比例当作写入行数的节省比例。减少日志生成量才可能降低后续插入及清理写入。

涉及位置：[src/index.ts](../src/index.ts)、[src/mcp-debug.ts](../src/mcp-debug.ts)、[migrations/0010_mcp_debug_logs.sql](../migrations/0010_mcp_debug_logs.sql)、[wrangler.jsonc](../wrangler.jsonc)。

### 5. 检查存储构成（优先级：中，待执行）

依据：目前仅确认数据库总大小，尚未量化正文、trigram 全文索引、普通索引、调试日志块及空闲页各自占用。

- [ ] 在 D1 支持的只读诊断范围内检查表、索引及空闲页占用；对无法直接测量的部分明确限制。
- [ ] 结合数据量与保留需求，判断是否需要缩短日志保留期、调整全文检索范围或归档历史数据。
- [ ] 将空间检查结果与清理后的实际数据库大小分别记录，避免把逻辑删除量直接等同于文件缩小量。

具体清理或归档方案须在存储构成明确后制定。

## 建议执行顺序与验收

优先执行 **1 → 2 → 3**；存储诊断可提前进行，日志清理降频根据积压情况决定。

- [ ] 使用迁移完成后的正常流量建立基线，区分一次性维护和持续业务消耗。
- [ ] 每项单独比较 `rows_read`、`rows_written`、查询次数及响应耗时，记录流量、筛选和数据规模差异。
- [ ] 实施代码或数据库变更时补充相关行为测试，运行 typecheck、测试和 build；新增迁移更新测试中的显式迁移列表。
- [ ] 涉及 API 契约变化时更新 `llm/`；线上迁移和部署作为明确的执行步骤单独记录。

## 官方参考

- [D1 指标与分析](https://developers.cloudflare.com/d1/observability/metrics-analytics/)
- [D1 索引与执行计划](https://developers.cloudflare.com/d1/best-practices/use-indexes/)
- [D1 读写行数及计费规则](https://developers.cloudflare.com/d1/platform/pricing/)
