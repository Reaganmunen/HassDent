(function () {
  'use strict';
  const { api, Session } = HD;
  const { shell, fmt } = HD;
  const { esc, num, money } = fmt;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ auth & greeting
  const user = Session.user() || {};
  $('greeting').textContent = `${fmt.greeting()}, ${String(user.name || '').split(' ')[0] || 'there'} · ` +
    fmt.dayLabel(fmt.today(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // ------------------------------------------------------------------ toast
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

  // ------------------------------------------------------------------ state
  const state = {
    editingId: null,
    customers: [],
    total: 0,
    search: '',
    groupFilter: '',
    groups: [],
    page: 1,
    limit: 30,
  };

  // ------------------------------------------------------------------ load customer groups
  async function loadGroups() {
    try {
      const groups = await api('/customer-groups');
      state.groups = groups || [];
      const sel = $('customer_group_id');
      const filterSel = $('filter-group');
      const curVal = sel.value;
      const curFilter = filterSel.value;
      sel.innerHTML = '<option value="">— Default —</option>' +
        state.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
      filterSel.innerHTML = '<option value="">All groups</option>' +
        state.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
      sel.value = curVal;
      filterSel.value = curFilter;
    } catch (e) { /* groups optional */ }
  }

  // ------------------------------------------------------------------ render list
  function renderCustomers() {
    const el = $('customer-list-body');
    const items = state.customers;
    if (!items.length) {
      el.innerHTML = '<div class="state-box"><i class="ph-duotone ph-users"></i><div>No customers found. Add your first customer above.</div></div>';
      $('customer-count').textContent = '0';
      return;
    }
    $('customer-count').textContent = state.total || items.length;

    const rows = items.map(c => {
      const activeDot = c.is_active ? '<span class="status-dot"></span>' : '<span class="status-dot inactive"></span>';
      const org = c.organization_name ? `<small>${esc(c.organization_name)}</small>` : '';
      const group = c.group_name
        ? `<span class="pill" style="background:#f0f0ec;color:var(--hd-ink);font-size:.66rem;">${esc(c.group_name)}</span>`
        : '';
      const credit = c.credit_limit ? money(c.credit_limit) : '—';
      const visits = c.visit_count ? num(c.visit_count) : '0';
      const spent = c.total_spent ? money(c.total_spent) : '—';

      return `<tr data-id="${c.id}">
        <td>
          <div class="cell-main">
            <span class="thumb"><i class="ph-duotone ph-user"></i></span>
            <div>
              <b>${esc(c.full_name)}</b>
              ${org}
              <div style="margin-top:3px;">${group}</div>
            </div>
          </div>
        </td>
        <td style="white-space:nowrap;">${esc(c.phone || '—')}</td>
        <td class="trunc">${esc(c.email || '—')}</td>
        <td style="white-space:nowrap;">${activeDot} ${c.is_active ? 'Active' : 'Inactive'}</td>
        <td class="num">${credit}</td>
        <td class="num">${visits}</td>
        <td class="num">${spent}</td>
        <td>
          <div class="action-btns">
            <button class="icon-btn-sm edit-btn" data-id="${c.id}" title="Edit"><i class="ph-bold ph-pencil-simple"></i> Edit</button>
            <button class="icon-btn-sm danger deactivate-btn" data-id="${c.id}" data-name="${esc(c.full_name)}" title="Deactivate"><i class="ph-bold ph-prohibit"></i></button>
          </div>
        </td>
      </tr>`;
    }).join('');

    el.innerHTML = `<div class="tbl-wrap customer-table">
      <table class="tbl">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Phone</th>
            <th>Email</th>
            <th>Status</th>
            <th class="num">Credit limit</th>
            <th class="num">Visits</th>
            <th class="num">Total spent</th>
            <th style="width:140px;">Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  // ------------------------------------------------------------------ fetch
  async function fetchCustomers() {
    try {
      const params = new URLSearchParams();
      if (state.search) params.set('search', state.search);
      if (state.groupFilter) params.set('group_id', state.groupFilter);
      params.set('limit', state.limit);
      params.set('offset', (state.page - 1) * state.limit);
      const res = await api(`/customers?${params.toString()}`);
      const items = Array.isArray(res) ? res : (res.items || []);
      state.customers = items;
      state.total = Array.isArray(res) ? items.length : (res.total || items.length);
      renderCustomers();
    } catch (err) {
      $('customer-list-body').innerHTML =
        `<div class="state-box"><i class="ph-duotone ph-warning-circle"></i><div>${esc(err.message)}</div><button class="retry" id="retry-load">Try again</button></div>`;
      const retry = $('retry-load');
      if (retry) retry.addEventListener('click', fetchCustomers);
    }
  }

  // ------------------------------------------------------------------ edit
  async function editCustomer(id) {
    try {
      const c = await api(`/customers/${id}`);
      $('customer-id').value = c.id;
      $('full_name').value = c.full_name || '';
      $('customer_type').value = c.customer_type || 'individual';
      $('organization_name').value = c.organization_name || '';
      $('phone').value = c.phone || '';
      $('alt_phone').value = c.alt_phone || '';
      $('email').value = c.email || '';
      $('address').value = c.address || '';
      $('customer_group_id').value = c.customer_group_id || '';
      $('credit_limit').value = c.credit_limit || 0;
      $('is_active').checked = c.is_active !== false;
      $('show_on_checkin').checked = false;
      $('note').value = '';
      state.editingId = id;
      $('form-mode-badge').hidden = false;
      $('save-label').textContent = 'Update customer';
      $('btn-cancel').hidden = false;
      $('add-customer-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ------------------------------------------------------------------ reset
  function resetForm() {
    $('customer-form').reset();
    $('customer-id').value = '';
    $('credit_limit').value = '0';
    $('is_active').checked = true;
    $('show_on_checkin').checked = false;
    state.editingId = null;
    $('form-mode-badge').hidden = true;
    $('save-label').textContent = 'Save customer';
    $('btn-cancel').hidden = true;
  }

  // ------------------------------------------------------------------ save
  async function saveCustomer(e) {
    e.preventDefault();
    const btn = $('btn-save');
    btn.disabled = true;

    const fullName = $('full_name').value.trim();
    const phone = $('phone').value.trim();
    if (!fullName) { toast('Full name is required', true); btn.disabled = false; return; }
    if (!phone) { toast('Phone number is required', true); btn.disabled = false; return; }

    const payload = {
      full_name: fullName,
      customer_type: $('customer_type').value,
      organization_name: $('organization_name').value.trim() || null,
      phone,
      alt_phone: $('alt_phone').value.trim() || null,
      email: $('email').value.trim() || null,
      address: $('address').value.trim() || null,
      credit_limit: Number($('credit_limit').value) || 0,
      is_active: $('is_active').checked,
    };
    const gid = $('customer_group_id').value;
    if (gid) payload.customer_group_id = Number(gid);

    try {
      if (state.editingId) {
        await api(`/customers/${state.editingId}`, { method: 'PATCH', body: payload });
        toast('Customer updated');
      } else {
        const created = await api('/customers', { method: 'POST', body: payload });
        toast('Customer created');
        const note = $('note').value.trim();
        if (note && created && created.id) {
          await api(`/customers/${created.id}/notes`, {
            method: 'POST',
            body: { note, show_on_checkin: $('show_on_checkin').checked },
          });
        }
      }
      resetForm();
      await fetchCustomers();
      await loadGroups();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------ deactivate
  async function deactivateCustomer(id, name) {
    if (!confirm(`Deactivate ${name}? They will no longer appear in active lists.`)) return;
    try {
      await api(`/customers/${id}`, { method: 'DELETE' });
      toast('Customer deactivated');
      await fetchCustomers();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ------------------------------------------------------------------ clear filters
  function clearFilters() {
    $('search-input').value = '';
    $('filter-group').value = '';
    state.search = '';
    state.groupFilter = '';
    state.page = 1;
    fetchCustomers();
  }

  // ------------------------------------------------------------------ wiring
  $('customer-form').addEventListener('submit', saveCustomer);
  $('btn-cancel').addEventListener('click', resetForm);

  $('btn-refresh').addEventListener('click', () => {
    const icon = $('btn-refresh').querySelector('i');
    icon.classList.add('spin');
    loadGroups().then(fetchCustomers).finally(() => icon.classList.remove('spin'));
  });

  let searchTimer;
  $('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim();
      state.page = 1;
      fetchCustomers();
    }, 320);
  });

  $('filter-group').addEventListener('change', (e) => {
    state.groupFilter = e.target.value;
    state.page = 1;
    fetchCustomers();
  });

  $('btn-clear-filters').addEventListener('click', clearFilters);

  $('customer-list-body').addEventListener('click', (e) => {
    const editBtn = e.target.closest('.edit-btn');
    if (editBtn && editBtn.dataset.id) { editCustomer(Number(editBtn.dataset.id)); return; }
    const deactBtn = e.target.closest('.deactivate-btn');
    if (deactBtn && deactBtn.dataset.id) {
      deactivateCustomer(Number(deactBtn.dataset.id), deactBtn.dataset.name || 'this customer');
    }
  });

  // ------------------------------------------------------------------ boot
  (async function init() {
    await loadGroups();
    await fetchCustomers();
  })();

  if (shell.refreshNotifications) shell.refreshNotifications();
})();