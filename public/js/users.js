(function () {
  'use strict';
  const { api, Session } = HD;
  const { shell, fmt } = HD;
  const { esc } = fmt;
  const $ = (id) => document.getElementById(id);

  const user = Session.user() || {};
  $('greeting').textContent = `${fmt.greeting()}, ${String(user.name || '').split(' ')[0] || 'there'} · ` +
    fmt.dayLabel(fmt.today(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  let toastTimer;
  function toast(msg, isError) {
    const el = $('toast');
    $('toast-text').textContent = msg;
    el.classList.toggle('error', !!isError);
    el.querySelector('i').className = isError ? 'ph-duotone ph-warning-circle' : 'ph-duotone ph-check-circle';
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  const state = { editingId: null, users: [], roles: [], onlyActive: false };

  async function loadRoles() {
    try {
      state.roles = await api('/roles');
      const sel = $('role_id');
      const cur = sel.value;
      sel.innerHTML = '<option value="">— Select a role —</option>' +
        state.roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
      sel.value = cur;
    } catch (err) { console.warn('Could not load roles:', err.message); }
  }

  function renderUsers() {
    const el = $('user-list-body');
    const items = state.users;
    $('user-count').textContent = items.length;
    if (!items.length) { el.innerHTML = '<div class="state-box"><i class="ph-duotone ph-users"></i><div>No users found.</div></div>'; return; }

    const rows = items.map((u) => {
      const activeDot = u.is_active ? '<span class="status-dot"></span>' : '<span class="status-dot inactive"></span>';
      const roleClass = (u.role || '').replace(/\s+/g, '_');
      const lastLogin = u.last_login_at ? fmt.when(u.last_login_at) : 'Never';
      const isSelf = user.id === u.id;
      const deactBtn = (!u.is_active || isSelf) ? '' :
        `<button class="icon-btn-sm danger deactivate-btn" data-id="${u.id}" data-name="${esc(u.name)}" title="Deactivate"><i class="ph-bold ph-prohibit"></i></button>`;
      return `<tr data-id="${u.id}">
        <td><div class="cell-main"><span class="thumb"><i class="ph-duotone ph-user"></i></span><div>
          <b>${esc(u.name)}${isSelf ? ' <span style="color:var(--hd-muted);font-weight:500;font-size:.72rem">(you)</span>' : ''}</b>
          <small>${esc(u.email)}</small>
        </div></div></td>
        <td>${esc(u.phone || '—')}</td>
        <td><span class="role-pill ${roleClass}">${esc(u.role || '—')}</span></td>
        <td>${activeDot} ${u.is_active ? 'Active' : 'Inactive'}</td>
        <td style="white-space:nowrap;">${lastLogin}</td>
        <td><div class="action-btns">
          <button class="icon-btn-sm edit-btn" data-id="${u.id}"><i class="ph-bold ph-pencil-simple"></i> Edit</button>
          ${deactBtn}
        </div></td>
      </tr>`;
    }).join('');

    el.innerHTML = `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>User</th><th>Phone</th><th>Role</th><th>Status</th><th>Last login</th><th style="width:140px;">Actions</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  async function fetchUsers() {
    try {
      const q = state.onlyActive ? '?active=true' : '';
      const res = await api(`/users${q}`);
      state.users = Array.isArray(res) ? res : (res.items || []);
      renderUsers();
    } catch (err) {
      $('user-list-body').innerHTML = `<div class="state-box"><i class="ph-duotone ph-warning-circle"></i><div>${esc(err.message)}</div><button class="retry" id="retry-load">Try again</button></div>`;
      const r = $('retry-load'); if (r) r.addEventListener('click', fetchUsers);
    }
  }

  async function editUser(id) {
    try {
      const u = await api(`/users/${id}`);
      $('user-id').value = u.id;
      $('name').value = u.name || '';
      $('email').value = u.email || '';
      $('phone').value = u.phone || '';
      $('role_id').value = u.role_id || '';
      $('is_active').checked = u.is_active !== false;
      $('password').value = '';
      $('password').required = false;
      $('password-hint').textContent = '(leave blank to keep)';
      $('password-help').textContent = 'Leave blank to keep the current password.';
      state.editingId = id;
      $('form-mode-badge').hidden = false;
      $('save-label').textContent = 'Update user';
      $('btn-cancel').hidden = false;
      $('user-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) { toast(err.message, true); }
  }

  function resetForm() {
    $('user-form').reset();
    $('user-id').value = '';
    $('is_active').checked = true;
    $('password').required = true;
    $('password-hint').textContent = '*';
    $('password-help').textContent = 'Minimum 8 characters.';
    state.editingId = null;
    $('form-mode-badge').hidden = true;
    $('save-label').textContent = 'Create user';
    $('btn-cancel').hidden = true;
  }

  async function saveUser(e) {
    e.preventDefault();
    const btn = $('btn-save');
    btn.disabled = true;

    const name = $('name').value.trim();
    const email = $('email').value.trim();
    const password = $('password').value;
    const role_id = $('role_id').value;

    if (!name) { toast('Name is required', true); btn.disabled = false; return; }
    if (!email) { toast('Email is required', true); btn.disabled = false; return; }
    if (!role_id) { toast('Please select a role', true); btn.disabled = false; return; }
    if (!state.editingId && !password) { toast('Password is required for new users', true); btn.disabled = false; return; }

    const payload = { name, email, phone: $('phone').value.trim() || null, role_id: Number(role_id), is_active: $('is_active').checked };
    if (password) payload.password = password;

    try {
      if (state.editingId) { await api(`/users/${state.editingId}`, { method: 'PATCH', body: payload }); toast('User updated'); }
      else { await api('/users', { method: 'POST', body: payload }); toast('User created'); }
      resetForm();
      await fetchUsers();
    } catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; }
  }

  async function deactivateUser(id, name) {
    if (!confirm(`Deactivate ${name}? They will no longer be able to log in.`)) return;
    try {
      await api(`/users/${id}`, { method: 'DELETE' });
      toast('User deactivated');
      await fetchUsers();
    } catch (err) { toast(err.message, true); }
  }

  $('user-form').addEventListener('submit', saveUser);
  $('btn-cancel').addEventListener('click', resetForm);
  $('only-active').addEventListener('change', (e) => { state.onlyActive = e.target.checked; fetchUsers(); });
  $('btn-refresh').addEventListener('click', () => {
    const icon = $('btn-refresh').querySelector('i');
    icon.classList.add('spin');
    Promise.all([loadRoles(), fetchUsers()]).finally(() => icon.classList.remove('spin'));
  });
  $('user-list-body').addEventListener('click', (e) => {
    const eb = e.target.closest('.edit-btn');
    if (eb && eb.dataset.id) { editUser(Number(eb.dataset.id)); return; }
    const db = e.target.closest('.deactivate-btn');
    if (db && db.dataset.id) deactivateUser(Number(db.dataset.id), db.dataset.name || 'this user');
  });

  (async function init() { await loadRoles(); await fetchUsers(); })();
  if (shell.refreshNotifications) shell.refreshNotifications();
})();