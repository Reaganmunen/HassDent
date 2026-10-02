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
    if (completed || s.status === 'voided') a.push('<button class="btn-soft" data-act="print" type="button"><i class="ph-duotone ph-printer"></i>Print &amp; save receipt</button>');
    if (completed && balance > 0 && can('sales.create')) a.push('<button class="btn-soft" data-act="view-pay" type="button"><i class="ph-duotone ph-hand-coins"></i>Record payment</button>');
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

  // ---- receipt: A4 statement-style layout. Print also saves a PDF copy to the computer.
  // html2pdf is self-hosted (like bootstrap) and loaded on first use.
  const PDF_LIB = 'vendor/html2pdf/html2pdf.bundle.min.js';
  let pdfLibPromise = null;
  function loadPdfLib() {
    if (window.html2pdf) return Promise.resolve();
    if (!pdfLibPromise) {
      pdfLibPromise = new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = PDF_LIB;
        sc.onload = resolve;
        sc.onerror = () => { pdfLibPromise = null; reject(new Error('Could not load ' + PDF_LIB + '. Make sure the file is uploaded to your server.')); };
        document.head.appendChild(sc);
      });
    }
    return pdfLibPromise;
  }

  const RECEIPT_CSS = `
    .rcpt { font: 13px/1.5 Arial, Helvetica, sans-serif; color: #111; width: 100%; max-width: 718px; margin: 0 auto; padding: 4px 2px; box-sizing: border-box; background: #fff; position: relative; }
    .rcpt * { box-sizing: border-box; }
    .rcpt .shop { text-align: center; margin-bottom: 14px; }
    .rcpt .shop h1 { font-size: 30px; font-weight: 400; letter-spacing: .5px; margin: 0 0 6px; text-transform: uppercase; }
    .rcpt .shop .addr { font-size: 11px; margin-bottom: 10px; }
    .rcpt .shop .contact { font-size: 13px; line-height: 1.6; }
    .rcpt .doc-title { text-align: center; font-size: 24px; margin: 18px 0 14px; letter-spacing: 1px; }
    .rcpt .meta { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    .rcpt .meta .r { text-align: right; }
    .rcpt .meta b { font-weight: 700; }
    .rcpt .served { margin-bottom: 14px; }
    .rcpt table { width: 100%; border-collapse: collapse; }
    .rcpt thead th { text-align: left; font-weight: 700; font-size: 12px; text-transform: uppercase; padding: 6px 4px; border-bottom: 1px solid #ddd; }
    .rcpt tbody td { padding: 6px 4px; border-bottom: 1px solid #eee; vertical-align: top; }
    .rcpt tr { page-break-inside: avoid; }
    .rcpt .n { text-align: right; white-space: nowrap; }
    .rcpt .rule { border-top: 1px solid #222; margin: 22px 0 10px; }
    .rcpt .sum { display: flex; justify-content: space-between; gap: 28px; align-items: flex-start; page-break-inside: avoid; }
    .rcpt .sum > div { flex: 1; }
    .rcpt .sum .row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 4px; border-bottom: 1px solid #eee; }
    .rcpt .sum .row.b { font-weight: 700; }
    .rcpt .sum .row.due { font-weight: 700; color: #b00020; }
    .rcpt .sum .row small { color: #555; }
    .rcpt .pay-info { text-align: center; margin-top: 22px; font-style: italic; font-weight: 700; line-height: 2; }
    .rcpt .thanks { text-align: center; margin-top: 14px; }
    .rcpt .stamp { position: absolute; top: 38%; left: 50%; transform: translate(-50%, -50%) rotate(-18deg); border: 4px solid #b00020; color: #b00020; font-size: 56px; font-weight: 700; letter-spacing: 6px; padding: 4px 22px; opacity: .22; pointer-events: none; }
  `;

  function receiptBody({ shop, sale: s }) {
    shop = shop || {};
    const pays = (s.payments || []).filter((p) => p.status === 'completed');
    const completed = s.status === 'completed';
    const balance = completed ? (Number(s.balance) || 0) : 0;
    const row = (l, r, cls) => `<div class="row${cls ? ' ' + cls : ''}"><span>${l}</span><span>${r}</span></div>`;
    const kes = (v) => 'KSh ' + money2(v);
    const contact = [shop.phone, shop.email, shop.kra_pin ? 'PIN: ' + shop.kra_pin : ''].filter(Boolean).map(esc).join('<br>');
    const paybill = shop.paybill
      ? `<div class="pay-info">M-PESA PAYBILL<br>${esc(shop.paybill)}${shop.paybill_account ? '<br>ACC ' + esc(shop.paybill_account) : ''}</div>` : '';

    return `<div class="rcpt">
      ${s.status === 'voided' ? '<div class="stamp">VOIDED</div>' : ''}
      <div class="shop">
        <h1>${esc(shop.name || 'HassDent')}</h1>
        ${shop.address ? `<div class="addr">${esc(shop.address)}</div>` : ''}
        ${contact ? `<div class="contact">${contact}</div>` : ''}
      </div>
      <div class="doc-title">RECEIPT</div>
      <div class="meta">
        <div>
          <div><b>RECEIPT No.</b> ${esc(s.sale_number)}</div>
          <div><b>Customer</b></div>
          <div>${s.customer_name ? esc(s.customer_name) : 'Walk-in'}</div>
          ${s.customer_phone ? `<div><b>Mobile</b>: ${esc(s.customer_phone)}</div>` : ''}
        </div>
        <div class="r"><b>Date</b> ${esc(fmt.when(s.sold_at))}</div>
      </div>
      <div class="served"><b>Served by :</b> ${esc(s.sold_by_name || '—')}</div>

      <table>
        <thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Price</th><th class="n">Total</th></tr></thead>
        <tbody>${(s.items || []).map((i) => `<tr>
          <td>${esc(i.product_name)}${i.sku ? ' , ' + esc(i.sku) : ''}</td>
          <td class="n">${num(i.quantity)} Pc(s)</td>
          <td class="n">${money2(i.unit_price)}</td>
          <td class="n">${money2(i.line_total)}</td></tr>`).join('')}</tbody>
      </table>

      <div class="rule"></div>
      <div class="sum">
        <div>
          ${pays.map((p) => row(`${esc(PAY_LABEL[p.method] || p.method)}${p.reference ? ` <small>· ${esc(p.reference)}</small>` : ''}`, `${kes(p.amount)} <small>${esc(fmt.when(p.paid_at))}</small>`)).join('')}
          ${row('Total Paid', kes(s.amount_paid), 'b')}
          ${completed ? row('Total Due', kes(balance), balance > 0 ? 'due' : 'b') : ''}
        </div>
        <div>
          ${row('Subtotal:', kes(s.subtotal), 'b')}
          ${Number(s.discount_amount) > 0 ? row('Discount:', '− ' + kes(s.discount_amount)) : ''}
          ${Number(s.loyalty_discount) > 0 ? row('Loyalty:', '− ' + kes(s.loyalty_discount)) : ''}
          ${row('VAT included:', kes(s.tax_total))}
          ${row('Total:', kes(s.total), 'b')}
        </div>
      </div>
      ${paybill}
      <div class="thanks">${esc(shop.footer || 'Thank you for allowing us to serve you!')}</div>
    </div>`;
  }

  async function fetchReceipt() { return api(`/sales/${state.sale.id}/receipt`); }

  function receiptDoc(r) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.sale.sale_number)}</title><style>
      @page { size: A4; margin: 12mm; } body { margin: 0; } ${RECEIPT_CSS}</style></head><body>${receiptBody(r)}</body></html>`;
  }

  // builds the receipt as a real PDF and saves it to the computer
  async function saveReceiptPdf(r) {
    await loadPdfLib();
    const holder = document.createElement('div');
    // must be in the DOM for html2canvas; sits behind the page at A4 width minus margins
    holder.style.cssText = 'position:fixed;top:0;left:0;width:718px;background:#fff;z-index:-1;';
    holder.innerHTML = `<style>${RECEIPT_CSS}</style>${receiptBody(r)}`;
    document.body.appendChild(holder);
    try {
      await window.html2pdf().set({
        margin: [10, 10, 10, 10],
        filename: `Receipt-${r.sale.sale_number}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] },
      }).from(holder.querySelector('.rcpt')).save();
    } finally { holder.remove(); }
  }

  async function printReceipt(btn) {
    const w = window.open('', '_blank', 'width=900,height=800');   // open first so the pop-up isn't blocked
    if (!w) return toast('Allow pop-ups to print receipts', true);
    setBusy(btn, true, 'Preparing…');
    try {
      const r = await fetchReceipt();
      w.document.open(); w.document.write(receiptDoc(r)); w.document.close();
      w.focus(); setTimeout(() => w.print(), 350);
      // save the PDF too; a failure here must never block printing
      try { await saveReceiptPdf(r); toast('Receipt saved as PDF'); }
      catch (e) { toast('Printed, but the PDF could not be saved: ' + (e.message || 'unknown error'), true); }
    } catch (e) { w.close(); toast(e.message, true); }
    setBusy(btn, false);
  }

  // ------------------------------------------------------------------ events
  $('s-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    switch (b.dataset.act) {
      case 'back': viewDetail(); break;
      case 'close': modal.hide(); break;
      case 'print': printReceipt(b); break;
      case 'view-pay': viewPay(); break;
      case 'view-void': viewVoid(); break;
      case 'view-return': viewReturn(); break;
      case 'submit-pay': submitPay(b); break;
      case 'submit-void': submitVoid(b); break;
      case 'submit-return': submitReturn(b); break;
      case 'delete-held': deleteHeld(b); break;
      default: break;
    }
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