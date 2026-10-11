const root = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toastBox = document.querySelector('#toast');
const state = { session: null, users: [], projects: [], project: null, items: [], keys: [], files: [], tab: 'overview', query: '' };
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
const messages = { 'Email already exists': '这个邮箱已经存在', 'Version conflict; read the item and retry': '信息已被其他协作者更新。请关闭编辑框、刷新后重新合并。', 'Invalid credentials': '登录凭据不正确', 'Invalid credentials; use an active user key': '请使用有效的用户 Key 登录，项目 Key 无法登录工作台', 'Read-only API key': '此 Key 只有只读权限', 'Same-origin request required': '请求来源不匹配，请从本站重新登录' };
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
  state.project = (await api('/api/v1/projects/' + encodeURIComponent(id))).data;
  state.tab = tab;
  if (tab === 'items') state.items = await all(base() + '/items');
  if (tab === 'keys') state.keys = (await api('/api/v1/keys')).data.filter((k) => k.project_id === id);
  if (tab === 'files') state.files = await all(base() + '/attachments');
  render();
}
function loginView() {
  return `<main class="login"><section class="intro"><div class="brand">co<span>·</span>ai</div><div class="eyebrow">Shared context. Clear next steps.</div><h1>让每一次协作，<br>都有共同的上下文。</h1><p>把背景、任务和决策放进同一个项目。让人与 AI 在清晰的边界内，一起推进工作。</p><div class="intro-footer">项目独立 · 信息共享 · 权限可控</div></section><section class="login-pane"><form id="login-form" class="login-card"><div class="eyebrow">欢迎回来</div><h2>登录协作工作台</h2><p class="muted">选择你的身份，使用专属凭据进入。</p><div class="role-switch"><label><input type="radio" name="role" value="user" checked>用户</label><label><input type="radio" name="role" value="admin">管理员</label></div><label class="field" for="credential">登录凭据</label><input id="credential" name="credential" type="password" required autocomplete="off" maxlength="256" placeholder="用户 Key 或管理员令牌"><p class="hint">用户 Key 由管理员提供；管理员使用管理员令牌。项目 AI Key 仅供 API 调用。</p><button class="primary" type="submit">进入工作台 →</button><p class="hint">仅支持 HTTPS。登录凭据不会保存在浏览器存储中。</p><a href="/llm" target="_blank" rel="noopener">查看 AI API 文档 ↗</a></form></section></main>`;
}
function render() {
  if (!state.session) { root.innerHTML = loginView(); return; }
  const admin = state.session.role === 'admin';
  const userName = admin ? '管理员' : state.session.user.name;
  root.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand">co<span>·</span>ai</div><div><p class="nav-label">工作空间</p><nav><button class="active" data-action="home">${admin ? '用户管理' : '我的项目'}</button><a href="/llm" target="_blank" rel="noopener"><button type="button">AI API 文档 ↗</button></a></nav></div><div class="sidebar-bottom">每个项目，独立的协作空间。<br>co-ai · HTTPS 安全连接</div></aside><div class="workspace"><header class="topbar"><span class="muted">${admin ? '管理控制台' : '协作工作台'}</span><div class="user-meta"><span class="avatar">${e(userName.slice(0, 1))}</span><span>${e(userName)}</span><button class="small" data-action="logout">退出</button></div></header><main class="main">${admin ? adminView() : state.project ? projectView() : projectsView()}</main></div></div>`;
}
function adminView() {
  const users = state.users.filter((u) => (u.name + u.email).toLowerCase().includes(state.query.toLowerCase()));
  return `<div class="heading"><div><div class="eyebrow">Administration</div><h1>用户管理</h1><p>为团队分配独立的项目空间，管理访问权限。</p></div><button class="primary" data-action="create-user">＋ 创建用户</button></div><div class="stats"><span><strong>${state.users.length}</strong>位用户</span><span><strong>${state.users.filter((u) => !u.disabled_at).length}</strong>位启用</span></div><input class="search" id="user-search" type="search" placeholder="搜索姓名或邮箱" aria-label="搜索用户" value="${e(state.query)}">${users.length ? `<div class="table-wrap"><table><thead><tr><th>用户</th><th>状态</th><th>项目</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${users.map((u) => `<tr><td><strong>${e(u.name)}</strong><span class="hint">${e(u.email)}</span></td><td><span class="badge ${u.disabled_at ? 'off' : ''}">${u.disabled_at ? '已停用' : '正常'}</span></td><td>${u.project_count}</td><td>${date(u.created_at)}</td><td><div class="table-actions"><button class="small" data-action="edit-user" data-id="${e(u.id)}">编辑</button><button class="small ${u.disabled_at ? '' : 'danger'}" data-action="toggle-user" data-id="${e(u.id)}">${u.disabled_at ? '启用' : '停用'}</button><button class="small" data-action="reset-user" data-id="${e(u.id)}">重置 Key</button></div></td></tr>`).join('')}</tbody></table></div>` : empty('还没有用户', '创建首位用户，再把用户 Key 安全交给对方。')}`;
}
function empty(title, text) { return `<div class="empty"><h2>${e(title)}</h2><p>${e(text)}</p></div>`; }
function projectsView() {
  return `<div class="heading"><div><div class="eyebrow">Your workspace</div><h1>我的项目</h1><p>从一个共同目标开始，为 AI 准备清晰的协作上下文。</p></div><button class="primary" data-action="create-project">＋ 新建项目</button></div><div class="stats"><span><strong>${state.projects.filter((p) => !p.archived_at).length}</strong>个进行中</span><span><strong>${state.projects.filter((p) => p.archived_at).length}</strong>个已归档</span></div>${state.projects.length ? `<div class="grid">${state.projects.map((p) => `<article class="card project-card"><div><span class="badge ${p.archived_at ? 'off' : ''}">${p.archived_at ? '已归档' : '协作中'}</span></div><h2>${e(p.name)}</h2><p>${e(p.description.slice(0, 180) || '添加项目介绍，让协作者快速了解目标。')}</p><div class="card-bottom"><span class="hint">${date(p.created_at)}</span><button class="small" data-action="open-project" data-id="${e(p.id)}">打开项目 →</button></div></article>`).join('')}</div>` : empty('创建你的第一个项目', '每个项目都有独立的信息列表、AI 规则和专用 Key。')}`;
}
function projectView() {
  const p = state.project;
  return `<button class="back" data-action="home">← 返回我的项目</button><div class="heading"><div><div class="eyebrow">Project workspace</div><h1>${e(p.name)}</h1><p>${e(p.description.slice(0, 160) || '项目协作空间')}</p></div><div class="actions"><button data-action="edit-project">编辑项目</button><button class="${p.archived_at ? '' : 'danger'}" data-action="archive-project">${p.archived_at ? '恢复项目' : '归档项目'}</button></div></div>${p.archived_at ? '<div class="archived-note">项目已归档，项目 AI Key 暂时无法访问。恢复项目后可继续协作；现有信息与附件会保留。</div>' : ''}<div class="tabs" role="tablist">${Object.entries({ overview: '项目概览', items: '信息列表', keys: 'AI Key', files: '附件' }).map(([id, label]) => `<button role="tab" aria-selected="${state.tab === id}" class="${state.tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}">${label}</button>`).join('')}</div>${state.tab === 'overview' ? overviewView() : state.tab === 'items' ? itemsView() : state.tab === 'keys' ? keysView() : filesView()}`;
}
function overviewView() {
  const p = state.project;
  return `<div class="detail-grid"><section class="card"><h2>AI 协作规则</h2><div class="prose">${e(p.instructions || '尚未设置规则。编辑项目，告诉 AI 项目目标、约束和协作方式。')}</div></section><section class="card"><h2>连接你的 AI</h2><p class="hint">为每位 AI 创建项目专用 Key，再提供以下项目入口。Key 仅可访问此项目。</p><div class="inset mono">${e(location.origin + base() + '/llm')}</div><p class="hint">请求头：Authorization: Bearer &lt;API_KEY&gt;</p><button data-action="tab" data-tab="keys">管理 AI Key →</button><p class="hint">项目 ID</p><div class="mono">${e(p.id)}</div></section><section class="card"><h2>项目介绍</h2><div class="prose">${e(p.description || '尚未填写介绍。')}</div></section><section class="card"><h2>协作方式</h2><div class="prose">笔记保存背景，任务记录下一步，决策保存结论，消息传递协作进展。\n信息更新带版本校验，多位协作者同时编辑时不会静默覆盖。</div></section></div>`;
}
function itemsView() {
  return `<div class="heading"><p>${state.items.length} 条项目信息</p><div class="actions"><button data-action="refresh">刷新</button><button class="primary" data-action="create-item">＋ 添加信息</button></div></div>${state.items.length ? `<div class="item-list">${state.items.map((item) => `<article class="card"><div class="item-head"><div><h2>${e(item.title)}</h2><div class="item-tags"><span class="badge off">${kinds[item.kind]}</span><span class="badge">${statuses[item.status]}</span></div></div><div class="actions"><button class="small" data-action="edit-item" data-id="${e(item.id)}">编辑</button><button class="small danger" data-action="delete-item" data-id="${e(item.id)}">删除</button></div></div><div class="item-content">${e(item.content)}</div><div class="item-footer">更新于 ${date(item.updated_at)} · 版本 ${item.version}</div></article>`).join('')}</div>` : empty('还没有信息', '添加一条笔记或任务，也可以让 AI 通过 API 写入。')}`;
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
    case 'create-user': modal('创建用户', field('姓名', 'name', '', 'text', 200, true) + field('邮箱', 'email', '', 'email', 254, true), 'user'); break;
    case 'edit-user': {
      const user = state.users.find((u) => u.id === id);
      modal('编辑用户', field('姓名', 'name', user.name, 'text', 200, true) + field('邮箱', 'email', user.email, 'email', 254, true), 'user', id); break;
    }
    case 'toggle-user': {
      const user = state.users.find((u) => u.id === id);
      if (!user.disabled_at && !confirm(`停用「${user.name}」？所有登录会话和 API 访问将立即失效。`)) break;
      await api('/api/admin/users/' + id, { method: 'PATCH', body: { disabled: !user.disabled_at } }); await loadHome(); toast('用户状态已更新'); break;
    }
    case 'reset-user': {
      if (!confirm('重置将撤销该用户的所有用户 Key、项目 AI Key 和登录会话。确定继续？')) break;
      const result = await api('/api/admin/users/' + id + '/reset-key', { method: 'POST' });
      showSecret('用户 Key 已重置', result.data.api_key, '请把新的用户 Key 安全提供给用户。已有 AI Key 已撤销，需要重新创建。'); break;
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
      modal(item.id ? '编辑信息' : '添加信息', field('标题', 'title', item.title, 'text', 200, true) + `<div class="form-row"><div><label class="field" for="field-kind">类型</label><select id="field-kind" name="kind">${Object.entries(kinds).map(([v, label]) => `<option value="${v}" ${v === item.kind ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div><label class="field" for="field-status">状态</label><select id="field-status" name="status">${Object.entries(statuses).map(([v, label]) => `<option value="${v}" ${v === item.status ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>` + textField('正文', 'content', item.content, 50000), 'item', item.id, item.version); break;
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
  if (!form.matches('#login-form, #upload-form, [data-form]')) return;
  event.preventDefault();
  const submit = form.querySelector('[type=submit]');
  if (submit.disabled) return;
  submit.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'login-form') {
      await api('/api/web/login', { method: 'POST', body: values });
      form.reset(); state.session = (await api('/api/web/session')).data; await loadHome();
    } else if (form.id === 'upload-form') {
      const file = values.file;
      if (file.size > 10 * 1024 * 1024) throw new Error('附件不能超过 10 MiB');
      await api(base() + '/attachments?filename=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      await loadProject(state.project.id, 'files'); toast('附件已上传');
    } else {
      const id = form.dataset.id;
      switch (form.dataset.form) {
        case 'user': {
          const result = await api('/api/admin/users' + (id ? '/' + id : ''), { method: id ? 'PATCH' : 'POST', body: values });
          dialog.close(); await loadHome();
          if (!id) showSecret('用户已创建', result.data.key.api_key, '把这个用户 Key 安全交给新用户，对方可在登录页选择「用户」登录。');
          else toast('用户已更新'); break;
        }
        case 'project': {
          const result = await api('/api/v1/projects' + (id ? '/' + id : ''), { method: id ? 'PATCH' : 'POST', body: values });
          dialog.close(); await loadProject(result.data.id); toast(id ? '项目已更新' : '项目已创建'); break;
        }
        case 'item': {
          if (id) values.version = Number(form.dataset.version);
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
document.addEventListener('input', (event) => {
  if (event.target.id === 'user-search') {
    const pos = event.target.selectionStart; state.query = event.target.value; render();
    const input = document.querySelector('#user-search'); input.focus(); input.setSelectionRange(pos, pos);
  }
});
dialog.addEventListener('close', () => { if (!dialog.open) dialog.replaceChildren(); });
try { state.session = (await api('/api/web/session')).data; await loadHome(); }
catch (error) { render(); if (state.session) toast(error.message, true); }
