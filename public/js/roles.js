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

  const state = { editingId: null, roles: [], permissions: [] };

  // ------------------------------------------------------------------ permissions grid
  function renderPermGrid(selected = []) {
    const el = $('perm-grid');
    if (!state.permissions.length) {
      el.innerHTML = '<div class="state-box"><i class="ph-duotone ph-key"></i><div>No permissions defined.</div></div>';
      return;
    }
    const selSet = new Set(selected);
    el.innerHTML = state.permissions.map((p) => {
      const checked = selSet.has(p.code);
      return `<label class="perm-row ${checked ? 'checked' : ''}" data-code="${esc(p.code)}">
        <input type="checkbox" value="${esc(p.code)}" ${checked ? 'checked' : ''}>
        <div>
          <div class="code">${esc(p.code)}</div>
          <div class="desc">${esc(p.description || '')}</div>
        </div>
      </label>`;
    }).join('');
  }

  function selectedPerms() {
    return Array.from($('perm-grid').querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value);
  }

  // ------------------------------------------------------------------ roles list
  function renderRoles() {
    const el = $('roles-body');
    $('role-count').textContent = state.roles.length;
    if (!state.roles.length) {
      el.innerHTML = '<div class="state-box"><i class="ph-duotone ph-shield"></i><div>No roles yet.</div></div>';
      return;
    }
    el.innerHTML = state.roles.map((r) => {
      const perms = r.permissions || [];
      return `<div class="role-card" data-id="${r.id}">
        <div class="head">
          <h3>${esc(r.name)}</h3>
          ${perms.length >= state.permissions.length ? '<span class="badge">full access</span>' : ''}
          <div class="actions">
            <button class="icon-btn-sm edit-btn" data-id="${r.id}"><i class="ph-bold ph-pencil-simple"></i> Edit</button>
            <button class="icon-btn-sm danger delete-btn" data-id="${r.id}" data-name="${esc(r.name)}"><i class="ph-bold ph-trash"></i></button>
          </div>
        </div>
        <div class="desc">${esc(r.description || 'No description')}</div>
        <div class="perm-chips">${perms.length
          ? perms.map((p) => `<span class="chip">${esc(p)}</span>`).join('')
          : '<span class="chip" style="opacity:.5">no permissions</span>'}</div>
      </div>`;
    }).join('');
  }

  async function loadAll() {
    try {
      const [roles, perms] = await Promise.all([api('/roles'), api('/permissions')]);
      state.roles = roles;
      state.permissions = perms;
      renderRoles();
      if (!state.editingId) renderPermGrid([]);
    } catch (err) {
      $('roles-body').innerHTML = `<div class="state-box"><i class="ph-duotone ph-warning-circle"></i><div>${esc(err.message)}</div></div>`;
    }
  }

  // ------------------------------------------------------------------ form
  function resetForm() {
    $('role-form').reset();
    $('role-id').value = '';
    state.editingId = null;
    $('form-mode-badge').hidden = true;
    $('save-label').textContent = 'Create role';
    $('btn-cancel').hidden = true;
    renderPermGrid([]);
  }

  function editRole(id) {
    const r = state.roles.find((x) => x.id === id);
    if (!r) return;
    $('role-id').value = r.id;
    $('role-name').value = r.name;
    $('role-description').value = r.description || '';
    state.editingId = id;
    $('form-mode-badge').hidden = false;
    $('save-label').textContent = 'Update role';
    $('btn-cancel').hidden = false;
    renderPermGrid(r.permissions || []);
    $('role-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function saveRole(e) {
    e.preventDefault();
    const btn = $('btn-save');
    btn.disabled = true;

    const name = $('role-name').value.trim().toLowerCase().replace(/\s+/g, '_');
    if (!name) { toast('Role name is required', true); btn.disabled = false; return; }
    if (!/^[a-z][a-z0-9_]*$/.test(name)) { toast('Role name must be lowercase letters, digits, underscores', true); btn.disabled = false; return; }

    const payload = {
      name,
      description: $('role-description').value.trim() || null,
      permissions: selectedPerms(),
    };

    try {
      if (state.editingId) {
        await api(`/roles/${state.editingId}`, { method: 'PATCH', body: payload });
        toast('Role updated');
      } else {
        await api('/roles', { method: 'POST', body: payload });
        toast('Role created');
      }
      resetForm();
      await loadAll();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteRole(id, name) {
    if (!confirm(`Delete role "${name}"? This cannot be undone.`)) return;
    try {
      await api(`/roles/${id}`, { method: 'DELETE' });
      toast('Role deleted');
      await loadAll();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ------------------------------------------------------------------ wiring
  $('role-form').addEventListener('submit', saveRole);
  $('btn-cancel').addEventListener('click', resetForm);

  $('perm-grid').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const row = cb.closest('.perm-row');
    if (row) row.classList.toggle('checked', cb.checked);
  });

  $('toggle-all-perms').addEventListener('click', () => {
    const boxes = $('perm-grid').querySelectorAll('input[type="checkbox"]');
    const anyUnchecked = Array.from(boxes).some((b) => !b.checked);
    boxes.forEach((b) => {
      b.checked = anyUnchecked;
      const row = b.closest('.perm-row');
      if (row) row.classList.toggle('checked', b.checked);
    });
  });

  $('roles-body').addEventListener('click', (e) => {
    const eb = e.target.closest('.edit-btn');
    if (eb && eb.dataset.id) { editRole(Number(eb.dataset.id)); return; }
    const db = e.target.closest('.delete-btn');
    if (db && db.dataset.id) deleteRole(Number(db.dataset.id), db.dataset.name || 'this role');
  });

  $('btn-refresh').addEventListener('click', () => {
    const icon = $('btn-refresh').querySelector('i');
    icon.classList.add('spin');
    loadAll().finally(() => icon.classList.remove('spin'));
  });

  (async function init() { await loadAll(); })();
  if (shell.refreshNotifications) shell.refreshNotifications();
})();