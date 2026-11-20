(function () {
  'use strict';
  const { api, fmt, shell } = HD;
  const { esc, money2, num } = fmt;
  const can = shell.can;
  const $ = (id) => document.getElementById(id);

  const PAY_LABEL = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank_transfer: 'Bank transfer', loyalty: 'Loyalty points' };
  const REASONS = { defective: 'Defective', wrong_item: 'Wrong item', changed_mind: 'Changed mind', expired: 'Expired', other: 'Other' };
  const REFUNDS = { cash: 'Cash', mpesa: 'M-Pesa', store_credit: 'Store credit', none: 'No refund' };

  const state = { page: 1, limit: 20, pages: 1, total: 0, rows: [], range: '30', reqId: 0, sale: null };
  let modal = null;

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ------------------------------------------------------------------ helpers
  let toastTimer;
  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg; t.className = 'toast-hd' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
  }

  function statusPill(s) {
    if (s.status === 'voided') return '<span class="pill void"><i class="ph-bold ph-prohibit"></i>Voided</span>';
    if (s.status === 'held') return '<span class="pill held"><i class="ph-bold ph-pause"></i>Held</span>';
    const map = { paid: ['paid', 'Paid'], partial: ['partial', 'Part paid'], unpaid: ['unpaid', 'Unpaid'] };
    const [cls, label] = map[s.payment_status] || ['unpaid', s.payment_status || '—'];
    return `<span class="pill ${cls}">${label}</span>`;
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i class="ph-bold ph-spinner spin"></i> ' + (label || 'Working…'); }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }

  // ------------------------------------------------------------------ filters
  function rangeDates(r) {
    const today = fmt.today();
    if (r === 'today') return [today, today];
    if (r === '7') return [fmt.addDays(today, -6), today];
    if (r === '30') return [fmt.addDays(today, -29), today];
    return ['', ''];
  }
  function applyRange(r) {
    state.range = r;
    document.querySelectorAll('#range-seg button').forEach((b) => b.classList.toggle('on', b.dataset.range === r));
    const [from, to] = rangeDates(r);
    $('f-from').value = from; $('f-to').value = to;
  }

  function query() {
    const p = new URLSearchParams();
    const add = (k, v) => { if (v) p.set(k, v); };
    add('search', $('f-search').value.trim());
    add('status', $('f-status').value);
    add('payment_status', $('f-pay').value);
    add('from', $('f-from').value);
    add('to', $('f-to').value);
    p.set('page', state.page); p.set('limit', state.limit);
    return p.toString();
  }

  // ------------------------------------------------------------------ list
  const stateBox = (icon, text, retry) =>
    `<div class="state-box"><i class="ph-duotone ${icon}"></i><div>${esc(text)}</div>${retry ? '<button class="retry" type="button">Try again</button>' : ''}</div>`;

  async function load() {
    const id = ++state.reqId;
    $('state').innerHTML = '<div class="sk sk-line"></div><div class="sk sk-line"></div><div class="sk sk-line"></div><div class="sk sk-line"></div>';
    $('rows').innerHTML = ''; $('pager').hidden = true;
    try {
      const res = await api('/sales?' + query(), { full: true });
      if (id !== state.reqId) return;
      state.rows = res.data || [];
      const m = res.meta || {};
      state.total = Number(m.total) || state.rows.length;
      state.pages = Number(m.pages) || 1;
      draw();
    } catch (err) {
      if (id !== state.reqId) return;
      $('total-pill').textContent = '—';
      $('state').innerHTML = stateBox(err.code === 'NETWORK_ERROR' ? 'ph-wifi-slash' : 'ph-warning-circle', err.message, true);
      $('state').querySelector('.retry').addEventListener('click', load);
    }
  }

  function draw() {
    $('total-pill').textContent = num(state.total) + (state.total === 1 ? ' sale' : ' sales');
    if (!state.rows.length) {
      $('rows').innerHTML = '';
      $('state').innerHTML = stateBox('ph-receipt', 'No sales match these filters');
      $('pager').hidden = true;
      return;
    }
    $('state').innerHTML = '';
    $('rows').innerHTML = state.rows.map((s) =>
      `<tr data-id="${s.id}" tabindex="0">` +
      `<td><b>${esc(s.sale_number)}</b></td>` +
      `<td>${esc(fmt.when(s.sold_at))}</td>` +
      `<td><div class="trunc">${s.customer_name ? esc(s.customer_name) : '<span class="text-muted">Walk-in</span>'}</div></td>` +
      `<td>${esc(s.sold_by_name || '—')}</td>` +
      `<td class="num">${money2(s.total)}</td>` +
      `<td class="num">${money2(s.amount_paid)}</td>` +
      `<td>${statusPill(s)}</td></tr>`).join('');

    const from = (state.page - 1) * state.limit + 1;
    const to = from + state.rows.length - 1;
    $('pager-info').textContent = `Showing ${num(from)}–${num(to)} of ${num(state.total)}`;
    $('pg-prev').disabled = state.page <= 1;
    $('pg-next').disabled = state.page >= state.pages;
    $('pager').hidden = state.pages <= 1;
  }

  function reload(resetPage) { if (resetPage) state.page = 1; return load(); }

  // ------------------------------------------------------------------ detail modal
  async function openSale(id) {
    $('s-body').innerHTML = '<div class="sk sk-line" style="height:28px;width:50%"></div><div class="sk sk-line"></div><div class="sk sk-line"></div><div class="sk sk-line"></div>';
    modal.show();
    try {
      state.sale = await api('/sales/' + id);
      viewDetail();
    } catch (err) {
      $('s-body').innerHTML = stateBox('ph-warning-circle', err.message) +
        '<div class="text-center"><button class="btn-soft" data-act="close" type="button">Close</button></div>';
    }
  }

  async function refreshSale() {
    state.sale = await api('/sales/' + state.sale.id);
    waPrep = null;   // balance / payments may have changed, so rebuild the PDF next time
    load();
    viewDetail();
  }

  const closeBtn = '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>';

  function headHtml(s, sub) {
    return `<div class="sm-head"><div><h2>${esc(s.sale_number)} ${statusPill(s)}</h2>` +
      `<div class="meta">${esc(sub || fmt.when(s.sold_at))}</div></div>${closeBtn}</div>`;
  }

  function returnable(s) { return (s.items || []).some((i) => Number(i.quantity) - Number(i.quantity_returned || 0) > 0); }

  function viewDetail() {
    const s = state.sale;
    const balance = Number(s.balance) || 0;
    const completed = s.status === 'completed';
    const items = s.items || [];
    const payments = (s.payments || []).filter((p) => p.status !== 'failed');
    const returns = s.returns || [];

    let h = headHtml(s);
    h += '<div class="sm-info">' +
      `<div><span>Customer</span><b>${s.customer_name ? esc(s.customer_name) : 'Walk-in'}</b>${s.customer_phone ? `<div class="small text-muted">${esc(s.customer_phone)}</div>` : ''}</div>` +
      `<div><span>Cashier</span><b>${esc(s.sold_by_name || '—')}</b></div>` +
      `<div><span>Date</span><b>${esc(fmt.when(s.sold_at))}</b></div></div>`;

    if (s.status === 'voided') {
      h += `<div class="sm-note bad"><i class="ph-duotone ph-prohibit"></i> Voided${s.voided_at ? ' ' + esc(fmt.when(s.voided_at)) : ''}${s.void_reason ? ': ' + esc(s.void_reason) : ''}</div>`;
    }
    if (s.status === 'held') {
      h += '<div class="sm-note"><i class="ph-duotone ph-pause-circle"></i> This sale is on hold. Stock has not been deducted and nothing has been paid.</div>';
    }

    h += '<div class="sm-h">Items</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead><tbody>';
    h += items.map((i) => {
      const ret = Number(i.quantity_returned || 0);
      return `<tr><td><div class="cell-main"><div><b>${esc(i.product_name)}</b><small>${esc(i.sku || '')}${Number(i.discount_amount) > 0 ? ' · discount ' + money2(i.discount_amount) : ''}</small></div></div></td>` +
        `<td class="num">${num(i.quantity)}${ret ? `<small class="d-block text-muted">${ret} returned</small>` : ''}</td>` +
        `<td class="num">${money2(i.unit_price)}</td><td class="num">${money2(i.line_total)}</td></tr>`;
    }).join('');
    h += '</tbody></table></div>';

    h += '<div class="sm-tot">' +
      `<div><span>Subtotal</span><span>${money2(s.subtotal)}</span></div>` +
      (Number(s.discount_amount) > 0 ? `<div><span>Discount</span><span>− ${money2(s.discount_amount)}</span></div>` : '') +
      (Number(s.loyalty_discount) > 0 ? `<div><span>Loyalty (${num(s.loyalty_points_used)} pts)</span><span>− ${money2(s.loyalty_discount)}</span></div>` : '') +
      `<div><span>VAT included</span><span>${money2(s.tax_total)}</span></div>` +
      `<div class="grand"><span>Total</span><span>${money2(s.total)}</span></div>` +
      (completed ? `<div><span>Paid</span><span>${money2(s.amount_paid)}</span></div>` : '') +
      (completed && balance > 0 ? `<div class="due"><span>Balance due</span><span>${money2(balance)}</span></div>` : '') +
      '</div>';

    if (payments.length) {
      h += '<div class="sm-h">Payments</div><div class="sm-list">' + payments.map((p) =>
        `<div><span>${esc(PAY_LABEL[p.method] || p.method)}${p.reference ? ` <small>· ${esc(p.reference)}</small>` : ''}` +
        `<small class="d-block">${esc(fmt.when(p.paid_at))}</small></span>` +
        `<span class="r">${money2(p.amount)}${p.status !== 'completed' ? ` <span class="pill ${p.status === 'pending' ? 'soon' : 'gone'} ms-1">${esc(p.status)}</span>` : ''}</span></div>`).join('') + '</div>';
    }
    if (returns.length) {
      h += '<div class="sm-h">Returns</div><div class="sm-list">' + returns.map((r) =>
        `<div><span>${esc(r.return_number)} <small>· ${esc(REASONS[r.reason] || r.reason)} · ${esc(REFUNDS[r.refund_method] || r.refund_method)}</small>` +
        `<small class="d-block">${esc(fmt.when(r.processed_at))}</small></span><span class="r">− ${money2(r.refund_amount)}</span></div>`).join('') + '</div>';
    }
    if (s.notes) h += `<div class="sm-h">Notes</div><div class="small fw-semibold">${esc(s.notes)}</div>`;

    // actions
    const a = [];
    if (completed || s.status === 'voided') a.push('<button class="btn-soft" data-act="print" type="button"><i class="ph-duotone ph-printer"></i>Print receipt</button>');
    if (completed) a.push('<button class="btn-soft" data-act="view-whatsapp" type="button" style="color:#128c4a"><i class="ph-duotone ph-whatsapp-logo"></i>Share on WhatsApp</button>');
    if (completed && balance > 0 && can('sales.create')) a.push('<button class="btn-soft" data-act="view-pay" type="button"><i class="ph-duotone ph-hand-coins"></i>Record payment</button>');
    if (completed && balance > 0 && can('sales.create') && !returns.length && s.customer_id) a.push('<button class="btn-soft" data-act="view-add" type="button"><i class="ph-duotone ph-plus-circle"></i>Add items</button>');
    if (completed && can('sales.refund') && returnable(s)) a.push('<button class="btn-soft" data-act="view-return" type="button"><i class="ph-duotone ph-arrow-u-up-left"></i>Return items</button>');
    if (completed && can('sales.void') && !returns.length) a.push('<button class="btn-soft danger" data-act="view-void" type="button"><i class="ph-duotone ph-prohibit"></i>Void sale</button>');
    if (s.status === 'held' && can('sales.create')) a.push('<button class="btn-soft danger" data-act="delete-held" type="button"><i class="ph-duotone ph-trash"></i>Delete held sale</button>');
    if (a.length) h += `<div class="sm-actions">${a.join('')}</div>`;

    $('s-body').innerHTML = h;
  }

  // ---- record payment
  function viewPay() {
    const s = state.sale, bal = Number(s.balance) || 0;
    $('s-body').innerHTML = headHtml(s, 'Record a payment') +
      '<button class="back-link" data-act="back" type="button"><i class="ph-bold ph-arrow-left"></i> Back to sale</button>' +
      `<div class="sm-form"><div class="hd-alert hd-alert-danger mb-3" id="f-err" hidden><i class="ph-duotone ph-warning-circle"></i><span></span></div>` +
      `<div class="mb-3 fw-bold">Balance due: ${money2(bal)}</div>` +
      '<div class="row g-3"><div class="col-sm-6"><label for="p-method">Method</label><select id="p-method" class="form-select">' +
      Object.keys(PAY_LABEL).filter((k) => k !== 'loyalty').map((k) => `<option value="${k}">${PAY_LABEL[k]}</option>`).join('') + '</select></div>' +
      `<div class="col-sm-6"><label for="p-amt">Amount (KES)</label><input id="p-amt" class="form-control" type="number" min="0.01" max="${bal}" step="0.01" value="${bal}" inputmode="decimal"></div>` +
      '<div class="col-12"><label for="p-ref">Reference / M-Pesa code (optional)</label><input id="p-ref" class="form-control" type="text" maxlength="60"></div></div>' +
      '<button class="btn btn-hd btn-lg w-100 mt-4" data-act="submit-pay" type="button">Save payment</button></div>';
  }
  async function submitPay(btn) {
    const amount = Number($('p-amt').value);
    if (!(amount > 0)) return formErr('Enter an amount greater than zero');
    setBusy(btn, true, 'Saving…');
    try {
      await api(`/sales/${state.sale.id}/payments`, { method: 'POST', body: { method: $('p-method').value, amount, reference: $('p-ref').value.trim() || undefined } });
      toast('Payment recorded');
      await refreshSale();
    } catch (e) { setBusy(btn, false); formErr(e.message); }
  }

  // ---- add items to a sale that still has a balance
  let aiCart = [];    // [{ id, name, sku, price, qty }]
  let aiHits = [];    // last search results, normalised
  let aiReq = 0;

  /** One place that maps /products/pos-search rows to what this view needs. Adjust here if the field names differ. */
  const normProduct = (p) => ({
    id: p.id != null ? p.id : p.product_id,
    name: p.name || p.product_name || '',
    sku: p.sku || '',
    price: Number(p.price != null ? p.price : (p.selling_price != null ? p.selling_price : p.unit_price)) || 0,
    stock: p.on_hand != null ? p.on_hand : (p.stock != null ? p.stock : (p.stock_on_hand != null ? p.stock_on_hand : null)),
  });

  function viewAddItems() {
    const s = state.sale;
    aiCart = []; aiHits = []; aiReq++;
    $('s-body').innerHTML = headHtml(s, 'Add items') +
      '<button class="back-link" data-act="back" type="button"><i class="ph-bold ph-arrow-left"></i> Back to sale</button>' +
      '<div class="sm-form"><div class="hd-alert hd-alert-danger mb-3" id="f-err" hidden><i class="ph-duotone ph-warning-circle"></i><span></span></div>' +
      `<div class="mb-3 fw-bold">Balance due now: ${money2(s.balance)}</div>` +
      '<label for="ai-search">Find a product</label>' +
      '<input id="ai-search" class="form-control" type="search" placeholder="Name, SKU or barcode…" autocomplete="off">' +
      '<div id="ai-results" class="mt-2"></div>' +
      '<div class="sm-h">Items to add</div><div id="ai-cart"></div>' +
      '<button class="btn btn-hd btn-lg w-100 mt-4" id="ai-submit" data-act="submit-add" type="button" disabled>Add to sale</button></div>';
    drawAiCart();
    const inp = $('ai-search'); if (inp) inp.focus();
  }

  async function aiSearch(q) {
    const id = ++aiReq;
    const box = $('ai-results'); if (!box) return;
    if (q.length < 2) { aiHits = []; box.innerHTML = ''; return; }
    try {
      const res = await api('/products/pos-search?q=' + encodeURIComponent(q));
      if (id !== aiReq || !$('ai-results')) return;
      const list = Array.isArray(res) ? res : ((res && (res.items || res.data)) || []);
      aiHits = list.map(normProduct).filter((p) => p.id != null);
      box.innerHTML = aiHits.length
        ? '<div class="sm-list">' + aiHits.slice(0, 8).map((p, i) =>
          `<div><span><b>${esc(p.name)}</b><small class="d-block">${esc(p.sku)}${p.stock != null ? ' · ' + num(p.stock) + ' in stock' : ''}</small></span>` +
          `<span class="r">${money2(p.price)} <button class="btn-soft ms-2" data-act="ai-pick" data-i="${i}" type="button"><i class="ph-bold ph-plus"></i>Add</button></span></div>`).join('') + '</div>'
        : '<div class="small text-muted">No products found</div>';
    } catch (e) { if (id === aiReq && $('ai-results')) box.innerHTML = `<div class="small text-danger">${esc(e.message)}</div>`; }
  }
  const aiSearchDebounced = debounce(aiSearch, 250);

  function drawAiCart() {
    const box = $('ai-cart'), btn = $('ai-submit'); if (!box) return;
    if (!aiCart.length) {
      box.innerHTML = '<div class="small text-muted">Nothing added yet. Search for a product above.</div>';
      if (btn) btn.disabled = true;
      return;
    }
    const est = aiCart.reduce((t, l) => t + l.price * l.qty, 0);
    box.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Est. total</th><th></th></tr></thead><tbody>' +
      aiCart.map((l, i) =>
        `<tr><td><b>${esc(l.name)}</b><small class="d-block">${esc(l.sku)}</small></td>` +
        `<td class="num"><input class="form-control d-inline-block ai-qty" data-i="${i}" type="number" min="1" step="1" value="${l.qty}" inputmode="numeric" style="width:84px"></td>` +
        `<td class="num">${money2(l.price * l.qty)}</td>` +
        `<td><button class="btn-soft danger" data-act="ai-remove" data-i="${i}" type="button" aria-label="Remove"><i class="ph-bold ph-x"></i></button></td></tr>`).join('') +
      `</tbody></table></div><div class="small text-muted mt-2">Estimated addition ${money2(est)} (VAT included). The final price is set by the server, including any customer-group price.</div>`;
    if (btn) btn.disabled = false;
  }

  function aiPick(i) {
    const p = aiHits[i]; if (!p) return;
    const hit = aiCart.find((l) => l.id === p.id);
    if (hit) hit.qty += 1; else aiCart.push({ id: p.id, name: p.name, sku: p.sku, price: p.price, qty: 1 });
    drawAiCart();
  }

  async function submitAddItems(btn) {
    const items = aiCart.filter((l) => l.qty > 0).map((l) => ({ product_id: l.id, quantity: l.qty }));
    if (!items.length) return formErr('Add at least one product');
    setBusy(btn, true, 'Adding…');
    try {
      const sale = await api(`/sales/${state.sale.id}/items`, { method: 'POST', body: { items } });
      toast(`Items added · new balance ${money2(sale.balance)}`);
      await refreshSale();
    } catch (e) { setBusy(btn, false); formErr(e.message); }
  }

  // ---- void
  function viewVoid() {
    const s = state.sale;
    $('s-body').innerHTML = headHtml(s, 'Void this sale') +
      '<button class="back-link" data-act="back" type="button"><i class="ph-bold ph-arrow-left"></i> Back to sale</button>' +
      '<div class="sm-form"><div class="hd-alert hd-alert-danger mb-3" id="f-err" hidden><i class="ph-duotone ph-warning-circle"></i><span></span></div>' +
      '<div class="sm-note bad mb-3">Stock goes back to the shelf, payments are marked reversed and loyalty points are unwound. Refund any money at the till yourself. This cannot be undone.</div>' +
      '<label for="v-reason">Reason</label><textarea id="v-reason" class="form-control" rows="3" maxlength="300" placeholder="Why is this sale being voided?"></textarea>' +
      `<button class="btn btn-danger-hd btn-lg w-100 mt-4" data-act="submit-void" type="button">Void ${esc(s.sale_number)}</button></div>`;
  }
  async function submitVoid(btn) {
    const reason = $('v-reason').value.trim();
    if (!reason) return formErr('Please give a reason');
    setBusy(btn, true, 'Voiding…');
    try {
      await api(`/sales/${state.sale.id}/void`, { method: 'POST', body: { reason } });
      toast('Sale voided');
      await refreshSale();
    } catch (e) { setBusy(btn, false); formErr(e.message); }
  }

  // ---- return
  function viewReturn() {
    const s = state.sale;
    const rows = s.items.map((i) => ({ i, max: Number(i.quantity) - Number(i.quantity_returned || 0) })).filter((r) => r.max > 0);
    $('s-body').innerHTML = headHtml(s, 'Return items') +
      '<button class="back-link" data-act="back" type="button"><i class="ph-bold ph-arrow-left"></i> Back to sale</button>' +
      '<div class="sm-form"><div class="hd-alert hd-alert-danger mb-3" id="f-err" hidden><i class="ph-duotone ph-warning-circle"></i><span></span></div>' +
      '<div class="tbl-wrap"><table class="tbl ret-tbl"><thead><tr><th>Product</th><th class="num">Sold</th><th class="num">Return qty</th><th>Restock</th></tr></thead><tbody>' +
      rows.map(({ i, max }) =>
        `<tr data-item="${i.id}"><td><b>${esc(i.product_name)}</b></td><td class="num">${max}</td>` +
        `<td class="num"><input class="form-control d-inline-block r-qty" type="number" min="0" max="${max}" value="0" inputmode="numeric"></td>` +
        '<td><input class="form-check-input r-restock" type="checkbox" checked aria-label="Put back in stock"></td></tr>').join('') +
      '</tbody></table></div>' +
      '<div class="row g-3 mt-1"><div class="col-sm-6"><label for="r-reason">Reason</label><select id="r-reason" class="form-select">' +
      Object.keys(REASONS).map((k) => `<option value="${k}">${REASONS[k]}</option>`).join('') + '</select></div>' +
      '<div class="col-sm-6"><label for="r-method">Refund method</label><select id="r-method" class="form-select">' +
      Object.keys(REFUNDS).map((k) => `<option value="${k}">${REFUNDS[k]}</option>`).join('') + '</select></div>' +
      '<div class="col-12"><label for="r-notes">Notes (optional)</label><input id="r-notes" class="form-control" type="text" maxlength="200"></div></div>' +
      '<button class="btn btn-hd btn-lg w-100 mt-4" data-act="submit-return" type="button">Process return</button></div>';
  }
  async function submitReturn(btn) {
    const items = [...document.querySelectorAll('.ret-tbl tbody tr')].map((tr) => ({
      sale_item_id: Number(tr.dataset.item),
      quantity: Math.floor(Number(tr.querySelector('.r-qty').value)) || 0,
      restock: tr.querySelector('.r-restock').checked,
    })).filter((x) => x.quantity > 0);
    if (!items.length) return formErr('Enter a quantity for at least one item');
    setBusy(btn, true, 'Processing…');
    try {
      const ret = await api(`/sales/${state.sale.id}/returns`, {
        method: 'POST',
        body: { reason: $('r-reason').value, refund_method: $('r-method').value, notes: $('r-notes').value.trim() || undefined, items },
      });
      toast(`Return ${ret.return_number} saved · refund ${money2(ret.refund_amount)}`);
      await refreshSale();
    } catch (e) { setBusy(btn, false); formErr(e.message); }
  }

  function formErr(msg) {
    const box = $('f-err'); if (!box) return toast(msg, true);
    box.querySelector('span').textContent = msg; box.hidden = false;
  }

  // ---- delete held
  async function deleteHeld(btn) {
    if (!confirm('Delete this held sale? This cannot be undone.')) return;
    setBusy(btn, true, 'Deleting…');
    try {
      await api(`/sales/${state.sale.id}/held`, { method: 'DELETE' });
      modal.hide(); toast('Held sale deleted'); load();
    } catch (e) { setBusy(btn, false); toast(e.message, true); }
  }

  // ---- receipt: HassDent branded A5 landscape layout. Print only.
  // Coordinates are in the design's 1484 x 1060 px space; u() converts them to mm.
  const RK = 210 / 1484;
  const u = (v) => (v * RK).toFixed(3) + 'mm';
  const RDEF = {
    address: 'Mercantile House, 1st Floor, Room 137, Koinange Street, P.O. Box 34363 - 00100, Nairobi, Kenya',
    phone: '+254 (0) 725 286 720 / (0) 702 910 810',
    email: 'info@hassdentsupplies.com', email2: 'customercare@hassdentsupplies.com', web: 'www.hassdentsupplies.com',
  };
  const RECEIPT_CSS = `
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: Arial, Helvetica, sans-serif; color: #1e2230; }
    .pg { position: relative; width: 210mm; height: 148mm; overflow: hidden; background: #fff; page-break-after: always; break-after: page; }
    .pg:last-child { page-break-after: auto; break-after: auto; }
    .pg > * { position: absolute; }
    .navy { color: #14275f; } .teal { color: #01819c; }
    .lb { font-size: 10pt; line-height: ${u(24)}; white-space: nowrap; }
    .fl { height: ${u(28)}; border-bottom: .25mm solid #14275f; padding: 0 ${u(8)} ${u(3)}; display: flex; align-items: flex-end; font-size: 9.5pt; overflow: hidden; white-space: nowrap; }
    .fl > span { overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
    .addr { font-size: 8pt; line-height: ${u(31)}; width: ${u(205)}; }
    .ct { font-size: 8.5pt; color: #14275f; line-height: ${u(30)}; white-space: nowrap; }
    .tbw { border: .3mm solid #14275f; border-radius: ${u(8)}; overflow: hidden; }
    .tbw table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .tbw th { background: #14275f; color: #fff; font-size: 8.5pt; font-weight: 700; height: ${u(31)}; padding: 0; text-align: center; }
    .tbw td { height: ${u(34)}; padding: 0 ${u(12)}; border-top: .15mm solid #14275f; border-left: .2mm solid #14275f; font-size: 8.5pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tbw td:first-child { border-left: 0; text-align: center; padding: 0; }
    .tbw td.n { text-align: right; }
    .pill { background: #01819c; color: #fff; font-size: 8.5pt; font-weight: 700; border-radius: ${u(8)}; height: ${u(31)}; line-height: ${u(31)}; padding-left: ${u(28)}; }
    .cb { width: ${u(18)}; height: ${u(18)}; border: .25mm solid #14275f; }
    .cb svg { display: block; width: 100%; height: 100%; }
    .sg { font-size: 8.5pt; font-weight: 700; color: #14275f; line-height: ${u(24)}; white-space: nowrap; }
    .tot { border: .25mm solid #14275f; }
    .tot .r { display: flex; height: ${u(38.4)}; border-top: .25mm solid #14275f; }
    .tot .r:first-child { border-top: 0; }
    .tot .l { width: ${u(201)}; background: #dcecf5; text-align: right; padding-right: ${u(31)}; font-size: 9pt; color: #14275f; display: flex; align-items: center; justify-content: flex-end; }
    .tot .v { flex: 1; border-left: .25mm solid #14275f; text-align: right; padding-right: ${u(13)}; font-size: 10pt; display: flex; align-items: center; justify-content: flex-end; }
    .tot .r.t .l { font-weight: 700; color: #01819c; } .tot .r.t .v, .tot .r.d .v { font-weight: 700; }
    .tot .r.d .l { background: #01819c; color: #fff; font-weight: 700; }
    .small { font-size: 7pt; color: #6e7486; white-space: nowrap; }
    .stamp { left: 50%; top: 46%; transform: translate(-50%, -50%) rotate(-18deg); border: 1.2mm solid #b00020; color: #b00020; font-size: 56pt; font-weight: 700; letter-spacing: 2mm; padding: 1mm 8mm; opacity: .2; white-space: nowrap; }
  `;

  function receiptPages(items) {
    const rest = (items || []).slice(), out = [];
    while (rest.length > 7) out.push(rest.splice(0, Math.min(14, rest.length - 1)));
    out.push(rest);
    return out;
  }

  const rIcon = (kind, cx, cy) => {
    const g = {
      home: '<polygon points="15,7 23,15 7,15" fill="#fff"/><rect x="10" y="15" width="10" height="8" fill="#fff"/>',
      phone: '<line x1="10" y1="10" x2="20" y2="20" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/>',
      mail: '<rect x="8" y="10" width="14" height="10" fill="#fff"/><polyline points="8,10 15,16 22,10" fill="none" stroke="#14275f" stroke-width="1.4"/>',
      globe: '<circle cx="15" cy="15" r="8" fill="none" stroke="#fff" stroke-width="1.6"/><ellipse cx="15" cy="15" rx="3.5" ry="8" fill="none" stroke="#fff" stroke-width="1.6"/><line x1="7" y1="15" x2="23" y2="15" stroke="#fff" stroke-width="1.6"/>',
    }[kind];
    return `<svg style="left:${u(cx - 15)};top:${u(cy - 15)};width:${u(30)};height:${u(30)}" viewBox="0 0 30 30"><circle cx="15" cy="15" r="15" fill="#14275f"/>${g}</svg>`;
  };

  function receiptBody({ shop, sale: s }) {
    shop = shop || {};
    const A = (cls, x, y, inner, extra) => `<div class="${cls}" style="left:${u(x)};top:${u(y)};${extra || ''}">${inner}</div>`;
    const line = (x1, x2, yLine, val, extra) => `<div class="fl" style="left:${u(x1)};top:${u(yLine - 28)};width:${u(x2 - x1)};${extra || ''}"><span>${val == null ? '' : esc(val)}</span></div>`;
    const pays = (s.payments || []).filter((p) => p.status === 'completed');
    const completed = s.status === 'completed';
    const balance = completed ? (Number(s.balance) || 0) : 0;
    const used = new Set(pays.map((p) => p.method));
    const others = [...used].filter((m) => !['cash', 'mpesa', 'bank_transfer'].includes(m)).map((m) => PAY_LABEL[m] || m);
    const refs = pays.map((p) => p.reference).filter(Boolean);
    const dt = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date(s.sold_at || Date.now())).forEach((p) => { dt[p.type] = p.value; });
    const emails = [shop.email || RDEF.email, RDEF.email2].filter((e, i, a) => e && a.indexOf(e) === i).slice(0, 2);
    const disc = (Number(s.discount_amount) || 0) + (Number(s.loyalty_discount) || 0);
    const tick = '<svg viewBox="0 0 18 18"><polyline points="3,9 7.5,14 15,4" fill="none" stroke="#01819c" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const box = (x, y, on) => A('cb', x, y, on ? tick : '');
    const pageList = receiptPages(s.items);

    const head = `
      <svg style="left:${u(25)};top:${u(27)};width:${u(1435)};height:${u(246)}" viewBox="0 0 1435 246" preserveAspectRatio="none">
        <polygon points="0,0 783,0 645,246 0,246" fill="#f7f7f9"/>
        <polygon points="783,0 797,0 659,246 645,246" fill="#01819c"/>
        <polygon points="793,0 977,0 949,66 765,66" fill="#01819c"/>
        <polygon points="987,0 1163,0 1135,66 959,66" fill="#024266"/>
        <polygon points="1173,0 1435,0 1435,66 1145,66" fill="#142553"/>
      </svg>
      <img src="${location.origin}/img/receipt-logo.png" alt="HassDent" style="left:${u(50)};top:${u(70)};width:${u(622)};height:${u(162)}">
      ${rIcon('home', 800, 140)}
      ${A('addr', 824, 128, esc(shop.address || RDEF.address) + (shop.kra_pin ? '<br>PIN: ' + esc(shop.kra_pin) : ''))}
      <div style="left:${u(1049)};top:${u(124)};height:${u(148)};border-left:.2mm solid #14275f"></div>
      ${[['phone', shop.phone || RDEF.phone], ['mail', emails[0]], ['mail', emails[1]], ['globe', shop.website || RDEF.web]].map(([k, v], i) => v ? rIcon(k, 1090, 137 + i * 40) + A('ct', 1119, 122 + i * 40, esc(v)) : '').join('')}
      ${A('navy', 58, 300, 'RECEIPT', `font-size:23pt;font-weight:700;line-height:${u(60)}`)}
      ${A('navy', 796, 320, 'No.', `font-size:11pt;font-weight:700;line-height:${u(28)}`)}
      ${line(846, 1023, 344, s.sale_number, 'font-weight:700')}
      ${A('navy', 1123, 320, 'Date:', `font-size:11pt;font-weight:700;line-height:${u(28)}`)}
      ${line(1196, 1250, 344, dt.day)}${A('navy', 1256, 320, '/', `font-size:11pt;line-height:${u(28)}`)}
      ${line(1274, 1329, 344, dt.month)}${A('navy', 1337, 320, '/ 20', `font-size:11pt;line-height:${u(28)}`)}
      ${line(1378, 1436, 344, String(dt.year || '').slice(-2))}
      ${A('lb', 58, 372, 'Received from:')}${line(205, 1436, 395, s.customer_name || 'Walk-in')}
      ${A('lb', 58, 420, 'The sum of Ksh:')}${line(205, 733, 442, money2(s.amount_paid != null ? s.amount_paid : s.total).replace(/^[^\d-]+/, ''), 'font-weight:700')}
      ${A('lb', 774, 420, 'Being payment for:')}${line(948, 1436, 442, 'Goods sold - ' + (s.sale_number || ''))}`;

    const plain = (v) => money2(v).replace(/^[^\d-]+/, '');
    return pageList.map((rows, pi) => {
      const final = pi === pageList.length - 1;
      const n = final ? Math.max(7, rows.length) : rows.length;
      const trs = [];
      for (let i = 0; i < n; i++) {
        const it = rows[i];
        trs.push(it
          ? `<tr><td>${num(it.quantity)}</td><td>${esc(it.product_name)}</td><td class="n">${plain(it.unit_price)}</td><td class="n">${plain(it.line_total)}</td></tr>`
          : '<tr><td></td><td></td><td class="n"></td><td class="n"></td></tr>');
      }
      const table = `<div class="tbw" style="left:${u(50)};top:${u(472)};width:${u(1387)}"><table>
        <colgroup><col style="width:${u(115)}"><col style="width:${u(814)}"><col style="width:${u(233)}"><col style="width:${u(225)}"></colgroup>
        <thead><tr><th>QTY</th><th>ITEM DESCRIPTION</th><th>UNIT PRICE (KSH)</th><th>AMOUNT (KSH)</th></tr></thead><tbody>${trs.join('')}</tbody></table></div>`;

      const foot = !final
        ? A('small', 742 - 120, 984, 'Continued on next page...', `width:${u(240)};text-align:center;font-style:italic;font-size:9pt`)
        : `
        ${A('pill', 50, 763, 'PAYMENT METHOD', `width:${u(210)}`)}
        ${refs.length ? A('small', 275, 770, esc('Ref: ' + refs.join(', ')), `width:${u(235)};overflow:hidden;text-overflow:ellipsis`) : ''}
        ${box(51, 824, used.has('cash'))}${A('lb', 76, 820, 'Cash')}
        ${box(147, 824, used.has('mpesa'))}${A('lb', 172, 820, 'Mpesa')}
        ${box(252, 824, used.has('bank_transfer'))}${A('lb', 277, 820, 'Bank Transfer')}
        ${box(406, 824, false)}${A('lb', 431, 820, 'Cheque')}
        ${box(51, 873, others.length > 0)}${A('lb', 76, 869, 'Other:')}${line(142, 493, 892, others.join(', '))}
        <div style="left:${u(521)};top:${u(775)};height:${u(117)};border-left:.25mm solid #01819c"></div>
        ${A('sg', 548, 771, 'PAID BY:')}${line(635, 955, 794, s.customer_name || 'Walk-in')}
        ${A('sg', 548, 821, 'ID / NO.:')}${line(635, 955, 844, '')}
        ${A('sg', 548, 870, 'SIGNATURE:')}${line(664, 955, 892, '')}
        ${A('lb', 58, 950, 'Received by:')}${line(183, 481, 970, s.sold_by_name || '')}
        ${shop.paybill ? A('sg', 548, 950, 'M-PESA PAYBILL ' + esc(shop.paybill) + (shop.paybill_account ? ' &nbsp;|&nbsp; ACC ' + esc(shop.paybill_account) : ''), 'font-size:7.5pt') : ''}
        <div class="tot" style="left:${u(1010)};top:${u(749)};width:${u(427)}">
          <div class="r"><div class="l">SUBTOTAL</div><div class="v">${plain(s.subtotal)}</div></div>
          <div class="r"><div class="l">DISCOUNT</div><div class="v">${plain(disc)}</div></div>
          <div class="r t"><div class="l">TOTAL (KSH)</div><div class="v">${plain(s.total)}</div></div>
          <div class="r"><div class="l">PAID</div><div class="v">${plain(s.amount_paid)}</div></div>
          <div class="r d"><div class="l">BALANCE DUE</div><div class="v">${plain(balance)}</div></div>
        </div>
        ${Number(s.tax_total) > 0 ? A('small', 1010, 949, 'Includes VAT of KSh ' + plain(s.tax_total), `width:${u(427)};text-align:right`) : ''}
        <div style="left:${u(25)};top:${u(1013)};width:${u(506)};border-top:.25mm solid #01819c"></div>
        <div style="left:${u(953)};top:${u(1013)};width:${u(506)};border-top:.25mm solid #01819c"></div>
        ${A('teal', 531, 985, esc(shop.footer || 'Thank you for your business!'), `width:${u(422)};text-align:center;font:italic 14pt Georgia,'Times New Roman',serif;line-height:${u(56)}`)}`;

      return `<div class="pg">${head}${table}${foot}${s.status === 'voided' ? '<div class="stamp">VOIDED</div>' : ''}</div>`;
    }).join('');
  }

  async function fetchReceipt() { return api(`/sales/${state.sale.id}/receipt`); }

  function receiptDoc(r) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.sale.sale_number)}</title><style>
      @page { size: 210mm 148mm; margin: 0; } ${RECEIPT_CSS}</style></head><body>${receiptBody(r)}</body></html>`;
  }

  async function printReceipt(btn) {
    const w = window.open('', '_blank', 'width=900,height=800');   // open first so the pop-up isn't blocked
    if (!w) return toast('Allow pop-ups to print receipts', true);
    setBusy(btn, true, 'Preparing…');
    try {
      const r = await fetchReceipt();
      w.document.open(); w.document.write(receiptDoc(r)); w.document.close();
      w.focus();
      const imgs = Array.from(w.document.images);
      await Promise.race([Promise.all(imgs.map((im) => (im.complete ? 0 : new Promise((ok) => { im.onload = im.onerror = ok; })))), new Promise((ok) => setTimeout(ok, 2500))]);
      setTimeout(() => w.print(), 150);
    } catch (e) { w.close(); toast(e.message, true); }
    setBusy(btn, false);
  }

  // ---- receipt: share on WhatsApp (plain-text message, opens wa.me)
  let shopInfo = null;   // shop name / address / footer, fetched once from the receipt endpoint

  /** 0712345678 / 712345678 / +254712345678 -> 254712345678 (the digits-only form wa.me expects). */
  function waNumber(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1);
    else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
    return d;
  }

  function waMessage(s, shop) {
    shop = shop || {};
    const n2 = (v) => new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v) || 0);
    const kes = (v) => 'KSh ' + n2(v);
    const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(s.sold_at));
    const pays = (s.payments || []).filter((p) => p.status === 'completed');
    const balance = Number(s.balance) || 0;
    const L = ['*' + (shop.name || 'HassDent') + '*'];
    if (shop.address) L.push(shop.address);
    if (shop.phone) L.push('Tel: ' + shop.phone);
    L.push('', '*Receipt ' + s.sale_number + '*', when);
    if (s.customer_name) L.push('Customer: ' + s.customer_name);
    L.push('------------------------');
    (s.items || []).forEach((i) => { L.push(i.product_name); L.push('  ' + i.quantity + ' x ' + n2(i.unit_price) + ' = ' + n2(i.line_total)); });
    L.push('------------------------');
    if (Number(s.discount_amount) > 0) L.push('Discount: -' + kes(s.discount_amount));
    if (Number(s.loyalty_discount) > 0) L.push('Loyalty: -' + kes(s.loyalty_discount));
    L.push('*TOTAL: ' + kes(s.total) + '*');
    pays.forEach((p) => L.push((PAY_LABEL[p.method] || p.method) + ': ' + kes(p.amount)));
    L.push(balance > 0 ? '*Balance due: ' + kes(balance) + '*' : 'Paid in full');
    if (shop.paybill) L.push('', 'M-Pesa Paybill: ' + shop.paybill + (shop.paybill_account ? ' (Acc ' + shop.paybill_account + ')' : ''));
    L.push('', shop.footer || 'Thank you for allowing us to serve you!');
    return L.join('\n');
  }

  let waPrep = null;   // { id, r, file }: the PDF for the sale on screen, built ahead of the click

  function viewWhatsApp() {
    const s = state.sale;
    const pdfOk = Boolean(window.jspdf && HD.receiptPdf);
    $('s-body').innerHTML = headHtml(s, 'Share receipt on WhatsApp') +
      '<button class="back-link" data-act="back" type="button"><i class="ph-bold ph-arrow-left"></i> Back to sale</button>' +
      '<div class="sm-form">' +
      '<label for="wa-phone">Customer WhatsApp number</label>' +
      `<input id="wa-phone" class="form-control" type="tel" inputmode="tel" placeholder="0712 345 678" value="${esc(s.customer_phone || '')}" autocomplete="off">` +
      '<div class="small text-muted mt-1">Used for the text message, and to open the right chat if your browser cannot share files.</div>' +
      (pdfOk
        ? '<button class="btn btn-lg w-100 mt-4" id="wa-pdf" data-act="wa-pdf" type="button" disabled style="background:#25d366;border-color:#25d366;color:#fff;font-weight:700"><i class="ph-bold ph-whatsapp-logo"></i> <span>Preparing PDF…</span></button>' +
          '<div class="small text-muted mt-2">On a phone this opens your share menu: pick WhatsApp, then the customer.</div>'
        : '<div class="sm-note bad mt-3">PDF sharing is not set up on this page (jsPDF script missing).</div>') +
      '<button class="btn-soft mt-3" data-act="wa-send" type="button"><i class="ph-duotone ph-chat-text"></i>Send as text message instead</button></div>';

    // Build the PDF now so the Share click itself is synchronous (browsers only allow file sharing straight from a click).
    if (!pdfOk) { if (!shopInfo) fetchReceipt().then((r) => { shopInfo = r.shop || {}; }).catch(() => {}); return; }
    const ready = () => {
      const btn = $('wa-pdf');
      if (btn && waPrep && waPrep.id === s.id) { btn.disabled = false; btn.querySelector('span').textContent = 'Share PDF on WhatsApp'; }
    };
    if (waPrep && waPrep.id === s.id) { ready(); return; }
    fetchReceipt().then((r) => {
      shopInfo = r.shop || {};
      waPrep = { id: s.id, r, file: HD.receiptPdf.file(r) };
      ready();
    }).catch(() => { const btn = $('wa-pdf'); if (btn) btn.querySelector('span').textContent = 'PDF unavailable'; });
  }

  function shareWaPdf() {
    if (!waPrep) return;
    HD.receiptPdf.share(waPrep.file, { text: 'Receipt ' + state.sale.sale_number, phone: $('wa-phone').value }).then((res) => {
      if (res === 'downloaded') toast('PDF saved to this device. Attach it in the WhatsApp chat that just opened.');
    });
  }

  function sendWhatsApp() {
    const num = waNumber($('wa-phone').value);
    window.open((num ? 'https://wa.me/' + num : 'https://wa.me/') + '?text=' + encodeURIComponent(waMessage(state.sale, shopInfo)), '_blank', 'noopener');
  }

  // ------------------------------------------------------------------ events
  $('s-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    switch (b.dataset.act) {
      case 'back': viewDetail(); break;
      case 'close': modal.hide(); break;
      case 'print': printReceipt(b); break;
      case 'view-whatsapp': viewWhatsApp(); break;
      case 'wa-pdf': shareWaPdf(); break;
      case 'wa-send': sendWhatsApp(); break;
      case 'view-pay': viewPay(); break;
      case 'view-add': viewAddItems(); break;
      case 'ai-pick': aiPick(Number(b.dataset.i)); break;
      case 'ai-remove': aiCart.splice(Number(b.dataset.i), 1); drawAiCart(); break;
      case 'submit-add': submitAddItems(b); break;
      case 'view-void': viewVoid(); break;
      case 'view-return': viewReturn(); break;
      case 'submit-pay': submitPay(b); break;
      case 'submit-void': submitVoid(b); break;
      case 'submit-return': submitReturn(b); break;
      case 'delete-held': deleteHeld(b); break;
      default: break;
    }
  });

  $('s-body').addEventListener('input', (e) => {
    if (e.target.id === 'ai-search') aiSearchDebounced(e.target.value.trim());
  });
  $('s-body').addEventListener('change', (e) => {
    if (!e.target.classList.contains('ai-qty')) return;
    const l = aiCart[Number(e.target.dataset.i)]; if (!l) return;
    l.qty = Math.max(1, Math.floor(Number(e.target.value)) || 1);
    drawAiCart();
  });

  $('rows').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openSale(tr.dataset.id); });
  $('rows').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const tr = e.target.closest('tr[data-id]'); if (tr) openSale(tr.dataset.id);
  });

  $('f-search').addEventListener('input', debounce(() => reload(true), 300));
  $('f-status').addEventListener('change', () => reload(true));
  $('f-pay').addEventListener('change', () => reload(true));
  $('range-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]'); if (!b) return;
    applyRange(b.dataset.range); reload(true);
  });
  const dateChanged = () => {
    state.range = '';
    document.querySelectorAll('#range-seg button').forEach((b) => b.classList.remove('on'));
    reload(true);
  };
  $('f-from').addEventListener('change', dateChanged);
  $('f-to').addEventListener('change', dateChanged);

  $('pg-prev').addEventListener('click', () => { if (state.page > 1) { state.page--; load(); } });
  $('pg-next').addEventListener('click', () => { if (state.page < state.pages) { state.page++; load(); } });
  $('btn-refresh').addEventListener('click', () => { load(); shell.refreshNotifications(); });

  // ------------------------------------------------------------------ boot
  if (!can('sales.view')) {
    document.querySelector('.main').insertAdjacentHTML('beforeend', stateBox('ph-lock', 'You do not have permission to view sales.'));
    return;
  }
  modal = new bootstrap.Modal($('saleModal'));
  applyRange('30');
  load();
})();