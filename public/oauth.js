const root = document.querySelector('#oauth-app');
const requestId = root.dataset.request;
let details;
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const scopeNames = { read: '读取所选项目的信息、角色和附件', write: '读取、创建、修改和删除所选项目的信息及附件', manage: '管理你的全部项目、角色和 API Key，并读写项目内容', admin: '管理全部用户，包括创建、停用、修改登录凭据和重置用户 Key' };
async function api(path, input) {
  const response = await fetch(path, { credentials: 'same-origin', ...(input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}) });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(result.error_description ?? result.error?.message ?? '请求失败');
  return result;
}
function render() {
  const manage = details.scope.split(' ').includes('manage'), admin = details.scope === 'admin';
  root.innerHTML = `<section class="card"><div class="brand">co<span>·</span>ai</div><h1>允许应用访问你的账户？</h1><p><strong>${escape(details.client_name)}</strong> 请求以下权限：</p><ul>${details.scope.split(' ').map((scope) => `<li>${scopeNames[scope]}</li>`).join('')}</ul><p class="hint">回调地址</p><p class="mono oauth-uri">${escape(details.redirect_uri)}</p><p class="hint">授权目标</p><p class="mono oauth-uri">${escape(details.resource)}</p>${details.actor ? `<p>当前账户：<strong>${escape(details.actor.name)}</strong></p><button id="switch-account" class="small" type="button">切换账户</button><form id="consent-form">${admin || manage ? '' : `<label class="field" for="project">选择允许访问的项目</label><select id="project" required><option value="">请选择项目</option>${details.projects.map((project) => `<option value="${escape(project.id)}">${escape(project.name)}</option>`).join('')}</select>`}<p class="hint">仅在你信任此应用时授权。你可以随时撤销访问权限。</p><div class="oauth-actions"><button class="primary" type="submit" value="approve">允许访问</button><button type="submit" value="deny" formnovalidate>拒绝</button></div></form>` : `<p>请先登录，再选择授权范围。</p><form id="oauth-login"><label class="field" for="login-mode">登录方式</label><select id="login-mode"><option value="password">用户名密码</option><option value="key">用户 Key</option><option value="admin">管理员令牌</option></select><div id="password-fields"><label class="field" for="username">用户名</label><input id="username" autocomplete="username" required maxlength="64"><label class="field" for="password">密码</label><input id="password" type="password" autocomplete="current-password" required maxlength="256"></div><div id="key-fields" hidden><label class="field" for="credential">登录凭据</label><input id="credential" type="password" autocomplete="off" disabled maxlength="256"></div><button class="primary" type="submit">登录并继续</button></form>`}<p id="oauth-error" role="alert" class="oauth-error" hidden></p><a href="/llm" target="_blank" rel="noopener noreferrer">查看 API 和授权说明</a></section>`;
}
function showError(error) {
  const target = document.querySelector('#oauth-error');
  target.textContent = error.message; target.hidden = false;
}
async function load() {
  details = (await api('/oauth/requests/' + requestId)).data;
  render();
}
root.addEventListener('change', (event) => {
  if (event.target.id !== 'login-mode') return;
  const passwordMode = event.target.value === 'password';
  document.querySelector('#password-fields').hidden = !passwordMode;
  document.querySelector('#key-fields').hidden = passwordMode;
  for (const id of ['username', 'password']) {
    const input = document.getElementById(id); input.disabled = !passwordMode; input.required = passwordMode; input.value = '';
  }
  const credential = document.querySelector('#credential');
  credential.disabled = passwordMode; credential.required = !passwordMode; credential.value = '';
});
root.addEventListener('click', async (event) => {
  if (event.target.id !== 'switch-account') return;
  try { await api('/api/web/logout', {}); await load(); } catch (error) { showError(error); }
});
root.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    if (event.target.id === 'oauth-login') {
      const mode = document.querySelector('#login-mode').value;
      const input = mode === 'password' ? { role: 'user', username: document.querySelector('#username').value, password: document.querySelector('#password').value }
        : { role: mode === 'admin' ? 'admin' : 'user', credential: document.querySelector('#credential').value };
      await api('/api/web/login', input); event.target.reset(); await load();
    } else if (event.target.id === 'consent-form') {
      const result = await api('/oauth/consent', { request_id: requestId, decision: submit.value, project_id: document.querySelector('#project')?.value || null });
      location.assign(result.data.redirect);
    }
  } catch (error) { showError(error); }
  finally { if (submit) submit.disabled = false; }
});
try { await load(); }
catch (error) { root.replaceChildren(); const panel = document.createElement('section'); panel.className = 'card'; const title = document.createElement('h1'); title.textContent = '无法继续授权'; const message = document.createElement('p'); message.textContent = error.message; panel.append(title, message); root.append(panel); }
