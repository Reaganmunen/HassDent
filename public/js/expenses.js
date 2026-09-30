(function () {
  'use strict';
  const { api, Session } = HD;
  const { shell, fmt } = HD;
  const { esc, num, money } = fmt;
  const can = shell.can;
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
    categories: [],
    expenses: [],
    filters: { from: '', to: '', category_id: '' },
  };

  const METHODS = {
    cash: 'Cash',
    mpesa: 'M-Pesa',
    card: 'Card',
    bank_transfer: 'Bank transfer',
  };
  const METHOD_ICON = {
    cash: 'ph-money',
    mpesa: 'ph-device-mobile',
    card: 'ph-credit-card',
    bank_transfer: 'ph-bank',
  };

  // ------------------------------------------------------------------ load categories
  async function loadCategories() {
    try {
      const rows = await api('/expense-categories');
      state.categories = rows || [];
      const formSel = $('category_id');
      const filterSel = $('filter-category');
      const formVal = formSel.value;
      const filterVal = filterSel.value;
      formSel.innerHTML = '<option value="">— Select a category —</option>' +
        state.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      filterSel.innerHTML = '<option value="">All</option>' +
        state.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      formSel.value = formVal;
      filterSel.value = filterVal;
    } catch (err) {
      // Non-fatal: user may lack expenses.manage but have reports.view.
      // The form will still render, just with an empty dropdown.
      console.warn('Could not load expense categories:', err.message);
    }
  }

  // ------------------------------------------------------------------ summary strip
  async function loadSummary() {
    try {
      const rows = await api(`/expenses/summary?${qs()}`);
      const total = rows.reduce((s, r) => s + Number(r.total), 0);
      const entries = rows.reduce((s, r) => s + Number(r.entries), 0);
      const top = rows[0];

      const periodLabel = state.filters.from && state.filters.to
        ? `${fmt.dayLabel(fmt.dateKey(state.filters.from), { day: 'numeric', month: 'short' })} → ${fmt.dayLabel(fmt.dateKey(state.filters.to), { day: 'numeric', month: 'short' })}`
        : state.filters.from ? `From ${fmt.dayLabel(fmt.dateKey(state.filters.from))}`
        : state.filters.to   ? `Up to ${fmt.dayLabel(fmt.dateKey(state.filters.to))}`
        : 'All time';

      // Day count for the average
      let days = 1;
      if (state.filters.from && state.filters.to) {
        const d1 = new Date(state.filters.from), d2 = new Date(state.filters.to);
        days = Math.max(1, Math.round((d2 - d1) / 86400000) + 1);
      } else if (state.filters.from) {
        days = Math.max(1, Math.round((new Date() - new Date(state.filters.from)) / 86400000));
      } else if (state.filters.to) {
        days = Math.max(1, Math.round((new Date(state.filters.to) - new Date(0)) / 86400000));
      }

      $('sum-total').innerHTML = `<small>KES</small>${num(total)}`;
      $('sum-entries').textContent = num(entries);
      $('sum-top-cat').textContent = top ? top.category : '—';
      $('sum-top-amt').innerHTML = top ? `${money(top.total)} · ${num(top.entries)} ${top.entries === 1 ? 'entry' : 'entries'}` : '—';
      $('sum-avg').innerHTML = `<small>KES</small>${num(total / days)}`;
      $('sum-period').textContent = periodLabel;
    } catch (err) {
      // leave the zeros in place
    }
  }

  // ------------------------------------------------------------------ build query string from filters
  function qs() {
    const p = new URLSearchParams();
    if (state.filters.from) p.set('from', state.filters.from);
    if (state.filters.to) p.set('to', state.filters.to);
    if (state.filters.category_id) p.set('category_id', state.filters.category_id);
    return p.toString();
  }

  // ------------------------------------------------------------------ render list
  function renderExpenses() {
    const el = $('expense-list-body');
    const items = state.expenses;
    $('expense-count').textContent = items.length;

    if (!items.length) {
      el.innerHTML = '<div class="state-box"><i class="ph-duotone ph-receipt"></i><div>No expenses match your filters.</div></div>';
      return;
    }

    const rows = items.map((e) => {
      const method = METHODS[e.method] || e.method;
      const icon = METHOD_ICON[e.method] || 'ph-receipt';
      const ref = e.reference ? `<small>${esc(e.reference)}</small>` : '';
      const desc = e.description ? `<small>${esc(e.description)}</small>` : '';
      const dateStr = fmt.dayLabel(fmt.dateKey(e.expense_date), { day: 'numeric', month: 'short', year: 'numeric' });
      const receiptLink = e.receipt_url
        ? `<a href="${esc(e.receipt_url)}" target="_blank" rel="noopener" class="icon-btn-sm" title="Open receipt"><i class="ph-bold ph-link"></i></a>`
        : '';
      const deleteBtn = can('expenses.manage')
        ? `<button class="icon-btn-sm danger delete-btn" data-id="${e.id}" title="Delete"><i class="ph-bold ph-trash"></i></button>`
        : '';

      return `<tr data-id="${e.id}">
        <td>
          <div class="cell-main">
            <span class="thumb"><i class="ph-duotone ${icon}"></i></span>
            <div>
              <b>${esc(e.category)}</b>
              ${desc}
            </div>
          </div>
        </td>
        <td style="white-space:nowrap;">${dateStr}</td>
        <td><span class="method-pill ${e.method}">${esc(method)}</span></td>
        <td class="trunc">${ref || '<span style="color:var(--hd-muted)">—</span>'}</td>
        <td class="num"><b>${money(e.amount)}</b></td>
        <td>
          <div class="action-btns">
            ${receiptLink}
            ${deleteBtn}
          </div>
        </td>
      </tr>`;
    }).join('');

    el.innerHTML = `<div class="tbl-wrap expense-table">
      <table class="tbl">
        <thead>
          <tr>
            <th>Category / Description</th>
            <th>Date</th>
            <th>Method</th>
            <th>Reference</th>
            <th class="num">Amount</th>
            <th style="width:100px;">Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  // ------------------------------------------------------------------ fetch expenses
  async function fetchExpenses() {
    try {
      const p = new URLSearchParams(qs());
      p.set('limit', '100');
      p.set('offset', '0');
      const res = await api(`/expenses?${p.toString()}`);
      const items = Array.isArray(res) ? res : (res.items || []);
      state.expenses = items;
      renderExpenses();
    } catch (err) {
      $('expense-list-body').innerHTML =
        `<div class="state-box"><i class="ph-duotone ph-warning-circle"></i><div>${esc(err.message)}</div><button class="retry" id="retry-load">Try again</button></div>`;
      const r = $('retry-load');
      if (r) r.addEventListener('click', fetchExpenses);
    }
  }

  // ------------------------------------------------------------------ save expense
  async function saveExpense(e) {
    e.preventDefault();
    const btn = $('btn-save');
    btn.disabled = true;

    const categoryId = $('category_id').value;
    const amount = $('amount').value;
    if (!categoryId) { toast('Please select a category', true); btn.disabled = false; return; }
    if (!amount || Number(amount) <= 0) { toast('Amount must be greater than zero', true); btn.disabled = false; return; }

    const payload = {
      category_id: Number(categoryId),
      amount: Number(amount),
      method: $('method').value,
    };
    const expenseDate = $('expense_date').value;
    if (expenseDate) payload.expense_date = expenseDate;
    const ref = $('reference').value.trim();
    if (ref) payload.reference = ref;
    const desc = $('description').value.trim();
    if (desc) payload.description = desc;
    const url = $('receipt_url').value.trim();
    if (url) payload.receipt_url = url;

    try {
      await api('/expenses', { method: 'POST', body: payload });
      toast('Expense recorded');
      $('expense-form').reset();
      $('expense_date').value = fmt.today();
      await Promise.all([fetchExpenses(), loadSummary()]);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------ delete
  async function deleteExpense(id) {
    if (!confirm('Delete this expense? This cannot be undone.')) return;
    try {
      await api(`/expenses/${id}`, { method: 'DELETE' });
      toast('Expense deleted');
      await Promise.all([fetchExpenses(), loadSummary()]);
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ------------------------------------------------------------------ filters
  function applyFilters() {
    state.filters.from = $('filter-from').value || '';
    state.filters.to = $('filter-to').value || '';
    state.filters.category_id = $('filter-category').value || '';
    Promise.all([fetchExpenses(), loadSummary()]);
  }

  function clearFilters() {
    $('filter-from').value = '';
    $('filter-to').value = '';
    $('filter-category').value = '';
    applyFilters();
  }

  // ------------------------------------------------------------------ wiring
  $('expense-form').addEventListener('submit', saveExpense);

  $('btn-reset').addEventListener('click', () => {
    $('expense_date').value = fmt.today();
  });

  $('btn-refresh').addEventListener('click', () => {
    const icon = $('btn-refresh').querySelector('i');
    icon.classList.add('spin');
    Promise.all([loadCategories(), fetchExpenses(), loadSummary()])
      .finally(() => icon.classList.remove('spin'));
  });

  ['filter-from', 'filter-to', 'filter-category'].forEach((id) => {
    $(id).addEventListener('change', applyFilters);
  });
  $('btn-clear-filters').addEventListener('click', clearFilters);

  $('expense-list-body').addEventListener('click', (e) => {
    const btn = e.target.closest('.delete-btn');
    if (btn && btn.dataset.id) deleteExpense(Number(btn.dataset.id));
  });

  // ------------------------------------------------------------------ boot
  (async function init() {
    $('expense_date').value = fmt.today();
    await loadCategories();
    await Promise.all([fetchExpenses(), loadSummary()]);
  })();

  if (shell.refreshNotifications) shell.refreshNotifications();
})();