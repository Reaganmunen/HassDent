(function () {
  'use strict';
  const { api, fmt, shell } = HD;
  const { esc, money2 } = fmt;
  const can = shell.can;
  const $ = (id) => document.getElementById(id);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const box = (icon, text) => `<div class="state-box"><i class="ph-duotone ${icon}"></i><div>${esc(text)}</div></div>`;
  const METHOD = { cash: 'Cash', mpesa: 'M-Pesa', bank_transfer: 'Bank transfer', cheque: 'Cheque' };
  const S = { active: 'true', rows: [], current: null };
  const val = (id) => $(id).value.trim();

  // ------------------------------------------------------------ list
  async function load() {
    const icon = $('btn-refresh').querySelector('i'); icon.classList.add('spin');
    try {
      const q = val('f-q');
      S.rows = await api('/suppliers?limit=200' + (S.active ? '&active=' + S.active : '') + (q ? '&search=' + encodeURIComponent(q) : ''));
      draw();
    } catch (e) { $('list').innerHTML = box(e.code === 'NETWORK_ERROR' ? 'ph-wifi-slash' : 'ph-warning-circle', e.message); }
    icon.classList.remove('spin');
  }
  function draw() {
    const c = $('count'); c.hidden = false; c.textContent = S.rows.length;
    if (!S.rows.length) { $('list').innerHTML = box('ph-handshake', val('f-q') ? 'No suppliers match your search' : 'No suppliers yet'); return; }
    $('list').innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Supplier</th><th>Contact</th><th>Phone</th><th>Terms</th><th>Status</th></tr></thead><tbody>' +
      S.rows.map((s) => `<tr class="row-link" data-id="${s.id}"><td><div class="cell-main"><span class="thumb"><i class="ph-duotone ph-handshake"></i></span><div class="trunc"><b>${esc(s.name)}</b><small>${esc(s.email || '')}</small></div></div></td>` +
        `<td>${esc(s.contact_person || '–')}</td><td style="white-space:nowrap">${esc(s.phone || '–')}</td><td>${esc(s.payment_terms || '–')}</td>` +
        `<td><span class="pill ${s.is_active ? 'ok' : 'gone'}">${s.is_active ? 'Active' : 'Inactive'}</span></td></tr>`).join('') + '</tbody></table></div>';
  }
  $('active-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.active = b.dataset.a; $('active-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); load(); });
  $('f-q').addEventListener('input', debounce(load, 300));
  $('btn-refresh').addEventListener('click', load);
  $('list').addEventListener('click', (e) => { const r = e.target.closest('tr[data-id]'); if (r) openView(r.dataset.id); });

  // ------------------------------------------------------------ detail
  let viewModal;
  async function openView(id) {
    viewModal = viewModal || new bootstrap.Modal($('viewModal'));
    $('v-body').innerHTML = box('ph-circle-notch spin', 'Loading…'); viewModal.show();
    try {
      const canPays = can('purchases.view') || can('purchases.pay');
      const [s, pays] = await Promise.all([api('/suppliers/' + id), canPays ? api('/suppliers/' + id + '/payments') : Promise.resolve([])]);
      S.current = s;
      const b = s.balance, owed = Number(b.owed);
      const info = [['Contact', s.contact_person], ['Phone', s.phone], ['Email', s.email], ['KRA PIN', s.kra_pin], ['Payment terms', s.payment_terms], ['Address', s.address]].filter((x) => x[1]);
      $('v-body').innerHTML =
        `<div class="v-head"><div><h2>${esc(s.name)}</h2></div><span class="pill ${s.is_active ? 'ok' : 'gone'}">${s.is_active ? 'Active' : 'Inactive'}</span><button type="button" class="btn-close ms-auto" data-bs-dismiss="modal" aria-label="Close"></button></div>` +
        `<div class="v-meta"><div><small>Purchased</small><b>${money2(b.purchased)}</b></div><div><small>Paid</small><b>${money2(b.paid)}</b></div><div><small>Return credits</small><b>${money2(b.credits)}</b></div>` +
        `<div style="background:${owed > 0 ? '#fff1d6' : '#e3f6ec'}"><small>${owed < 0 ? 'Supplier owes us' : 'We owe'}</small><b>${money2(Math.abs(owed))}</b></div></div>` +
        (info.length ? `<div class="v-meta">${info.map((x) => `<div><small>${x[0]}</small><b>${esc(x[1])}</b></div>`).join('')}</div>` : '') +
        (s.notes ? `<p class="text-muted small"><i class="ph-duotone ph-note"></i> ${esc(s.notes)}</p>` : '') +
        (canPays ? '<h3 class="h6 fw-bold mt-3">Payments made</h3>' + (pays.length
          ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="num">Amount</th></tr></thead><tbody>' +
            pays.slice(0, 10).map((p) => `<tr><td>${fmt.when(p.paid_at)}</td><td>${esc(METHOD[p.method] || p.method)}</td><td>${esc(p.reference || '–')}</td><td class="num">${money2(p.amount)}</td></tr>`).join('') + '</tbody></table></div>'
          : box('ph-hand-coins', 'No payments recorded yet')) : '') +
        '<div class="v-actions">' +
        (can('purchases.pay') ? '<button class="btn btn-hd" data-a="pay"><i class="ph-duotone ph-hand-coins"></i> Record payment</button>' : '') +
        (can('suppliers.manage') ? '<button class="btn btn-light border fw-bold" data-a="edit"><i class="ph-duotone ph-pencil-simple"></i> Edit</button>' +
          `<button class="btn btn-outline-${s.is_active ? 'danger' : 'success'} fw-bold" data-a="toggle">${s.is_active ? 'Deactivate' : 'Reactivate'}</button>` : '') +
        '</div>';
      $('v-body').querySelectorAll('[data-a]').forEach((btn) => btn.addEventListener('click', async () => {
        const a = btn.dataset.a;
        if (a === 'edit') { viewModal.hide(); openForm(s); }
        else if (a === 'pay') { viewModal.hide(); openPay(s); }
        else {
          if (s.is_active && !confirm('Deactivate ' + s.name + '? It will no longer appear when creating orders.')) return;
          btn.disabled = true;
          try { await api('/suppliers/' + s.id + '/active', { method: 'POST', body: { is_active: !s.is_active } }); viewModal.hide(); load(); }
          catch (e) { btn.disabled = false; alert(e.message); }
        }
      }));
    } catch (e) { $('v-body').innerHTML = box('ph-warning-circle', e.message); }
  }

  // ------------------------------------------------------------ add / edit
  let formModal, editing = null;
  const FIELDS = { name: 'f-name', contact_person: 'f-contact', phone: 'f-phone', email: 'f-email', kra_pin: 'f-kra', payment_terms: 'f-terms', address: 'f-addr', notes: 'f-notes' };
  function openForm(s) {
    formModal = formModal || new bootstrap.Modal($('formModal'));
    editing = s || null;
    $('f-title').textContent = s ? 'Edit supplier' : 'New supplier'; $('f-err').hidden = true;
    Object.entries(FIELDS).forEach(([k, id]) => { $(id).value = s && s[k] ? s[k] : ''; });
    formModal.show();
  }
  $('btn-new').addEventListener('click', () => openForm());
  $('formModal').addEventListener('shown.bs.modal', () => $('f-name').focus());
  $('f-save').addEventListener('click', async () => {
    const err = $('f-err'), btn = $('f-save');
    const fail = (m) => { err.querySelector('span').textContent = m; err.hidden = false; };
    err.hidden = true;
    if (!val('f-name')) return fail('Supplier name is required.');
    const body = {};
    Object.entries(FIELDS).forEach(([k, id]) => { body[k] = val(id) || (editing ? null : undefined); });
    btn.disabled = true; btn.querySelector('.label').textContent = 'Saving…';
    try {
      await api(editing ? '/suppliers/' + editing.id : '/suppliers', { method: editing ? 'PATCH' : 'POST', body });
      formModal.hide(); load();
    } catch (e) { fail(e.message); }
    finally { btn.disabled = false; btn.querySelector('.label').textContent = 'Save supplier'; }
  });

  // ------------------------------------------------------------ record payment
  let payModal, method = 'cash';
  function openPay(s) {
    payModal = payModal || new bootstrap.Modal($('payModal'));
    const owed = Math.max(Number(s.balance.owed), 0);
    $('p-name').textContent = 'Pay ' + s.name; $('p-owed').textContent = money2(owed); $('p-err').hidden = true;
    $('p-amt').value = owed > 0 ? owed.toFixed(2) : ''; $('p-ref').value = ''; $('p-notes').value = '';
    method = 'cash'; $('p-methods').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.m === 'cash'));
    $('p-quick').innerHTML = owed > 0 ? `<button type="button" data-v="${owed.toFixed(2)}">Full balance</button><button type="button" data-v="${(owed / 2).toFixed(2)}">Half</button>` : '';
    payModal.show();
  }
  $('p-methods').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; method = b.dataset.m; $('p-methods').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); });
  $('p-quick').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) $('p-amt').value = b.dataset.v; });
  $('p-save').addEventListener('click', async () => {
    const err = $('p-err'), btn = $('p-save'), amount = Number($('p-amt').value);
    err.hidden = true;
    if (!(amount > 0)) { err.querySelector('span').textContent = 'Enter the amount paid.'; err.hidden = false; return; }
    btn.disabled = true; btn.querySelector('.label').textContent = 'Saving…';
    try {
      await api('/suppliers/' + S.current.id + '/payments', { method: 'POST', body: { amount, method, reference: val('p-ref') || undefined, notes: val('p-notes') || undefined } });
      payModal.hide(); openView(S.current.id);
    } catch (e) { err.querySelector('span').textContent = e.message; err.hidden = false; }
    finally { btn.disabled = false; btn.querySelector('.label').textContent = 'Record payment'; }
  });

  load();
})();