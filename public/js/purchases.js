(function () {
  'use strict';
  const { api, fmt, shell } = HD;
  const { esc, num, money2 } = fmt;
  const can = shell.can;
  const $ = (id) => document.getElementById(id);
  const cents = (v) => Math.round((Number(v) || 0) * 100);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const S = { tab: 'po', status: '', pos: [], grns: [], suppliers: [] };
  const STATUS = { draft: 'Draft', ordered: 'Ordered', partially_received: 'Partial', received: 'Received', cancelled: 'Cancelled' };
  const PILL = { draft: 'draft', ordered: 'ordered', partially_received: 'partial', received: 'ok', cancelled: 'gone' };
  const pill = (s) => `<span class="pill ${PILL[s] || 'draft'}">${STATUS[s] || esc(s)}</span>`;
  const day = (v) => (v ? fmt.dayLabel(fmt.dateKey(v), { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
  const box = (icon, text) => `<div class="state-box"><i class="ph-duotone ${icon}"></i><div>${esc(text)}</div></div>`;

  // ------------------------------------------------------------ loading
  async function load() {
    const icon = $('btn-refresh').querySelector('i'); icon.classList.add('spin');
    try {
      const [pos, grns, sup] = await Promise.all([api('/purchase-orders?limit=200'), api('/goods-received?limit=200'), api('/suppliers?limit=200&active=true')]);
      S.pos = pos; S.grns = grns; S.suppliers = sup;
      const cur = $('f-sup').value;
      $('f-sup').innerHTML = '<option value="">All suppliers</option>' + sup.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
      $('f-sup').value = cur;
      stats(); draw();
    } catch (e) { $('list').innerHTML = box(e.code === 'NETWORK_ERROR' ? 'ph-wifi-slash' : 'ph-warning-circle', e.message); }
    icon.classList.remove('spin');
  }

  function setStat(id, v, f) { const c = $(id); const a = c.querySelector('[data-v]'), b = c.querySelector('[data-f]'); a.classList.remove('sk'); b.classList.remove('sk'); a.textContent = v; b.textContent = f; }
  function stats() {
    const open = S.pos.filter((p) => ['ordered', 'partially_received'].includes(p.status));
    const month = fmt.today().slice(0, 7);
    const recv = S.grns.filter((g) => fmt.dateKey(g.received_date).startsWith(month));
    setStat('s-open', num(open.length), open.length === 1 ? 'Order awaiting delivery' : 'Orders awaiting delivery');
    setStat('s-value', fmt.money(open.reduce((s, p) => s + Number(p.total), 0)), 'Value of open orders');
    const drafts = S.pos.filter((p) => p.status === 'draft').length;
    setStat('s-draft', num(drafts), 'Not yet sent to supplier');
    setStat('s-recv', fmt.money(recv.reduce((s, g) => s + Number(g.total_cost), 0)), `${num(recv.length)} ${recv.length === 1 ? 'delivery' : 'deliveries'}`);
  }

  // ------------------------------------------------------------ list
  function draw() {
    const q = $('f-q').value.trim().toLowerCase(), sup = $('f-sup').value;
    $('status-seg').hidden = S.tab !== 'po';
    const el = $('list');
    if (S.tab === 'po') {
      const rows = S.pos.filter((p) => (!S.status || p.status === S.status) && (!sup || String(p.supplier_id) === sup) &&
        (!q || (p.po_number + ' ' + p.supplier_name).toLowerCase().includes(q)));
      if (!rows.length) { el.innerHTML = box('ph-truck', S.pos.length ? 'No orders match these filters' : 'No purchase orders yet'); return; }
      el.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Order</th><th>Supplier</th><th>Ordered</th><th>Expected</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>' +
        rows.map((p) => `<tr class="row-link" data-id="${p.id}"><td><div class="cell-main"><span class="thumb"><i class="ph-duotone ph-truck"></i></span><b>${esc(p.po_number)}</b></div></td>` +
          `<td class="trunc">${esc(p.supplier_name)}</td><td>${day(p.order_date)}</td><td>${day(p.expected_date)}</td><td>${pill(p.status)}</td><td class="num">${money2(p.total)}</td></tr>`).join('') + '</tbody></table></div>';
    } else {
      const rows = S.grns.filter((g) => (!sup || String(g.supplier_id) === sup) && (!q || (g.grn_number + ' ' + g.supplier_name + ' ' + (g.supplier_invoice_no || '')).toLowerCase().includes(q)));
      if (!rows.length) { el.innerHTML = box('ph-package', S.grns.length ? 'No deliveries match these filters' : 'No goods received yet'); return; }
      el.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Receipt</th><th>Supplier</th><th>Invoice</th><th>Received</th><th class="num">Total cost</th></tr></thead><tbody>' +
        rows.map((g) => `<tr class="row-link" data-id="${g.id}"><td><div class="cell-main"><span class="thumb"><i class="ph-duotone ph-package"></i></span><b>${esc(g.grn_number)}</b></div></td>` +
          `<td class="trunc">${esc(g.supplier_name)}</td><td>${esc(g.supplier_invoice_no || '–')}</td><td>${day(g.received_date)}</td><td class="num">${money2(g.total_cost)}</td></tr>`).join('') + '</tbody></table></div>';
    }
  }
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.tab = b.dataset.tab; $('tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); draw(); });
  $('status-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.status = b.dataset.s; $('status-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); draw(); });
  $('f-q').addEventListener('input', debounce(draw, 150));
  $('f-sup').addEventListener('change', draw);
  $('btn-refresh').addEventListener('click', load);
  $('list').addEventListener('click', (e) => { const r = e.target.closest('tr[data-id]'); if (r) openView(S.tab, r.dataset.id); });

  // ------------------------------------------------------------ detail modal
  let viewModal;
  async function openView(kind, id) {
    viewModal = viewModal || new bootstrap.Modal($('viewModal'));
    $('v-body').innerHTML = box('ph-circle-notch spin', 'Loading…'); viewModal.show();
    try {
      const d = await api((kind === 'po' ? '/purchase-orders/' : '/goods-received/') + id);
      const isPO = kind === 'po';
      const meta = isPO
        ? [['Supplier', d.supplier_name], ['Ordered', day(d.order_date)], ['Expected', day(d.expected_date)], ['Total incl. VAT', money2(d.total)]]
        : [['Supplier', d.supplier_name], ['Received', day(d.received_date)], ['Invoice', d.supplier_invoice_no || '–'], ['Location', d.location]];
      const head = isPO ? '<th class="num">Ordered</th><th class="num">Received</th><th class="num">Unit cost</th><th class="num">Total</th>' : '<th>Batch</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Total</th>';
      const rows = d.items.map((i) => isPO
        ? `<tr><td><b>${esc(i.product_name)}</b><br><small class="text-muted">${esc(i.sku || '')}</small></td><td class="num">${num(i.quantity_ordered)}</td><td class="num">${num(i.quantity_received)}</td><td class="num">${money2(i.unit_cost)}</td><td class="num">${money2(i.line_total)}</td></tr>`
        : `<tr><td><b>${esc(i.product_name)}</b></td><td>${i.batch_number ? esc(i.batch_number) + '<br><small class="text-muted">exp ' + day(i.expiry_date) + '</small>' : '–'}</td><td class="num">${num(i.quantity)}</td><td class="num">${money2(i.unit_cost)}</td><td class="num">${money2(cents(i.unit_cost) * i.quantity / 100)}</td></tr>`).join('');
      const st = d.status;
      let acts = '';
      if (isPO && can('purchases.manage') && st === 'draft') acts += '<button class="btn btn-hd" data-a="ordered"><i class="ph-duotone ph-paper-plane-tilt"></i> Mark as ordered</button>';
      if (isPO && can('purchases.receive') && ['ordered', 'partially_received'].includes(st)) acts += '<button class="btn btn-hd" data-a="receive"><i class="ph-duotone ph-package"></i> Receive goods</button>';
      if (isPO && can('purchases.manage') && ['draft', 'ordered'].includes(st)) acts += '<button class="btn btn-outline-danger fw-bold" data-a="cancelled">Cancel order</button>';
      $('v-body').innerHTML =
        `<div class="v-head"><div><h2>${esc(isPO ? d.po_number : d.grn_number)}</h2></div>${isPO ? pill(st) : ''}<button type="button" class="btn-close ms-auto" data-bs-dismiss="modal" aria-label="Close"></button></div>` +
        `<div class="v-meta">${meta.map((m) => `<div><small>${m[0]}</small><b>${esc(m[1])}</b></div>`).join('')}</div>` +
        `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>` +
        (d.notes ? `<p class="mt-3 mb-0 text-muted small"><i class="ph-duotone ph-note"></i> ${esc(d.notes)}</p>` : '') +
        (acts ? `<div class="v-actions">${acts}</div>` : '');
      $('v-body').querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.a === 'receive') { viewModal.hide(); openDoc('receive', d); return; }
        if (b.dataset.a === 'cancelled' && !confirm('Cancel ' + d.po_number + '? This cannot be undone.')) return;
        b.disabled = true;
        api('/purchase-orders/' + d.id + '/status', { method: 'POST', body: { status: b.dataset.a } })
          .then(() => { viewModal.hide(); return load(); })
          .catch((e) => { b.disabled = false; alert(e.message); });
      }));
    } catch (e) { $('v-body').innerHTML = box('ph-warning-circle', e.message); }
  }

  // ------------------------------------------------------------ create order / receive goods
  const D = { mode: 'po', po: null, lines: [] };
  let docModal;
  const supOptions = (sel) => '<option value="">Choose supplier…</option>' + S.suppliers.map((s) => `<option value="${s.id}"${String(s.id) === String(sel) ? ' selected' : ''}>${esc(s.name)}</option>`).join('');

  function openDoc(mode, po) {
    docModal = docModal || new bootstrap.Modal($('docModal'));
    D.mode = mode; D.po = po || null; D.lines = [];
    const recv = mode === 'receive';
    $('d-title').textContent = recv ? (po ? 'Receive goods · ' + po.po_number : 'Receive goods') : 'New purchase order';
    $('d-date-l').textContent = recv ? 'Received date' : 'Expected date';
    $('d-date').value = recv ? fmt.today() : '';
    $('d-inv-w').hidden = !recv; $('d-inv').value = ''; $('d-notes').value = ''; $('d-err').hidden = true;
    $('d-sup').innerHTML = supOptions(po && po.supplier_id); $('d-sup').disabled = Boolean(po);
    $('d-search-w').hidden = Boolean(po);
    document.querySelector('.lines-tbl').classList.toggle('po-mode', !recv);
    $('d-save').querySelector('.label').textContent = recv ? 'Receive into stock' : 'Save order';
    if (po) po.items.forEach((i) => {
      const left = i.quantity_ordered - i.quantity_received;
      if (left > 0) D.lines.push({ product_id: i.product_id, name: i.product_name, sku: i.sku, qty: left, cost: i.unit_cost, tax_rate: i.tax_rate, poi: i.id, batch: '', expiry: '' });
    });
    drawLines(); docModal.show();
  }
  $('btn-new').addEventListener('click', () => openDoc('po'));
  $('btn-receive').addEventListener('click', () => openDoc('receive'));

  function drawLines() {
    const recv = D.mode === 'receive';
    $('d-lines').innerHTML = D.lines.length ? D.lines.map((l, i) =>
      `<tr data-i="${i}"><td class="pname"><b>${esc(l.name)}</b><small>${esc(l.sku || '')}</small></td>` +
      `<td><input class="form-control" data-f="qty" type="number" min="1" step="1" value="${l.qty}"></td>` +
      `<td><input class="form-control" data-f="cost" type="number" min="0" step="0.01" value="${l.cost}"></td>` +
      (recv ? `<td class="rcv"><input class="form-control" data-f="batch" maxlength="50" placeholder="If tracked" value="${esc(l.batch)}"></td><td class="rcv"><input class="form-control" data-f="expiry" type="date" value="${esc(l.expiry)}"></td>` : '<td class="rcv"></td><td class="rcv"></td>') +
      `<td class="num" data-t>${money2(cents(l.cost) * l.qty / 100)}</td><td><button class="rm" type="button" data-rm aria-label="Remove"><i class="ph-duotone ph-x-circle"></i></button></td></tr>`).join('')
      : `<tr><td colspan="7">${box('ph-shopping-cart', D.po ? 'Everything on this order has been received' : 'Search for a product to add it')}</td></tr>`;
    total();
  }
  const total = () => { $('d-total').textContent = money2(D.lines.reduce((s, l) => s + cents(l.cost) * l.qty, 0) / 100); };
  $('d-lines').addEventListener('input', (e) => {
    const tr = e.target.closest('tr[data-i]'), f = e.target.dataset.f; if (!tr || !f) return;
    const l = D.lines[tr.dataset.i]; l[f] = f === 'qty' ? Math.floor(Number(e.target.value)) || 0 : e.target.value;
    tr.querySelector('[data-t]').textContent = money2(cents(l.cost) * l.qty / 100); total();
  });
  $('d-lines').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (!b) return; D.lines.splice(Number(b.closest('tr').dataset.i), 1); drawLines(); });

  // product picker
  const pSearch = debounce(async () => {
    const q = $('d-q').value.trim(), res = $('d-res');
    if (q.length < 2) { res.hidden = true; return; }
    try {
      const rows = await api('/products?search=' + encodeURIComponent(q) + '&limit=8');
      res.rows = rows;
      res.innerHTML = rows.length ? rows.map((p) => `<button type="button" data-id="${p.id}">${esc(p.name)} <small>${esc(p.sku || '')} · cost ${money2(p.cost_price)}</small></button>`).join('') : '<div class="p-3 small text-muted">No product found</div>';
      res.hidden = false;
    } catch (e) { res.hidden = true; }
  }, 250);
  $('d-q').addEventListener('input', pSearch);
  $('d-res').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const p = $('d-res').rows.find((r) => String(r.id) === b.dataset.id);
    const ex = D.lines.find((l) => l.product_id === p.id);
    if (ex) ex.qty++; else D.lines.push({ product_id: p.id, name: p.name, sku: p.sku, qty: 1, cost: p.cost_price, tax_rate: 0, poi: null, batch: '', expiry: '' });
    $('d-res').hidden = true; $('d-q').value = ''; drawLines();
  });

  $('d-save').addEventListener('click', async () => {
    const err = $('d-err'), btn = $('d-save'), recv = D.mode === 'receive';
    const fail = (m) => { err.querySelector('span').textContent = m; err.hidden = false; err.scrollIntoView({ block: 'nearest' }); };
    err.hidden = true;
    const supplier_id = Number($('d-sup').value) || (D.po && D.po.supplier_id);
    if (!supplier_id) return fail('Choose a supplier.');
    const lines = D.lines.filter((l) => l.qty > 0);
    if (!lines.length) return fail('Add at least one product with a quantity.');
    if (lines.some((l) => !(Number(l.cost) >= 0) || l.cost === '')) return fail('Every line needs a unit cost.');
    const body = recv
      ? { supplier_id, purchase_order_id: D.po ? D.po.id : undefined, supplier_invoice_no: $('d-inv').value.trim() || undefined, received_date: $('d-date').value || undefined, notes: $('d-notes').value.trim() || undefined,
          items: lines.map((l) => ({ product_id: l.product_id, quantity: l.qty, unit_cost: Number(l.cost), batch_number: l.batch.trim() || undefined, expiry_date: l.expiry || undefined, purchase_order_item_id: l.poi || undefined })) }
      : { supplier_id, expected_date: $('d-date').value || undefined, notes: $('d-notes').value.trim() || undefined, status: 'draft',
          items: lines.map((l) => ({ product_id: l.product_id, quantity: l.qty, unit_cost: Number(l.cost), tax_rate: Number(l.tax_rate) || 0 })) };
    btn.disabled = true; btn.querySelector('.label').textContent = 'Saving…';
    try {
      await api(recv ? '/goods-received' : '/purchase-orders', { method: 'POST', body });
      docModal.hide(); if (recv) S.tab = 'grn', $('tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'grn'));
      await load();
    } catch (e) { fail(e.message); }
    finally { btn.disabled = false; btn.querySelector('.label').textContent = recv ? 'Receive into stock' : 'Save order'; }
  });

  load();
})();