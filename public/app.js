const root = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toastBox = document.querySelector('#toast');
const emptyFilters = () => ({ role_id: '', recipient_role_id: '', tags: '', tag_mode: 'all', kind: '', q: '', from: '', to: '', updated_since: '', max_items: '' });
const state = { session: null, users: [], projects: [], project: null, items: [], roles: [], keys: [], files: [], tables: [], table: null, rows: [], rowsCursor: null, tab: 'overview', query: '', filters: emptyFilters(), itemsTotal: 0, itemsCursor: null };
const kinds = { note: '笔记', task: '任务', decision: '决策', message: '消息' };
const statuses = { open: '待处理', in_progress: '进行中', done: '已完成', archived: '已归档' };
const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = (value) => new Date(value).toLocaleDateString('zh-CN');
const base = () => `/api/v1/projects/${encodeURIComponent(state.project.id)}`;
let toastTimer;
function toast(message, error = false) {
  clearTimeout(toastTimer); toastBox.textContent = message; toastBox.className = error ? 'error' : ''; toastBox.hidden = false;
  toastTimer = setTimeout(() => { toastBox.hidden = true; }, 6000);
}
const messages = { 'Username already exists': '用户名已被使用', 'Current password is incorrect': '当前密码不正确', 'Too many login attempts; try again in 15 minutes': '登录尝试过多，请在 15 分钟后重试', 'Credentials changed; refresh and retry': '登录信息已更改，请刷新后重试', 'Email already exists': '这个邮箱已经存在', 'Version conflict; read the item and retry': '信息已被其他协作者更新。请关闭编辑框、刷新后重新合并。', 'Invalid credentials': '登录凭据不正确', 'Invalid credentials; use an active user key': '请使用有效的用户 Key 登录，项目 Key 无法登录工作台', 'Version conflict; read the row and retry': '记录已被其他协作者更新，请刷新后重新编辑', 'Table name already exists': '项目中已存在同名数据表', 'Read-only API key': '此 Key 只有只读权限', 'Same-origin request required': '请求来源不匹配，请从本站重新登录' };
async function api(path, options = {}) {
  const headers = { ...options.headers };
  let body = options.body;
  if (body !== undefined && !(body instanceof File) && !(body instanceof Blob)) { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, { ...options, body, headers, credentials: 'same-origin' });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/web/login') {
      state.session = null; state.project = null; dialog.close(); dialog.replaceChildren(); render();
    }
    throw new Error(messages[data.error?.message] ?? (res.status === 401 ? '会话已失效，请重新登录' : data.error?.message ?? '请求失败'));
  }
  return data;
}
async function all(path) {
  const result = []; let cursor;
  do {
    const page = await api(path + (path.includes('?') ? '&' : '?') + 'limit=100' + (cursor ? '&after=' + encodeURIComponent(cursor) : ''));
    result.push(...page.data); cursor = page.next_cursor;
  } while (cursor);
  return result;
}
async function loadHome() {
  if (state.session.role === 'admin') state.users = await all('/api/admin/users');
  else state.projects = await all('/api/v1/projects?include_archived=true');
  state.project = null; render();
}
async function loadProject(id, tab = 'overview') {
  if (state.project?.id !== id) { state.filters = emptyFilters(); state.roles = []; state.table = null; state.rows = []; }
  state.project = (await api('/api/v1/projects/' + encodeURIComponent(id))).data;
  state.tab = tab;
  if (tab === 'items' || tab === 'roles') state.roles = await all(base() + '/roles?include_archived=true');
  if (tab === 'items') await loadItems();
  if (tab === 'keys') state.keys = (await api('/api/v1/keys')).data.filter((k) => k.project_id === id);
  if (tab === 'files') state.files = await all(base() + '/attachments');
  if (tab === 'tables') {
    state.tables = await all(base() + '/tables');
    if (state.table && state.tables.some((table) => table.id === state.table.id)) await loadTable(state.table.id);
    else { state.table = null; state.rows = []; }
  }
  render();
}
async function loadTable(id, append = false) {
  const table = (await api(base() + '/tables/' + encodeURIComponent(id))).data;
  const page = await api(base() + '/tables/' + encodeURIComponent(id) + '/rows?limit=50' + (append && state.rowsCursor ? '&after=' + encodeURIComponent(state.rowsCursor) : ''));
  state.table = table; state.rows = append ? [...state.rows, ...page.data] : page.data; state.rowsCursor = page.next_cursor;
}
const splitTags = (value) => value.split(/\r?\n/).map((tag) => tag.trim()).filter(Boolean);
function itemQuery() {
  const filters = state.filters;
  const query = new URLSearchParams({ order: filters.updated_since ? 'updated_newest' : 'newest', limit: '50' });
  for (const key of ['role_id', 'recipient_role_id', 'kind', 'q', 'max_items']) if (filters[key]) query.set(key, filters[key]);
  for (const key of ['from', 'to', 'updated_since']) if (filters[key]) query.set(key, new Date(filters[key]).toISOString());
  for (const tag of splitTags(filters.tags)) query.append('tag', tag);
  query.set('tag_mode', filters.tag_mode);
  return query;
}
async function loadItems(append = false) {
  const query = itemQuery();
  if (append && state.itemsCursor) query.set('after', state.itemsCursor);
  const page = await api(base() + '/items?' + query);
  state.items = append ? [...state.items, ...page.data] : page.data;
  state.itemsTotal = page.total_count;
  state.itemsCursor = page.next_cursor;
}
function roleOptions(selected = '', filter = false) {
  const rows = filter ? state.roles : state.roles.filter((role) => !role.archived_at || role.id === selected);
  return `<option value="">${filter ? '全部角色' : '不标记角色'}</option>${filter ? `<option value="none" ${selected === 'none' ? 'selected' : ''}>未标记角色</option>` : ''}${rows.map((role) => `<option value="${e(role.id)}" ${role.id === selected ? 'selected' : ''}>${e(role.name)}${role.archived_at ? '（已归档）' : ''}</option>`).join('')}`;
}
function loginView() {
  return `<main class="login"><section class="intro"><div class="brand">co<span>·</span>ai</div><div class="eyebrow">Shared context. Clear next steps.</div><h1>让每一次协作，<br>都有共同的上下文。</h1><p>把背景、任务和决策放进同一个项目。让人与 AI 在清晰的边界内，一起推进工作。</p><div class="intro-footer">项目独立 · 信息共享 · 权限可控</div></section><section class="login-pane"><form id="login-form" class="login-card"><div class="eyebrow">欢迎回来</div><h2>登录协作工作台</h2><p class="muted">选择你的身份，使用专属凭据进入。</p><div class="role-switch"><label><input type="radio" name="login_mode" value="password" checked>用户名密码</label><label><input type="radio" name="login_mode" value="key">用户 KEY</label><label><input type="radio" name="login_mode" value="admin">管理员</label></div><div id="password-login"><label class="field" for="username">用户名</label><input id="username" name="username" required autocomplete="username" maxlength="64" placeholder="请输入用户名"><label class="field" for="password">密码</label><input id="password" name="password" type="password" required autocomplete="current-password" maxlength="256" placeholder="请输入密码"></div><div id="key-login" hidden><label class="field" for="credential">登录凭据</label><input id="credential" name="credential" type="password" disabled autocomplete="off" maxlength="256" placeholder="用户 KEY 或管理员令牌"></div><p class="hint">已有用户可用 KEY 登录后设置用户名密码。项目 AI KEY 仅供 API 调用。</p><button class="primary" type="submit">进入工作台 →</button><p class="hint">仅支持 HTTPS。登录凭据不会保存在浏览器存储中。</p><a href="/llm" target="_blank" rel="noopener">查看 AI API 文档 ↗</a></form></section></main>`;
}
function render() {
  if (!state.session) { root.innerHTML = loginView(); return; }
  const admin = state.session.role === 'admin';
  const userName = admin ? '管理员' : state.session.user.name;
  root.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand">co<span>·</span>ai</div><div><p class="nav-label">工作空间</p><nav><button class="active" data-action="home">${admin ? '用户管理' : '我的项目'}</button><a href="/llm" target="_blank" rel="noopener"><button type="button">AI API 文档 ↗</button></a></nav></div><div class="sidebar-bottom">每个项目，独立的协作空间。<br>co-ai · HTTPS 安全连接</div></aside><div class="workspace"><header class="topbar"><span class="muted">${admin ? '管理控制台' : '协作工作台'}</span><div class="user-meta"><span class="avatar">${e(userName.slice(0, 1))}</span><span>${e(userName)}</span>${admin ? '' : '<button class="small" data-action="account">账号设置</button>'}<button class="small" data-action="logout">退出</button></div></header><main class="main">${admin ? adminView() : state.project ? projectView() : projectsView()}</main></div></div>`;
}
function adminView() {
  const users = state.users.filter((u) => (u.name + u.email).toLowerCase().includes(state.query.toLowerCase()));
  return `<div class="heading"><div><div class="eyebrow">Administration</div><h1>用户管理</h1><p>为团队分配独立的项目空间，管理访问权限。</p></div><button class="primary" data-action="create-user">＋ 创建用户</button></div><div class="stats"><span><strong>${state.users.length}</strong>位用户</span><span><strong>${state.users.filter((u) => !u.disabled_at).length}</strong>位启用</span></div><input class="search" id="user-search" type="search" placeholder="搜索姓名或邮箱" aria-label="搜索用户" value="${e(state.query)}">${users.length ? `<div class="table-wrap"><table><thead><tr><th>用户</th><th>状态</th><th>项目</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${users.map((u) => `<tr><td><strong>${e(u.name)}</strong><span class="hint">${e(u.email)}${u.username ? ` · ${e(u.username)}` : ' · 未设置用户名'}</span></td><td><span class="badge ${u.disabled_at ? 'off' : ''}">${u.disabled_at ? '已停用' : '正常'}</span></td><td>${u.project_count}</td><td>${date(u.created_at)}</td><td><div class="table-actions"><button class="small" data-action="edit-user" data-id="${e(u.id)}">编辑</button><button class="small ${u.disabled_at ? '' : 'danger'}" data-action="toggle-user" data-id="${e(u.id)}">${u.disabled_at ? '启用' : '停用'}</button><button class="small" data-action="reset-user" data-id="${e(u.id)}">重置 Key</button></div></td></tr>`).join('')}</tbody></table></div>` : empty('还没有用户', '创建首位用户，再把用户 Key 安全交给对方。')}`;
}
function empty(title, text) { return `<div class="empty"><h2>${e(title)}</h2><p>${e(text)}</p></div>`; }
function projectsView() {
  return `<div class="heading"><div><div class="eyebrow">Your workspace</div><h1>我的项目</h1><p>从一个共同目标开始，为 AI 准备清晰的协作上下文。</p></div><button class="primary" data-action="create-project">＋ 新建项目</button></div><div class="stats"><span><strong>${state.projects.filter((p) => !p.archived_at).length}</strong>个进行中</span><span><strong>${state.projects.filter((p) => p.archived_at).length}</strong>个已归档</span></div>${state.projects.length ? `<div class="grid">${state.projects.map((p) => `<article class="card project-card"><div><span class="badge ${p.archived_at ? 'off' : ''}">${p.archived_at ? '已归档' : '协作中'}</span></div><h2>${e(p.name)}</h2><p>${e(p.description.slice(0, 180) || '添加项目介绍，让协作者快速了解目标。')}</p><div class="card-bottom"><span class="hint">${date(p.created_at)}</span><button class="small" data-action="open-project" data-id="${e(p.id)}">打开项目 →</button></div></article>`).join('')}</div>` : empty('创建你的第一个项目', '每个项目都有独立的信息列表、AI 规则和专用 Key。')}`;
}
function projectView() {
  const p = state.project;
  return `<button class="back" data-action="home">← 返回我的项目</button><div class="heading"><div><div class="eyebrow">Project workspace</div><h1>${e(p.name)}</h1><p>${e(p.description.slice(0, 160) || '项目协作空间')}</p></div><div class="actions"><button data-action="edit-project">编辑项目</button><button class="${p.archived_at ? '' : 'danger'}" data-action="archive-project">${p.archived_at ? '恢复项目' : '归档项目'}</button></div></div>${p.archived_at ? '<div class="archived-note">项目已归档，项目 AI Key 暂时无法访问。恢复项目后可继续协作；现有信息与附件会保留。</div>' : ''}<div class="tabs" role="tablist">${Object.entries({ overview: '项目概览', roles: '角色', items: '信息列表', keys: 'AI Key', files: '附件', tables: '数据表' }).map(([id, label]) => `<button role="tab" aria-selected="${state.tab === id}" class="${state.tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}">${label}</button>`).join('')}</div>${state.tab === 'overview' ? overviewView() : state.tab === 'roles' ? rolesView() : state.tab === 'items' ? itemsView() : state.tab === 'keys' ? keysView() : state.tab === 'tables' ? tablesView() : filesView()}`;
}
function tablesView() {
  const table = state.table;
  return `<div class="heading"><p>每张表保存独立的结构化记录，项目 AI 可按 Key 权限读写。</p><button class="primary" data-action="create-table">＋ 创建数据表</button></div><div class="grid">${state.tables.map((entry) => `<article class="card"><h2>${e(entry.name)}</h2><p>${e(entry.description || '项目数据表')}</p><p class="hint">${entry.columns.length} 个字段</p><div class="actions"><button data-action="open-table" data-id="${e(entry.id)}">查看记录</button><button data-action="edit-table" data-id="${e(entry.id)}">编辑</button><button class="danger" data-action="delete-table" data-id="${e(entry.id)}">删除</button></div></article>`).join('')}</div>${state.tables.length ? '' : empty('创建项目数据表', '例如客户、库存或实验结果。定义字段后，AI 可通过 REST 或 MCP 查询和更新记录。')}${table ? `<section class="card"><div class="heading"><div><h2>${e(table.name)}</h2><p class="hint">${table.columns.map((column) => `${e(column.name)} · ${e(column.type)}${column.required ? ' · 必填' : ''}`).join('；')}</p><p class="mono">${e(table.id)}</p></div><button class="primary" data-action="create-row">＋ 新增记录</button></div>${state.rows.map((row) => `<article class="card"><div class="mono">${e(row.id)} · 版本 ${e(row.version)}</div><pre class="prose">${e(JSON.stringify(row.values, null, 2))}</pre><div class="actions"><button data-action="edit-row" data-id="${e(row.id)}">编辑</button><button class="danger" data-action="delete-row" data-id="${e(row.id)}">删除</button></div></article>`).join('')}${state.rows.length ? '' : '<p class="hint">此表尚无记录。</p>'}${state.rowsCursor ? '<button data-action="more-rows">加载更多记录</button>' : ''}</section>` : ''}`;
}
function overviewView() {
  const p = state.project;
  return `<div class="detail-grid"><section class="card"><h2>AI 协作规则</h2><div class="prose">${e(p.instructions || '尚未设置规则。编辑项目，告诉 AI 项目目标、约束和协作方式。')}</div></section><section class="card"><h2>连接你的 AI</h2><p class="hint">ChatGPT、Grok 等 MCP connector 使用以下服务器地址，支持 OAuth 浏览器授权。</p><div class="inset mono">${e(location.origin + '/mcp')}</div><p class="hint">如客户端支持自定义请求头，可使用项目专用 Key，将访问限制在此项目。</p><p class="hint">REST 项目说明地址（供直接调用 API 的 AI 读取）：</p><div class="inset mono">${e(location.origin + base() + '/llm')}</div><p class="hint">请求头：Authorization: Bearer &lt;API_KEY&gt;</p><button data-action="tab" data-tab="keys">管理 AI Key →</button><p class="hint">项目 ID</p><div class="mono">${e(p.id)}</div></section><section class="card"><h2>项目介绍</h2><div class="prose">${e(p.description || '尚未填写介绍。')}</div></section><section class="card"><h2>协作方式</h2><div class="prose">笔记保存背景，任务记录下一步，决策保存结论，消息传递协作进展。\n信息更新带版本校验，多位协作者同时编辑时不会静默覆盖。</div></section></div>`;
}
function rolesView() {
  return `<div class="heading"><p>定义发送者和接收者的协作角色。消息可发送给多个角色，或用 ALL 发给全部角色。</p><button class="primary" data-action="create-role">＋ 添加角色</button></div>${state.roles.length ? `<div class="grid">${state.roles.map((role) => `<article class="card project-card"><div><span class="badge ${role.archived_at ? 'off' : ''}">${role.archived_at ? '已归档' : '可用'}</span></div><h2>${e(role.name)}</h2><p>${e(role.description || '尚未填写角色职责')}</p><div class="mono">${e(role.id)}</div><div class="card-bottom"><button class="small" data-action="edit-role" data-id="${e(role.id)}">编辑</button><button class="small ${role.archived_at ? '' : 'danger'}" data-action="archive-role" data-id="${e(role.id)}">${role.archived_at ? '恢复' : '归档'}</button></div></article>`).join('')}</div>` : empty('定义项目中的角色', '例如产品经理、开发、测试。AI 可读取角色列表，选择消息的发送者和接收者角色。')}`;
}
function itemsView() {
  const f = state.filters;
  return `<div class="heading"><p>匹配 ${state.itemsTotal} 条 · 已显示 ${state.items.length} 条${f.max_items ? ` · 最多 ${e(f.max_items)} 条` : ''}</p><div class="actions"><button data-action="refresh">刷新</button><button class="primary" data-action="create-item">＋ 添加信息</button></div></div>
  <form id="item-filter-form" class="card filter-card"><div class="filter-grid">
    <div><label class="field" for="filter-role">发送者角色</label><select id="filter-role" name="role_id">${roleOptions(f.role_id, true)}</select></div>
    <div><label class="field" for="filter-recipient">接收者角色</label><select id="filter-recipient" name="recipient_role_id"><option value="">全部接收者</option><option value="ALL" ${f.recipient_role_id === 'ALL' ? 'selected' : ''}>ALL · 广播消息</option>${state.roles.map((role) => `<option value="${e(role.id)}" ${f.recipient_role_id === role.id ? 'selected' : ''}>${e(role.name)}${role.archived_at ? '（已归档）' : ''}</option>`).join('')}</select></div>
    <div><label class="field" for="filter-kind">类型</label><select id="filter-kind" name="kind"><option value="">全部类型</option>${Object.entries(kinds).map(([id, label]) => `<option value="${id}" ${f.kind === id ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <div><label class="field" for="filter-q">标题 / 正文</label><input id="filter-q" name="q" maxlength="200" value="${e(f.q)}" placeholder="搜索文字"></div>
    <div><label class="field" for="filter-tags">TAG（每行一个）</label><textarea id="filter-tags" name="tags" rows="2" maxlength="1100">${e(f.tags)}</textarea></div>
    <div><label class="field" for="filter-mode">TAG 匹配</label><select id="filter-mode" name="tag_mode"><option value="all" ${f.tag_mode === 'all' ? 'selected' : ''}>同时包含全部 TAG</option><option value="any" ${f.tag_mode === 'any' ? 'selected' : ''}>包含任意 TAG</option></select></div>
    <div><label class="field" for="filter-max">返回总条数</label><input id="filter-max" name="max_items" type="number" min="1" max="1000" value="${e(f.max_items)}" placeholder="不限（分页加载）"></div>
    <div><label class="field" for="filter-from">创建时间 · 从</label><input id="filter-from" name="from" type="datetime-local" step="1" value="${e(f.from)}"></div>
    <div><label class="field" for="filter-to">创建时间 · 至</label><input id="filter-to" name="to" type="datetime-local" step="1" value="${e(f.to)}"></div>
    <div><label class="field" for="filter-updated">更新时间 · 从</label><input id="filter-updated" name="updated_since" type="datetime-local" step="1" value="${e(f.updated_since)}"></div>
  </div><div class="filter-footer"><span class="hint">设置更新时间后按最近更新优先，否则按最近创建优先。时间按本地时区填写，发送时转换为 UTC；各条件可组合。</span><div class="actions"><button type="button" data-action="reset-filters">重置</button><button class="primary" type="submit">筛选</button></div></div></form>
  ${state.items.length ? `<div class="item-list">${state.items.map((item) => `<article class="card"><div class="item-head"><div><h2>${e(item.title)}</h2><div class="item-tags"><span class="badge off">${kinds[item.kind]}</span><span class="badge">${statuses[item.status]}</span>${item.role_name ? `<span class="badge role-badge">发送者：${e(item.role_name)}</span>` : ''}<span class="badge recipient-badge">接收者：${(item.recipient_roles || [{ name: 'ALL' }]).map((role) => e(role.name ?? role.id)).join('、')}</span>${item.tags.map((tag) => `<span class="badge tag-badge">#${e(tag)}</span>`).join('')}</div></div><div class="actions"><button class="small" data-action="edit-item" data-id="${e(item.id)}">编辑</button><button class="small danger" data-action="delete-item" data-id="${e(item.id)}">删除</button></div></div><div class="item-content">${e(item.content)}</div><div class="item-footer">创建于 ${e(new Date(item.created_at).toLocaleString('zh-CN'))} · 更新于 ${e(new Date(item.updated_at).toLocaleString('zh-CN'))} · 版本 ${item.version}</div></article>`).join('')}</div>` : empty('没有匹配的信息', '调整筛选条件，或添加一条消息、笔记和任务。')}
  ${state.itemsCursor ? '<div class="load-more"><button data-action="more-items">加载更多</button></div>' : ''}`;
}
function keysView() {
  return `<div class="heading"><p>为每位 AI 单独分配 Key，随时撤销访问。</p><button class="primary" data-action="create-key">＋ 创建 AI Key</button></div>${state.keys.length ? `<div class="table-wrap"><table><thead><tr><th>名称</th><th>权限</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${state.keys.map((key) => `<tr><td>${e(key.name)}</td><td>${key.permission === 'write' ? '读写' : '只读'}</td><td><span class="badge ${key.revoked_at ? 'off' : ''}">${key.revoked_at ? '已撤销' : '有效'}</span></td><td>${date(key.created_at)}</td><td>${key.revoked_at ? '—' : `<button class="small danger" data-action="revoke-key" data-id="${e(key.id)}">撤销</button>`}</td></tr>`).join('')}</tbody></table></div>` : empty('还没有 AI Key', '创建只读或读写 Key，将项目交给 AI 协作。')}`;
}
function filesView() {
  return `<form id="upload-form" class="card upload-card"><label for="upload" class="hint">项目附件 · 最大 10 MiB</label><input id="upload" name="file" type="file" required><button class="primary" type="submit">上传附件</button></form>${state.files.length ? `<div class="table-wrap"><table><thead><tr><th>文件名</th><th>大小</th><th>上传时间</th><th>操作</th></tr></thead><tbody>${state.files.map((file) => `<tr><td>${e(file.filename)}<span class="hint mono">${e(file.id)}</span></td><td>${(file.size / 1024).toFixed(1)} KB</td><td>${date(file.created_at)}</td><td><div class="table-actions"><a href="${base()}/attachments/${encodeURIComponent(file.id)}" download>下载</a><button class="small danger" data-action="delete-file" data-id="${e(file.id)}">删除</button></div></td></tr>`).join('')}</tbody></table></div>` : empty('还没有附件', '上传说明文档、参考资料，让 AI 从同一个项目读取。')}`;
}
function modal(title, content, form, id = '', version = '') {
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">${e(title)}</h2><button type="button" data-action="close" aria-label="关闭">✕</button></div><form data-form="${form}" data-id="${e(id)}" data-version="${e(version)}">${content}<div class="dialog-footer"><button type="button" data-action="close">取消</button><button class="primary" type="submit">保存</button></div></form>`;
  dialog.showModal();
}
function recipientFields(selected) {
  const roles = [{ id: 'ALL', name: 'ALL · 全部角色' }, ...state.roles.filter((role) => !role.archived_at || selected.includes(role.id))];
  return `<fieldset class="recipient-field"><legend>接收者角色（可多选）</legend><div class="recipient-options">${roles.map((role) => `<label><input type="checkbox" name="recipient_role_ids" value="${e(role.id)}" ${selected.includes(role.id) ? 'checked' : ''}>${e(role.name)}${role.archived_at ? '（已归档）' : ''}</label>`).join('')}</div><p class="hint">至少选择一个接收者。ALL 表示发给全部角色；按接收者筛选时包含 ALL 消息。角色用于消息分发，不改变访问权限。</p></fieldset>`;
}
const field = (label, key, value = '', type = 'text', max = 200, required = false) => `<label class="field" for="field-${key}">${label}</label><input id="field-${key}" type="${type}" name="${key}" value="${e(value)}" maxlength="${max}" ${required ? 'required' : ''}>`;
const textField = (label, key, value = '', max = 10000) => `<label class="field" for="field-${key}">${label}</label><textarea id="field-${key}" name="${key}" maxlength="${max}">${e(value)}</textarea>`;
function showSecret(title, secret, description) {
  dialog.close();
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">${e(title)}</h2><button data-action="close" aria-label="关闭">✕</button></div><p class="hint">${e(description)}</p><p class="error-note">密钥只显示这一次。关闭前请复制并安全保存。</p><textarea class="key-secret" id="key-secret" readonly aria-label="新创建的密钥">${e(secret)}</textarea><div class="dialog-footer"><button class="primary" data-action="copy-key">复制密钥</button><button data-action="close">我已保存</button></div>`;
  dialog.showModal();
}
async function action(button) {
  const id = button.dataset.id;
  switch (button.dataset.action) {
    case 'close': dialog.close(); break;
    case 'home': state.query = ''; await loadHome(); break;
    case 'logout': await api('/api/web/logout', { method: 'POST' }); state.session = null; state.project = null; dialog.close(); render(); break;
    case 'open-project': await loadProject(id); break;
    case 'tab': await loadProject(state.project.id, button.dataset.tab); break;
    case 'refresh': await loadProject(state.project.id, state.tab); break;
    case 'more-items': await loadItems(true); render(); break;
    case 'reset-filters': state.filters = emptyFilters(); await loadItems(); render(); break;
    case 'create-table': case 'edit-table': {
      const table = button.dataset.action === 'edit-table' ? state.tables.find((entry) => entry.id === id) : null;
      modal(table ? '编辑数据表' : '创建数据表', field('表名称', 'name', table?.name, 'text', 100, true) + textField('说明', 'description', table?.description, 5000) + (table ? '<p class="hint">创建后字段定义固定，表名称和说明可修改。</p>' : textField('字段定义（JSON 数组）', 'columns', JSON.stringify([{ name: 'title', type: 'text', required: true }, { name: 'amount', type: 'real' }], null, 2), 12000) + '<p class="hint">字段名以英文字母开头，可含字母、数字、下划线。type 支持 text、integer、real、boolean、json；required 表示必填，最多 32 个字段。</p>'), 'table', table?.id); break;
    }
    case 'open-table': await loadTable(id); render(); break;
    case 'more-rows': await loadTable(state.table.id, true); render(); break;
    case 'delete-table': {
      if (!confirm('永久删除这张数据表及全部记录？此操作不可恢复。')) break;
      await api(base() + '/tables/' + id, { method: 'DELETE' });
      if (state.table?.id === id) { state.table = null; state.rows = []; }
      await loadProject(state.project.id, 'tables'); toast('数据表已删除'); break;
    }
    case 'create-row': case 'edit-row': {
      const row = button.dataset.action === 'edit-row' ? state.rows.find((entry) => entry.id === id) : null;
      const example = Object.fromEntries(state.table.columns.map((column) => [column.name, column.type === 'text' ? '' : column.type === 'boolean' ? false : column.type === 'json' ? {} : 0]));
      modal(row ? '编辑记录' : '新增记录', textField('字段值（JSON 对象）', 'values', JSON.stringify(row?.values ?? example, null, 2), 100000) + '<p class="hint">字段名和类型必须与表定义一致，必填字段不可为 null。修改时校验版本，冲突后请刷新再重试。</p>', 'table-row', row?.id, row?.version); break;
    }
    case 'delete-row': {
      if (!confirm('永久删除这条记录？')) break;
      const row = state.rows.find((entry) => entry.id === id);
      await api(base() + '/tables/' + state.table.id + '/rows/' + id, { method: 'DELETE', body: { version: row.version } });
      await loadTable(state.table.id); render(); toast('记录已删除'); break;
    }
    case 'create-role': case 'edit-role': {
      const role = button.dataset.action === 'edit-role' ? state.roles.find((r) => r.id === id) : {};
      modal(role.id ? '编辑角色' : '添加角色', field('角色名称', 'name', role.name, 'text', 100, true) + textField('角色职责', 'description', role.description, 2000), 'role', role.id); break;
    }
    case 'archive-role': {
      const role = state.roles.find((r) => r.id === id);
      if (!role.archived_at && !confirm('归档后不能给新消息标记此角色，历史消息仍会保留。确定归档？')) break;
      await api(base() + '/roles/' + id, { method: 'PATCH', body: { archived: !role.archived_at } });
      await loadProject(state.project.id, 'roles'); toast(role.archived_at ? '角色已恢复' : '角色已归档'); break;
    }
    case 'account': {
      const user = state.session.user;
      modal('账号设置', field('用户名（3–64 位字母、数字、点、下划线或连字符）', 'username', user.username ?? '', 'text', 64, true) + (user.has_password ? field('当前密码', 'current_password', '', 'password', 256, true) : '') + field('新密码（至少 12 个字符）', 'password', '', 'password', 256, true) + '<p class="hint">保存后请重新登录。项目、消息、附件和项目 AI KEY 不受影响。</p><button type="button" data-action="reset-own-key">重置我的用户 KEY</button>', 'credentials'); break;
    }
    case 'reset-own-key': {
      if (!confirm('重置后旧用户 KEY 将失效，项目数据、项目 AI KEY 和密码登录不受影响。确定继续？')) break;
      const result = await api('/api/web/reset-key', { method: 'POST' });
      await api('/api/web/logout', { method: 'POST' }); state.session = null; state.project = null; render();
      showSecret('用户 KEY 已重置', result.data.api_key, '请安全保存新的用户 KEY。也可以继续使用用户名密码登录。'); break;
    }
    case 'create-user': modal('创建用户', field('姓名', 'name', '', 'text', 200, true) + field('邮箱', 'email', '', 'email', 254, true) + field('用户名（可选，设置时需同时填写密码）', 'username', '', 'text', 64) + field('初始密码（至少 12 个字符，可选）', 'password', '', 'password', 256), 'user'); break;
    case 'edit-user': {
      const user = state.users.find((u) => u.id === id);
      modal('编辑用户', field('姓名', 'name', user.name, 'text', 200, true) + field('邮箱', 'email', user.email, 'email', 254, true) + field('用户名（3–64 位字母、数字、点、下划线或连字符）', 'username', user.username ?? '', 'text', 64) + field('重置密码（至少 12 个字符，留空保留原密码）', 'password', '', 'password', 256) + '<p class="hint">修改登录信息不会影响项目数据和项目 AI KEY。</p>', 'user', id); break;
    }
    case 'toggle-user': {
      const user = state.users.find((u) => u.id === id);
      if (!user.disabled_at && !confirm(`停用「${user.name}」？所有登录会话和 API 访问将立即失效。`)) break;
      await api('/api/admin/users/' + id, { method: 'PATCH', body: { disabled: !user.disabled_at } }); await loadHome(); toast('用户状态已更新'); break;
    }
    case 'reset-user': {
      if (!confirm('重置将撤销该用户的用户 KEY 和对应登录会话，项目数据、项目 AI KEY 和密码登录不受影响。确定继续？')) break;
      const result = await api('/api/admin/users/' + id + '/reset-key', { method: 'POST' });
      showSecret('用户 Key 已重置', result.data.api_key, '请把新的用户 Key 安全提供给用户。项目数据和项目 AI KEY 保持有效。'); break;
    }
    case 'create-project': case 'edit-project': {
      const project = button.dataset.action === 'edit-project' ? state.project : {};
      modal(project.id ? '编辑项目' : '新建项目', field('项目名称', 'name', project.name, 'text', 200, true) + textField('项目介绍', 'description', project.description) + textField('AI 协作规则', 'instructions', project.instructions, 20000), 'project', project.id); break;
    }
    case 'archive-project': {
      const archived = !state.project.archived_at;
      if (archived && !confirm('归档后项目 AI Key 将暂停访问，信息与附件会保留。确定归档？')) break;
      await api(base(), { method: 'PATCH', body: { archived } }); await loadProject(state.project.id); toast(archived ? '项目已归档' : '项目已恢复'); break;
    }
    case 'create-item': case 'edit-item': {
      const item = button.dataset.action === 'edit-item' ? state.items.find((i) => i.id === id) : {};
      modal(item.id ? '编辑信息' : '添加信息', field('标题', 'title', item.title, 'text', 200, true) + `<div class="form-row"><div><label class="field" for="field-kind">类型</label><select id="field-kind" name="kind">${Object.entries(kinds).map(([v, label]) => `<option value="${v}" ${v === item.kind ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div><label class="field" for="field-status">状态</label><select id="field-status" name="status">${Object.entries(statuses).map(([v, label]) => `<option value="${v}" ${v === item.status ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>` + `<label class="field" for="field-role_id">发送者角色</label><select id="field-role_id" name="role_id">${roleOptions(item.role_id)}</select>` + recipientFields(item.recipient_role_ids || ['ALL']) + textField('TAG（每行一个，最多 20 个）', 'tags', (item.tags || []).join('\n'), 1100) + textField('正文', 'content', item.content, 50000), 'item', item.id, item.version); break;
    }
    case 'delete-item': {
      if (!confirm('删除这条信息？其他协作者同步时会收到删除标记。')) break;
      const item = state.items.find((i) => i.id === id);
      await api(base() + '/items/' + id, { method: 'DELETE', body: { version: item.version } }); await loadProject(state.project.id, 'items'); toast('信息已删除'); break;
    }
    case 'create-key': modal('创建 AI Key', field('名称', 'name', '', 'text', 200, true) + '<label class="field" for="field-permission">权限</label><select id="field-permission" name="permission"><option value="write">读写 · 可管理信息和附件</option><option value="read">只读 · 仅获取信息和附件</option></select>', 'key'); break;
    case 'revoke-key': if (confirm('撤销后使用此 Key 的 AI 将立即失去访问权限。确定撤销？')) { await api('/api/v1/keys/' + id, { method: 'DELETE' }); await loadProject(state.project.id, 'keys'); toast('Key 已撤销'); } break;
    case 'delete-file': if (confirm('永久删除此附件？此操作不可恢复。')) { await api(base() + '/attachments/' + id, { method: 'DELETE' }); await loadProject(state.project.id, 'files'); toast('附件已删除'); } break;
    case 'copy-key': {
      const field = document.querySelector('#key-secret');
      try { await navigator.clipboard.writeText(field.value); toast('密钥已复制'); }
      catch { field.focus(); field.select(); toast('请手动复制选中的密钥'); } break;
    }
  }
}
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  button.disabled = true;
  try { await action(button); } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
});
document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!form.matches('#login-form, #upload-form, #item-filter-form, [data-form]')) return;
  event.preventDefault();
  const submit = form.querySelector('[type=submit]');
  if (submit.disabled) return;
  submit.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'login-form') {
      const credentials = values.login_mode === 'password' ? { role: 'user', username: values.username, password: values.password } : { role: values.login_mode === 'admin' ? 'admin' : 'user', credential: values.credential };
      await api('/api/web/login', { method: 'POST', body: credentials });
      form.reset(); state.session = (await api('/api/web/session')).data; await loadHome();
    } else if (form.id === 'item-filter-form') {
      const old = state.filters;
      state.filters = values;
      try { await loadItems(); } catch (error) { state.filters = old; throw error; }
      render();
    } else if (form.id === 'upload-form') {
      const file = values.file;
      if (file.size > 10 * 1024 * 1024) throw new Error('附件不能超过 10 MiB');
      await api(base() + '/attachments?filename=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      await loadProject(state.project.id, 'files'); toast('附件已上传');
    } else {
      const id = form.dataset.id;
      switch (form.dataset.form) {
        case 'credentials': {
          await api('/api/web/credentials', { method: 'PUT', body: values });
          await api('/api/web/logout', { method: 'POST' }); state.session = null; state.project = null; dialog.close(); render(); toast('用户名密码已保存，请重新登录'); break;
        }
        case 'user': {
          if (!values.username) delete values.username;
          if (!values.password) delete values.password;
          const result = await api('/api/admin/users' + (id ? '/' + id : ''), { method: id ? 'PATCH' : 'POST', body: values });
          dialog.close(); await loadHome();
          if (!id) showSecret('用户已创建', result.data.key.api_key, '把这个用户 Key 安全交给新用户，对方可在登录页选择「用户」登录。');
          else toast('用户已更新'); break;
        }
        case 'project': {
          const result = await api('/api/v1/projects' + (id ? '/' + id : ''), { method: id ? 'PATCH' : 'POST', body: values });
          dialog.close(); await loadProject(result.data.id); toast(id ? '项目已更新' : '项目已创建'); break;
        }
        case 'table': {
          if (!id) {
            try { values.columns = JSON.parse(values.columns); } catch { throw new Error('字段定义必须是有效的 JSON 数组'); }
          }
          const result = await api(base() + '/tables' + (id ? '/' + id : ''), { method: id ? 'PATCH' : 'POST', body: values });
          dialog.close(); await loadProject(state.project.id, 'tables'); await loadTable(result.data.id); render(); toast('数据表已保存'); break;
        }
        case 'table-row': {
          try { values.values = JSON.parse(values.values); } catch { throw new Error('字段值必须是有效的 JSON 对象'); }
          if (id) values.version = Number(form.dataset.version);
          await api(base() + '/tables/' + state.table.id + '/rows' + (id ? '/' + id : ''), { method: id ? 'PATCH' : 'POST', body: values });
          dialog.close(); await loadTable(state.table.id); render(); toast('记录已保存'); break;
        }
        case 'role': {
          await api(base() + '/roles' + (id ? '/' + id : ''), { method: id ? 'PATCH' : 'POST', body: values });
          dialog.close(); await loadProject(state.project.id, 'roles'); toast('角色已保存'); break;
        }
        case 'item': {
          values.recipient_role_ids = new FormData(form).getAll('recipient_role_ids');
          if (!values.recipient_role_ids.length) throw new Error('请至少选择一个接收者角色');
          values.tags = splitTags(values.tags);
          values.role_id = values.role_id || null;
          if (id) {
            values.version = Number(form.dataset.version);
            const oldRecipients = state.items.find((item) => item.id === id).recipient_role_ids || ['ALL'];
            if (JSON.stringify([...values.recipient_role_ids].sort()) === JSON.stringify([...oldRecipients].sort())) delete values.recipient_role_ids;
            if (values.role_id === state.items.find((item) => item.id === id).role_id) delete values.role_id;
          }
          await api(base() + '/items' + (id ? '/' + id : ''), { method: id ? 'PATCH' : 'POST', body: values });
          dialog.close(); await loadProject(state.project.id, 'items'); toast('信息已保存'); break;
        }
        case 'key': {
          const result = await api(base() + '/keys', { method: 'POST', body: values });
          dialog.close(); await loadProject(state.project.id, 'keys');
          showSecret('AI Key 已创建', result.data.api_key, '此 Key 仅能访问当前项目。请连同项目入口交给 AI。'); break;
        }
      }
    }
  } catch (error) { toast(error.message, true); } finally { submit.disabled = false; }
});
document.addEventListener('change', (event) => {
  if (event.target.name !== 'login_mode') return;
  const passwordMode = event.target.value === 'password';
  document.querySelector('#password-login').hidden = !passwordMode;
  document.querySelector('#key-login').hidden = passwordMode;
  for (const input of document.querySelectorAll('#password-login input')) input.disabled = !passwordMode;
  const credential = document.querySelector('#credential');
  credential.disabled = passwordMode; credential.required = !passwordMode;
  credential.placeholder = event.target.value === 'admin' ? '管理员令牌' : '用户 KEY';
  for (const input of document.querySelectorAll('#login-form input:not([type=radio])')) if (input.disabled) input.value = '';
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'user-search') {
    const pos = event.target.selectionStart; state.query = event.target.value; render();
    const input = document.querySelector('#user-search'); input.focus(); input.setSelectionRange(pos, pos);
  }
});
dialog.addEventListener('close', () => { if (!dialog.open) dialog.replaceChildren(); });
try { state.session = (await api('/api/web/session')).data; await loadHome(); }
catch (error) { render(); if (state.session) toast(error.message, true); }
