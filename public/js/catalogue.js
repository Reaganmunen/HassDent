(function () {
  'use strict';
  const { api } = HD;
  const { shell, fmt } = HD;
  const { esc, num } = fmt;
  const can = shell.can;
  const $ = (id) => document.getElementById(id);

  // Each entry maps 1:1 to a mountLookup() route in index.js.
  // `fields` describes the editable inputs; `columns` describes the table.
  const SECTIONS = {
    categories: {
      label: 'Categories', icon: 'ph-tree-structure', perm: 'products.manage', path: '/categories',
      columns: [{ key: 'name', label: 'Name' }],
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'parent_id', label: 'Parent category', type: 'select', optionsFrom: 'categories', optional: true },
      ],
    },
    brands: {
      label: 'Brands', icon: 'ph-tag', perm: 'products.manage', path: '/brands',
      columns: [{ key: 'name', label: 'Name' }],
      fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
    },
    units: {
      label: 'Units', icon: 'ph-ruler', perm: 'products.manage', path: '/units',
      columns: [{ key: 'name', label: 'Name' }, { key: 'abbreviation', label: 'Abbr.' }],
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'abbreviation', label: 'Abbreviation', type: 'text', required: true },
      ],
    },
    'tax-rates': {
      label: 'Tax rates', icon: 'ph-percent', perm: 'settings.manage', path: '/tax-rates', hasDefault: true,
      columns: [{ key: 'name', label: 'Name' }, { key: 'rate', label: 'Rate', fmt: (v) => `${num(v)}%` }],
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'rate', label: 'Rate (%)', type: 'number', step: '0.01', required: true },
        { key: 'is_default', label: 'Default tax rate', type: 'checkbox' },
      ],
    },
    'customer-groups': {
      label: 'Customer groups', icon: 'ph-users-four', perm: 'settings.manage', path: '/customer-groups', hasDefault: true,
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'discount_percent', label: 'Discount', fmt: (v) => `${num(v)}%` },
      ],
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'discount_percent', label: 'Discount (%)', type: 'number', step: '0.01' },
        { key: 'is_default', label: 'Default group', type: 'checkbox' },
      ],
    },
    locations: {
      label: 'Locations', icon: 'ph-storefront', perm: 'settings.manage', path: '/locations', hasDefault: true, hasActive: true,
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'type', label: 'Type' },
        { key: 'is_active', label: 'Active', fmt: (v) => (v ? 'Yes' : 'No') },
      ],
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'type', label: 'Type', type: 'select', options: ['shop', 'warehouse', 'pharmacy'] },
        { key: 'is_active', label: 'Active', type: 'checkbox' },
        { key: 'is_default', label: 'Default sales location', type: 'checkbox' },
      ],
    },
    'expense-categories': {
      label: 'Expense categories', icon: 'ph-receipt-x', perm: 'expenses.manage', path: '/expense-categories',
      columns: [{ key: 'name', label: 'Name' }],
      fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
    },
  };

  const state = { section: null, rows: [], search: '', editing: null, cache: {} };

  // ---------------------------------------------------------------- tabs
  function buildTabs() {
    const wrap = $('cat-tabs');
    const allowed = Object.entries(SECTIONS).filter(([, s]) => can(s.perm));
    if (!allowed.length) {
      wrap.innerHTML = '';
      $('cat-panel').innerHTML =
        '<div class="state-box"><i class="ph-duotone ph-lock-key"></i><div>You don\'t have permission to manage any catalogue tables.</div></div>';
      return;
    }
    wrap.innerHTML = allowed.map(([key, s]) =>
      `<button type="button" role="tab" data-tab="${key}" aria-selected="false">` +
      `<i class="ph-duotone ${s.icon}"></i>${esc(s.label)}</button>`).join('');
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]'); if (!b) return;
      selectTab(b.dataset.tab);
    });
    const hash = location.hash.replace('#', '');
    selectTab(SECTIONS[hash] && can(SECTIONS[hash].perm) ? hash : allowed[0][0]);
  }

  function selectTab(key) {
    state.section = key;
    state.search = '';
    $('cat-search').value = '';
    location.hash = key;
    document.querySelectorAll('#cat-tabs button').forEach((b) =>
      b.setAttribute('aria-selected', b.dataset.tab === key ? 'true' : 'false'));
    const s = SECTIONS[key];
    $('cat-sub').textContent = `Manage ${s.label.toLowerCase()}`;
    $('cat-new').hidden = !can(s.perm);
    loadRows();
  }

  // ---------------------------------------------------------------- list
  async function loadRows() {
    const s = SECTIONS[state.section];
    const body = $('cat-body');
    body.innerHTML = '<div class="sk sk-line"></div><div class="sk sk-line"></div><div class="sk sk-line"></div>';
    try {
      const qs = new URLSearchParams({ limit: 500 });
      if (state.search) qs.set('search', state.search);
      const rows = await api(`${s.path}?${qs}`);
      state.rows = Array.isArray(rows) ? rows : (rows.rows || []);
      state.cache[state.section] = state.rows;
      renderRows();
    } catch (err) {
      body.innerHTML = `<div class="state-box"><i class="ph-duotone ph-warning-circle"></i><div>${esc(err.message)}</div><button class="retry" type="button" id="cat-retry">Try again</button></div>`;
      $('cat-retry').addEventListener('click', loadRows);
    }
  }

  function renderRows() {
    const s = SECTIONS[state.section];
    const body = $('cat-body');
    if (!state.rows.length) {
      body.innerHTML = `<div class="state-box"><i class="ph-duotone ${s.icon}"></i><div>No ${esc(s.label.toLowerCase())} yet</div></div>`;
      return;
    }
    body.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      s.columns.map((c) => `<th>${esc(c.label)}</th>`).join('') +
      '<th class="num">Actions</th></tr></thead><tbody>' +
      state.rows.map((r) =>
        '<tr>' + s.columns.map((c) => `<td>${esc(c.fmt ? c.fmt(r[c.key]) : (r[c.key] ?? '–'))}</td>`).join('') +
        `<td class="num">
           <button class="row-act" data-edit="${r.id}" title="Edit"><i class="ph-duotone ph-pencil-simple"></i></button>
           ${s.hasDefault ? `<button class="row-act ${r.is_default ? 'on' : ''}" data-default="${r.id}" title="Set as default"><i class="ph-duotone ph-star"></i></button>` : ''}
           <button class="row-act danger" data-del="${r.id}" title="Delete"><i class="ph-duotone ph-trash"></i></button>
         </td></tr>`).join('') +
      '</tbody></table></div>';

    body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openModal(Number(b.dataset.edit))));
    body.querySelectorAll('[data-default]').forEach((b) => b.addEventListener('click', () => setDefault(Number(b.dataset.default))));
    body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => removeRow(Number(b.dataset.del))));
  }

  // ---------------------------------------------------------------- modal
  function openModal(id) {
    const s = SECTIONS[state.section];
    state.editing = id ? state.rows.find((r) => r.id === id) : null;
    $('cat-modal-title').textContent = `${state.editing ? 'Edit' : 'Add'} ${s.label.replace(/s$/, '')}`;
    $('cat-fields').innerHTML = s.fields.map((f) => fieldHtml(f)).join('');
    // Populate selects that pull options from another lookup (e.g. parent category).
    s.fields.filter((f) => f.optionsFrom).forEach((f) => {
      const sel = $('f-' + f.key);
      const opts = state.cache[f.optionsFrom] || [];
      sel.innerHTML = '<option value="">— none —</option>' +
        opts.filter((o) => !state.editing || o.id !== state.editing.id)
            .map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
      if (state.editing && state.editing[f.key] != null) sel.value = state.editing[f.key];
    });
    if (state.editing) {
      s.fields.forEach((f) => {
        const el = $('f-' + f.key); if (!el) return;
        if (f.type === 'checkbox') el.checked = !!state.editing[f.key];
        else el.value = state.editing[f.key] ?? '';
      });
    }
    new bootstrap.Modal($('cat-modal')).show();
  }

  function fieldHtml(f) {
    const id = 'f-' + f.key;
    if (f.type === 'checkbox') {
      return `<div class="form-check mb-3"><input class="form-check-input" type="checkbox" id="${id}"><label class="form-check-label" for="${id}">${esc(f.label)}</label></div>`;
    }
    if (f.type === 'select') {
      const opts = (f.options || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
      return `<div class="mb-3"><label class="form-label" for="${id}">${esc(f.label)}</label><select class="form-select" id="${id}">${opts}</select></div>`;
    }
    return `<div class="mb-3"><label class="form-label" for="${id}">${esc(f.label)}</label>` +
      `<input class="form-control" id="${id}" type="${f.type}" ${f.step ? `step="${f.step}"` : ''} ${f.required ? 'required' : ''}></div>`;
  }

  // ---------------------------------------------------------------- write ops
  async function saveRow(e) {
    e.preventDefault();
    const s = SECTIONS[state.section];
    const payload = {};
    s.fields.forEach((f) => {
      const el = $('f-' + f.key); if (!el) return;
      if (f.type === 'checkbox') payload[f.key] = el.checked;
      else if (f.type === 'number') payload[f.key] = el.value === '' ? null : Number(el.value);
      else payload[f.key] = el.value === '' ? null : el.value;
    });
    const id = state.editing && state.editing.id;
    try {
      if (id) await api(`${s.path}/${id}`, { method: 'PATCH', body: payload });
      else    await api(s.path,              { method: 'POST',  body: payload });
      bootstrap.Modal.getInstance($('cat-modal')).hide();
      await loadRows();
      HD.shell.toast?.(id ? 'Saved' : 'Added');
    } catch (err) {
      alert(err.message);
    }
  }

  async function setDefault(id) {
    const s = SECTIONS[state.section];
    if (!s.hasDefault) return;
    try { await api(`${s.path}/${id}/default`, { method: 'POST' }); await loadRows(); }
    catch (err) { alert(err.message); }
  }

  async function removeRow(id) {
    const s = SECTIONS[state.section];
    const row = state.rows.find((r) => r.id === id);
    if (!confirm(`Delete "${row?.name ?? id}"? This cannot be undone.`)) return;
    try { await api(`${s.path}/${id}`, { method: 'DELETE' }); await loadRows(); }
    catch (err) {
      // FK errors land here (e.g. category in use by products) — surface the friendly message.
      alert(err.message);
    }
  }

  // ---------------------------------------------------------------- wire up
  let searchTimer = 0;
  $('cat-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value.trim();
    searchTimer = setTimeout(() => { state.search = v; loadRows(); }, 250);
  });
  $('cat-new').addEventListener('click', () => openModal(null));
  $('cat-form').addEventListener('submit', saveRow);
  $('btn-refresh').addEventListener('click', loadRows);
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (SECTIONS[h] && can(SECTIONS[h].perm) && h !== state.section) selectTab(h);
  });

  buildTabs();
})();