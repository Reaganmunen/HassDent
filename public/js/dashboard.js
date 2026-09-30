(function () {
  'use strict';
  const { api, Session } = HD;
  const { shell, fmt } = HD;
  const { esc, num, money, compact } = fmt;
  const can = shell.can;
  const $ = (id) => document.getElementById(id);

  const state = { series: [], range: 30, chart: null };
  const PAY_LABEL = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank_transfer: 'Bank transfer', loyalty: 'Loyalty points', cheque: 'Cheque' };
  const PAY_COLOR = ['#1a1a1c', '#d8f03c', '#1d6b8a', '#3fb6a2', '#f0a020', '#9a9aa2'];

  // ------------------------------------------------------------------ header
  const user = Session.user() || {};
  $('greeting').textContent = `${fmt.greeting()}, ${String(user.name || '').split(' ')[0] || 'there'} · ` +
    fmt.dayLabel(fmt.today(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (!can('reports.view')) $('quick-col').hidden = false;

  // ------------------------------------------------------------------ small building blocks
  const stateBox = (icon, text, retry) =>
    `<div class="state-box"><i class="ph-duotone ${icon}"></i><div>${esc(text)}</div>${retry ? '<button class="retry" type="button">Try again</button>' : ''}</div>`;

  /** Runs one widget. Skeletons stay until the first successful load; failures show a retry button inside the card. */
  async function widget(el, perm, load) {
    if (perm && !can(perm)) return;
    try { await load(); }
    catch (err) {
      el.innerHTML = stateBox(err.code === 'NETWORK_ERROR' ? 'ph-wifi-slash' : 'ph-warning-circle', err.message, true);
      el.querySelector('.retry').addEventListener('click', () => { el.innerHTML = '<div class="sk sk-line"></div><div class="sk sk-line"></div><div class="sk sk-line"></div>'; widget(el, perm, load); });
    }
  }

  // ------------------------------------------------------------------ stat cards
  function setStat(id, valueHtml, footHtml) {
    const card = $(id);
    const v = card.querySelector('[data-v]'), f = card.querySelector('[data-f]');
    v.classList.remove('sk'); f.classList.remove('sk');
    v.innerHTML = valueHtml; f.innerHTML = footHtml;
  }
  async function loadStats() {
    const d = await api('/reports/dashboard');
    const cur = (n) => `<small>KES</small>${num(n)}`;
    setStat('stat-sales', cur(d.today_sales), `<span class="chip"><i class="ph-bold ph-receipt"></i>${num(d.today_count)} ${d.today_count === 1 ? 'sale' : 'sales'}</span> today`);
    setStat('stat-stock', cur(d.stock_value), 'Valued at cost price');
    setStat('stat-credit', cur(d.unpaid_total), Number(d.unpaid_total) > 0 ? 'Unpaid on credit sales' : 'Nothing owed right now');
    setStat('stat-customers', num(d.customers), 'Active on your books');
  }

  // ------------------------------------------------------------------ sales trend chart
  async function loadSeries() {
    const to = fmt.today(), from = fmt.addDays(to, -29);
    const rows = await api(`/reports/sales-by-day?from=${from}&to=${to}`);
    const byDay = new Map(rows.map((r) => [fmt.dateKey(r.sale_date), r]));
    state.series = Array.from({ length: 30 }, (_, i) => {
      const key = fmt.addDays(from, i), r = byDay.get(key);
      return { key, sales: r ? Number(r.gross_sales) : 0, count: r ? Number(r.sales_count) : 0, profit: r ? Number(r.gross_profit) : 0 };
    });
    renderChart();
  }

  const niceMax = (v) => {
    if (v <= 0) return 1000;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s * p >= v) || 10) * p;
  };

  /** Monotone cubic path: smooth like the wireframe, never dips below a real data point. */
  function smoothPath(p) {
    const n = p.length; if (n < 2) return `M${p[0].x},${p[0].y}`;
    const dx = [], m = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1].x - p[i].x; m[i] = (p[i + 1].y - p[i].y) / dx[i]; }
    const t = [m[0]];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    t[n - 1] = m[n - 2];
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
      if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    let d = `M${p[0].x.toFixed(1)},${p[0].y.toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += ` C${(p[i].x + h).toFixed(1)},${(p[i].y + t[i] * h).toFixed(1)} ${(p[i + 1].x - h).toFixed(1)},${(p[i + 1].y - t[i + 1] * h).toFixed(1)} ${p[i + 1].x.toFixed(1)},${p[i + 1].y.toFixed(1)}`;
    }
    return d;
  }

  function renderChart() {
    const box = $('chart-box');
    const data = state.series.slice(-state.range);
    if (!data.length) return;

    const total = data.reduce((s, d) => s + d.sales, 0);
    const orders = data.reduce((s, d) => s + d.count, 0);
    const profit = data.reduce((s, d) => s + d.profit, 0);
    $('chart-kpis').innerHTML =
      `<div class="k"><b>${money(total)}</b><span>Gross sales</span></div>` +
      `<div class="k"><b>${num(orders)}</b><span>Orders</span></div>` +
      `<div class="k"><b>${money(profit)}</b><span>Gross profit</span></div>` +
      `<div class="k"><b>${money(total / data.length)}</b><span>Daily average</span></div>`;

    const W = Math.max(box.clientWidth, 280), H = 250, m = { l: 48, r: 10, t: 12, b: 28 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const max = niceMax(Math.max(...data.map((d) => d.sales)));
    const x = (i) => m.l + (i * iw) / (data.length - 1);
    const y = (v) => m.t + ih - (v / max) * ih;
    const pts = data.map((d, i) => ({ x: x(i), y: y(d.sales) }));
    const line = smoothPath(pts);
    const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${m.t + ih} L${pts[0].x.toFixed(1)},${m.t + ih} Z`;

    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4, yy = y(v);
      grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" stroke="#eeeee9" ${i ? 'stroke-dasharray="4 5"' : ''}/>` +
        `<text x="${m.l - 10}" y="${yy + 4}" text-anchor="end" font-size="11" font-weight="600" fill="#9a9aa2">${compact(v)}</text>`;
    }
    const every = Math.ceil(data.length / Math.max(Math.floor(iw / 62), 1));
    let xl = '';
    data.forEach((d, i) => {
      if ((data.length - 1 - i) % every) return;
      xl += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="11" font-weight="600" fill="#9a9aa2">${fmt.dayLabel(d.key)}</text>`;
    });

    box.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Daily gross sales">` +
      '<defs><linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d8f03c" stop-opacity=".55"/><stop offset="1" stop-color="#d8f03c" stop-opacity="0"/></linearGradient></defs>' +
      `${grid}${xl}<path d="${area}" fill="url(#gArea)"/>` +
      `<path d="${line}" fill="none" stroke="#a6c20d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
      '<line id="c-guide" y1="' + m.t + '" y2="' + (m.t + ih) + '" stroke="#1a1a1c" stroke-width="1.5" stroke-dasharray="3 4" opacity="0"/>' +
      '<circle id="c-dot" r="6" fill="#1a1a1c" stroke="#d8f03c" stroke-width="3" opacity="0"/></svg>' +
      '<div class="chart-tip" id="c-tip"></div>' +
      (total === 0 ? `<div class="state-box" style="position:absolute;inset:0;pointer-events:none;background:rgba(255,255,255,.6)"><i class="ph-duotone ph-chart-line"></i><div>No sales in this period yet</div></div>` : '');
    state.chart = { data, W, m, iw, x, y };
  }

  function chartHover(e) {
    const c = state.chart; if (!c) return;
    const box = $('chart-box'), r = box.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * c.W;
    const i = Math.min(Math.max(Math.round(((px - c.m.l) / c.iw) * (c.data.length - 1)), 0), c.data.length - 1);
    const d = c.data[i], cx = c.x(i), cy = c.y(d.sales);
    const guide = $('c-guide'), dot = $('c-dot'), tip = $('c-tip'); if (!guide) return;
    guide.setAttribute('x1', cx); guide.setAttribute('x2', cx); guide.setAttribute('opacity', 1);
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('opacity', 1);
    tip.innerHTML = `<b>${money(d.sales)}</b><span>${fmt.dayLabel(d.key, { weekday: 'short', day: 'numeric', month: 'short' })} · ${num(d.count)} ${d.count === 1 ? 'sale' : 'sales'}</span>`;
    const left = Math.min(Math.max((cx / c.W) * r.width, 70), r.width - 70);
    tip.style.left = left + 'px'; tip.style.top = ((cy / 250) * r.height) + 'px'; tip.style.opacity = 1;
  }
  function chartLeave() {
    ['c-guide', 'c-dot'].forEach((id) => { const el = $(id); if (el) el.setAttribute('opacity', 0); });
    const tip = $('c-tip'); if (tip) tip.style.opacity = 0;
  }
  $('chart-box').addEventListener('pointermove', chartHover);
  $('chart-box').addEventListener('pointerleave', chartLeave);
  $('range-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]'); if (!b) return;
    state.range = Number(b.dataset.range);
    $('range-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderChart();
  });
  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (state.series.length) renderChart(); }); }).observe($('chart-box'));

  // ------------------------------------------------------------------ payment mix donut
  async function loadPayments() {
    const to = fmt.today(), from = to.slice(0, 8) + '01';
    $('pay-period').textContent = fmt.dayLabel(to, { month: 'long' });
    const rows = (await api(`/reports/payment-breakdown?from=${from}&to=${to}`)).filter((r) => Number(r.amount) > 0);
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    if (!total) { $('pay-body').innerHTML = stateBox('ph-chart-donut', 'No payments received this month yet'); return; }
    let offset = 0, segs = '';
    const gap = rows.length > 1 ? 1.2 : 0;
    rows.forEach((r, i) => {
      const pct = (Number(r.amount) / total) * 100;
      segs += `<circle cx="21" cy="21" r="15.9155" fill="none" stroke="${PAY_COLOR[i % PAY_COLOR.length]}" stroke-width="5" stroke-dasharray="${Math.max(pct - gap, 0.1)} ${100 - Math.max(pct - gap, 0.1)}" stroke-dashoffset="${-offset}"/>`;
      offset += pct;
    });
    $('pay-body').innerHTML =
      `<div class="donut-wrap"><div class="donut"><svg viewBox="0 0 42 42"><circle cx="21" cy="21" r="15.9155" fill="none" stroke="#f0f0ec" stroke-width="5"/>${segs}</svg>` +
      `<div class="mid"><b>${money(total)}</b><span>received</span></div></div>` +
      '<div class="legend">' + rows.map((r, i) =>
        `<div class="row-l"><span class="sw" style="background:${PAY_COLOR[i % PAY_COLOR.length]}"></span>${esc(PAY_LABEL[r.method] || r.method)}` +
        `<span class="amt">${money(r.amount)}</span><span class="pct">${Math.round((Number(r.amount) / total) * 100)}%</span></div>`).join('') + '</div></div>';
  }

  // ------------------------------------------------------------------ recent sales
  async function loadSales() {
    const items = await api('/sales?limit=6');
    const el = $('sales-body');
    if (!items.length) { el.innerHTML = stateBox('ph-receipt', 'No sales recorded yet'); return; }
    const pill = (s) => {
      if (s.status === 'held') return '<span class="pill partial"><i class="ph-bold ph-pause"></i>Held</span>';
      if (s.status === 'voided') return '<span class="pill unpaid"><i class="ph-bold ph-x"></i>Voided</span>';
      const map = { paid: ['paid', 'Paid'], partial: ['partial', 'Partial'], unpaid: ['unpaid', 'Unpaid'] }[s.payment_status] || ['partial', s.payment_status];
      return `<span class="pill ${map[0]}">${map[1]}</span>`;
    };
    el.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Sale</th><th>Customer</th><th>When</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>' +
      items.map((s) =>
        `<tr><td><div class="cell-main"><span class="thumb"><i class="ph-duotone ph-receipt"></i></span><div><b>${esc(s.sale_number)}</b><small>${esc(s.sold_by_name || '')}</small></div></div></td>` +
        `<td class="trunc">${esc(s.customer_name || 'Walk-in')}</td><td style="white-space:nowrap">${fmt.when(s.sold_at)}</td><td>${pill(s)}</td>` +
        `<td class="num">${money(s.total)}</td></tr>`).join('') + '</tbody></table></div>';
  }

  // ------------------------------------------------------------------ top products
  async function loadTop() {
    const to = fmt.today(), from = fmt.addDays(to, -29);
    const rows = await api(`/reports/top-products?from=${from}&to=${to}&limit=5`);
    const el = $('top-body');
    if (!rows.length) { el.innerHTML = stateBox('ph-trophy', 'Top sellers will appear once sales start coming in'); return; }
    const max = Math.max(...rows.map((r) => Number(r.revenue))) || 1;
    el.innerHTML = '<div class="rank">' + rows.map((r, i) =>
      `<div class="r"><span class="n">${i + 1}</span><div class="body"><div class="t"><span>${esc(r.name)}</span><span>${money(r.revenue)}</span></div>` +
      `<div class="bar"><i style="width:${Math.max((Number(r.revenue) / max) * 100, 3)}%"></i></div><small>${num(r.units_sold)} units sold</small></div></div>`).join('') + '</div>';
  }

  // ------------------------------------------------------------------ stock alerts
  async function loadLow() {
    const rows = await api('/stock/low');
    const el = $('low-body'), pill = $('low-count');
    pill.hidden = !rows.length; pill.textContent = rows.length;
    if (!rows.length) { el.innerHTML = stateBox('ph-seal-check', 'All products are above their reorder level'); return; }
    el.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th><th>On hand</th><th class="num">Reorder qty</th></tr></thead><tbody>' +
      rows.slice(0, 6).map((r) => {
        const ratio = r.reorder_level > 0 ? Math.min(r.on_hand / r.reorder_level, 1) : 0;
        return `<tr><td><div class="cell-main"><span class="thumb"><i class="ph-duotone ph-package"></i></span><div class="trunc"><b>${esc(r.name)}</b><small>${esc(r.sku || '')}</small></div></div></td>` +
          `<td style="white-space:nowrap"><span class="meter"><i class="${ratio > .5 ? 'mid' : ''}" style="width:${Math.max(ratio * 100, 6)}%"></i></span>${num(r.on_hand)} <small style="color:var(--hd-muted)">/ ${num(r.reorder_level)}</small></td>` +
          `<td class="num">${r.reorder_qty ? num(r.reorder_qty) : '–'}</td></tr>`;
      }).join('') + '</tbody></table></div>' +
      (rows.length > 6 ? `<div class="text-center mt-2"><a class="see-all justify-content-center" style="margin:0" href="/stock.html">+ ${rows.length - 6} more</a></div>` : '');
  }

  async function loadExpiring() {
    const rows = await api('/stock/expiring');
    const el = $('exp-body'), pill = $('exp-count');
    pill.hidden = !rows.length; pill.textContent = rows.length;
    if (!rows.length) { el.innerHTML = stateBox('ph-seal-check', 'No batches are close to expiry'); return; }
    el.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th><th>Expires</th><th class="num">Units</th></tr></thead><tbody>' +
      rows.slice(0, 6).map((r) => {
        const left = Number(r.days_left);
        const p = r.is_expired ? '<span class="pill gone">Expired</span>' : `<span class="pill ${left <= 14 ? 'gone' : 'soon'}">${left} ${left === 1 ? 'day' : 'days'}</span>`;
        return `<tr><td><div class="cell-main"><span class="thumb"><i class="ph-duotone ph-hourglass-high"></i></span><div class="trunc"><b>${esc(r.name)}</b><small>Batch ${esc(r.batch_number)}</small></div></div></td>` +
          `<td style="white-space:nowrap">${p}<div><small style="color:var(--hd-muted);font-weight:500">${fmt.dayLabel(fmt.dateKey(r.expiry_date), { day: 'numeric', month: 'short', year: 'numeric' })}</small></div></td>` +
          `<td class="num">${num(r.on_hand)}</td></tr>`;
      }).join('') + '</tbody></table></div>' +
      (rows.length > 6 ? `<div class="text-center mt-2"><a class="see-all justify-content-center" style="margin:0" href="/stock.html">+ ${rows.length - 6} more</a></div>` : '');
  }

  // ------------------------------------------------------------------ load everything
  let syncedAlerts = false;
  async function loadAll() {
    const icon = $('btn-refresh').querySelector('i');
    icon.classList.add('spin');
    // Create any missing low-stock / expiry notifications once per visit, then refresh the bell.
    const alerts = (!syncedAlerts && (can('stock.view') || can('reports.view')))
      ? api('/notifications/sync', { method: 'POST' }).catch(() => {}).then(() => { syncedAlerts = true; shell.refreshNotifications(); })
      : shell.refreshNotifications();

    await Promise.all([
      alerts,
      widget($('stat-sales'), 'reports.view', loadStats).then(() => {}),
      widget($('chart-box'), 'reports.view', loadSeries),
      widget($('pay-body'), 'reports.view', loadPayments),
      widget($('sales-body'), 'sales.view', loadSales),
      widget($('top-body'), 'reports.view', loadTop),
      widget($('low-body'), 'stock.view', loadLow),
      widget($('exp-body'), 'stock.view', loadExpiring),
    ]);
    icon.classList.remove('spin');
  }

  $('btn-refresh').addEventListener('click', loadAll);
  loadAll();
  setInterval(() => { if (!document.hidden) loadAll(); }, 5 * 60 * 1000);
})();