(function () {
  'use strict';
  const { api, Session } = HD;
  const { shell, fmt } = HD;
  const { esc, num, money, compact } = fmt;
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

  // ------------------------------------------------------------------ shared config
  const PAY_LABEL = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank_transfer: 'Bank transfer', loyalty: 'Loyalty points', cheque: 'Cheque' };
  const PAY_COLOR = ['#1a1a1c', '#d8f03c', '#1d6b8a', '#3fb6a2', '#f0a020', '#9a9aa2'];

  const state = {
    from: '',
    to: '',
    preset: '30',
    trendMetric: 'sales',
    topBy: 'revenue',
    series: [],          // [{key, sales, count, profit}]
    topProducts: [],     // [{product_id, name, units_sold, revenue}]
    payments: [],        // [{method, amount, payments}]
    customers: [],       // [{...}]
    pnl: null,
    summary: null,
  };

  // ------------------------------------------------------------------ date helpers
  function presetRange(preset) {
    const today = new Date();
    const pad = (d) => d.toISOString().slice(0, 10);
    const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };
    switch (preset) {
      case '7':   return { from: pad(daysAgo(6)), to: pad(today) };
      case '30':  return { from: pad(daysAgo(29)), to: pad(today) };
      case '90':  return { from: pad(daysAgo(89)), to: pad(today) };
      case 'mtd': return { from: pad(new Date(today.getFullYear(), today.getMonth(), 1)), to: pad(today) };
      case 'last-month': {
        const firstThis = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastPrev = new Date(firstThis); lastPrev.setDate(0);
        const firstPrev = new Date(lastPrev.getFullYear(), lastPrev.getMonth(), 1);
        return { from: pad(firstPrev), to: pad(lastPrev) };
      }
      case 'ytd': return { from: pad(new Date(today.getFullYear(), 0, 1)), to: pad(today) };
      default:    return { from: pad(daysAgo(29)), to: pad(today) };
    }
  }

  function rangeLabel(from, to) {
    if (!from && !to) return 'All time';
    if (from && to && from === to) return fmt.dayLabel(from, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const f = from ? fmt.dayLabel(from, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Beginning';
    const t = to ? fmt.dayLabel(to, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Today';
    return `${f} → ${t}`;
  }

  function qs(extra) {
    const p = new URLSearchParams();
    if (state.from) p.set('from', state.from);
    if (state.to) p.set('to', state.to);
    if (extra) Object.entries(extra).forEach(([k, v]) => p.set(k, v));
    return p.toString();
  }

  // ------------------------------------------------------------------ CSV export
  function toCsv(rows, columns) {
    const esc_ = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = columns.map(c => esc_(c.label)).join(',');
    const body = rows.map(r => columns.map(c => esc_(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(',')).join('\n');
    return header + '\n' + body;
  }

  function downloadCsv(filename, csv) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportWith(kind) {
    const stamp = fmt.today();
    try {
      if (kind === 'trend') {
        if (!state.series.length) return toast('Nothing to export', true);
        const cols = [
          { label: 'Date', value: r => r.key },
          { label: 'Gross sales (KES)', value: r => Number(r.sales).toFixed(2) },
          { label: 'Orders', value: r => r.count },
          { label: 'Gross profit (KES)', value: r => Number(r.profit).toFixed(2) },
        ];
        downloadCsv(`sales-trend-${stamp}.csv`, toCsv(state.series, cols));
      } else if (kind === 'payments') {
        if (!state.payments.length) return toast('Nothing to export', true);
        const cols = [
          { label: 'Method', value: r => PAY_LABEL[r.method] || r.method },
          { label: 'Amount (KES)', value: r => Number(r.amount).toFixed(2) },
          { label: 'Payments', value: r => r.payments },
        ];
        downloadCsv(`payments-${stamp}.csv`, toCsv(state.payments, cols));
      } else if (kind === 'top') {
        if (!state.topProducts.length) return toast('Nothing to export', true);
        const cols = [
          { label: 'Product', value: r => r.name },
          { label: 'Units sold', value: r => r.units_sold },
          { label: 'Revenue (KES)', value: r => Number(r.revenue).toFixed(2) },
        ];
        downloadCsv(`top-products-${stamp}.csv`, toCsv(state.topProducts, cols));
      } else if (kind === 'customers') {
        if (!state.customers.length) return toast('Nothing to export', true);
        const cols = [
          { label: 'Code', value: r => r.customer_code },
          { label: 'Name', value: r => r.full_name },
          { label: 'Phone', value: r => r.phone || '' },
          { label: 'Total spent (KES)', value: r => Number(r.total_spent).toFixed(2) },
          { label: 'Purchases', value: r => r.purchase_count },
          { label: 'Visits', value: r => r.visit_count },
        ];
        downloadCsv(`top-customers-${stamp}.csv`, toCsv(state.customers, cols));
      } else if (kind === 'pnl') {
        if (!state.pnl) return toast('Nothing to export', true);
        const rows = [
          { label: 'Net sales', amount: Number(state.pnl.net_sales).toFixed(2) },
          { label: 'Estimated gross profit', amount: Number(state.pnl.estimated_gross_profit).toFixed(2) },
          { label: 'Expenses', amount: Number(state.pnl.expenses).toFixed(2) },
          { label: 'Estimated net profit', amount: Number(state.pnl.estimated_net_profit).toFixed(2) },
        ];
        downloadCsv(`profit-and-loss-${stamp}.csv`, toCsv(rows, [
          { label: 'Line', value: 'label' },
          { label: 'Amount (KES)', value: 'amount' },
        ]));
      }
      toast('CSV downloaded');
    } catch (err) {
      toast('Export failed: ' + err.message, true);
    }
  }

  // ------------------------------------------------------------------ KPI strip
  async function loadKpis() {
    const [summary, pnl] = await Promise.all([
      api(`/reports/sales-summary?${qs()}`),
      api(`/reports/profit-and-loss?${qs()}`),
    ]);
    state.summary = summary;
    state.pnl = pnl;

    const net = Number(summary.net_sales);
    const orders = Number(summary.sales_count);
    const estGP = Number(summary.estimated_gross_profit);
    const estNP = Number(pnl.estimated_net_profit);

    setKpi('kpi-net', `<small>KES</small>${num(net)}`,
      `Gross ${money(summary.gross_sales)} · refunds ${money(summary.refunds)}`);
    setKpi('kpi-orders', num(orders),
      orders ? `Avg ticket ${money(net / orders)}` : 'No orders in this period');
    setKpi('kpi-profit', `<small>KES</small>${num(estGP)}`,
      `VAT collected ${money(summary.vat)} · discounts ${money(summary.sale_discounts)}`);
    setKpi('kpi-net-profit', `<small>KES</small>${num(estNP)}`,
      `Expenses ${money(pnl.expenses)}`);
  }

  function setKpi(id, valueHtml, footHtml) {
    const el = $(id);
    el.classList.remove('sk');
    el.innerHTML = valueHtml;
    const card = el.closest('.stat');
    if (!card) return;
    const f = card.querySelector('.s-foot');
    if (f) { f.classList.remove('sk'); f.innerHTML = footHtml || ''; }
  }

  // ------------------------------------------------------------------ line chart (reuse dashboard logic)
  const niceMax = (v) => {
    if (v <= 0) return 1000;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s * p >= v) || 10) * p;
  };

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

  let trendChart = null;

  async function loadTrend() {
    const rows = await api(`/reports/sales-by-day?${qs()}`);
    const byDay = new Map(rows.map((r) => [fmt.dateKey(r.sale_date), r]));

    // If range is bounded, fill in every day. Otherwise use the returned rows.
    if (state.from && state.to) {
      const series = [];
      const start = new Date(state.from), end = new Date(state.to);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const key = d.toISOString().slice(0, 10);
        const r = byDay.get(key);
        series.push({
          key,
          sales: r ? Number(r.gross_sales) : 0,
          count: r ? Number(r.sales_count) : 0,
          profit: r ? Number(r.gross_profit) : 0,
        });
      }
      state.series = series;
    } else {
      state.series = rows.slice().reverse().map((r) => ({
        key: fmt.dateKey(r.sale_date),
        sales: Number(r.gross_sales),
        count: Number(r.sales_count),
        profit: Number(r.gross_profit),
      }));
    }
    renderTrend();
  }

  function renderTrend() {
    const box = $('trend-box');
    const data = state.series;
    if (!data.length) {
      box.innerHTML = '<div class="state-box"><i class="ph-duotone ph-chart-line"></i><div>No sales in this period</div></div>';
      $('trend-kpis').innerHTML = '';
      return;
    }

    const metric = state.trendMetric;
    const valueOf = (d) => metric === 'count' ? d.count : metric === 'profit' ? d.profit : d.sales;
    const labelOf = () => metric === 'count' ? 'orders' : metric === 'profit' ? 'gross profit' : 'gross sales';

    const total = data.reduce((s, d) => s + valueOf(d), 0);
    const orders = data.reduce((s, d) => s + d.count, 0);
    const profit = data.reduce((s, d) => s + d.profit, 0);
    const sales = data.reduce((s, d) => s + d.sales, 0);

    $('trend-kpis').innerHTML =
      `<div class="k"><b>${money(sales)}</b><span>Gross sales</span></div>` +
      `<div class="k"><b>${num(orders)}</b><span>Orders</span></div>` +
      `<div class="k"><b>${money(profit)}</b><span>Gross profit</span></div>` +
      `<div class="k"><b>${money(sales / data.length)}</b><span>Daily average</span></div>`;

    const W = Math.max(box.clientWidth, 280), H = 250, m = { l: 48, r: 10, t: 12, b: 28 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const max = niceMax(Math.max(...data.map(valueOf), 0));
    const x = (i) => m.l + (i * iw) / Math.max(data.length - 1, 1);
    const y = (v) => m.t + ih - (v / max) * ih;
    const pts = data.map((d, i) => ({ x: x(i), y: y(valueOf(d)) }));
    const line = smoothPath(pts);
    const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${m.t + ih} L${pts[0].x.toFixed(1)},${m.t + ih} Z`;

    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4, yy = y(v);
      const val = metric === 'count' ? num(v) : compact(v);
      grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" stroke="#eeeee9" ${i ? 'stroke-dasharray="4 5"' : ''}/>` +
        `<text x="${m.l - 10}" y="${yy + 4}" text-anchor="end" font-size="11" font-weight="600" fill="#9a9aa2">${val}</text>`;
    }
    const every = Math.ceil(data.length / Math.max(Math.floor(iw / 62), 1));
    let xl = '';
    data.forEach((d, i) => {
      if ((data.length - 1 - i) % every) return;
      xl += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="11" font-weight="600" fill="#9a9aa2">${fmt.dayLabel(d.key)}</text>`;
    });

    const tipValue = (d) => metric === 'count' ? `${num(d.count)} orders`
      : metric === 'profit' ? money(d.profit) : money(d.sales);

    box.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Sales trend">` +
      '<defs><linearGradient id="gAreaR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d8f03c" stop-opacity=".55"/><stop offset="1" stop-color="#d8f03c" stop-opacity="0"/></linearGradient></defs>' +
      `${grid}${xl}<path d="${area}" fill="url(#gAreaR)"/>` +
      `<path d="${line}" fill="none" stroke="#a6c20d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
      '<line id="c-guide" y1="' + m.t + '" y2="' + (m.t + ih) + '" stroke="#1a1a1c" stroke-width="1.5" stroke-dasharray="3 4" opacity="0"/>' +
      '<circle id="c-dot" r="6" fill="#1a1a1c" stroke="#d8f03c" stroke-width="3" opacity="0"/></svg>' +
      '<div class="chart-tip" id="c-tip"></div>';

    trendChart = {
      data, W, H, m, iw, x, y, valueOf, tipValue, labelOf,
    };
  }

  function trendHover(e) {
    const c = trendChart; if (!c) return;
    const box = $('trend-box'), r = box.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * c.W;
    const i = Math.min(Math.max(Math.round(((px - c.m.l) / c.iw) * (c.data.length - 1)), 0), c.data.length - 1);
    const d = c.data[i], cx = c.x(i), cy = c.y(c.valueOf(d));
    const guide = $('c-guide'), dot = $('c-dot'), tip = $('c-tip'); if (!guide) return;
    guide.setAttribute('x1', cx); guide.setAttribute('x2', cx); guide.setAttribute('opacity', 1);
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('opacity', 1);
    tip.innerHTML = `<b>${c.tipValue(d)}</b><span>${fmt.dayLabel(d.key, { weekday: 'short', day: 'numeric', month: 'short' })}</span>`;
    const left = Math.min(Math.max((cx / c.W) * r.width, 70), r.width - 70);
    tip.style.left = left + 'px'; tip.style.top = ((cy / c.H) * r.height) + 'px'; tip.style.opacity = 1;
  }

  function trendLeave() {
    ['c-guide', 'c-dot'].forEach((id) => { const el = $(id); if (el) el.setAttribute('opacity', 0); });
    const tip = $('c-tip'); if (tip) tip.style.opacity = 0;
  }

  // ------------------------------------------------------------------ payment donut
  async function loadPayments() {
    const rows = (await api(`/reports/payment-breakdown?${qs()}`)).filter((r) => Number(r.amount) > 0);
    state.payments = rows;
    const el = $('pay-body');
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    if (!total) {
      el.innerHTML = '<div class="state-box"><i class="ph-duotone ph-chart-donut"></i><div>No payments in this period</div></div>';
      return;
    }
    let offset = 0, segs = '';
    const gap = rows.length > 1 ? 1.2 : 0;
    rows.forEach((r, i) => {
      const pct = (Number(r.amount) / total) * 100;
      segs += `<circle cx="21" cy="21" r="15.9155" fill="none" stroke="${PAY_COLOR[i % PAY_COLOR.length]}" stroke-width="5" stroke-dasharray="${Math.max(pct - gap, 0.1)} ${100 - Math.max(pct - gap, 0.1)}" stroke-dashoffset="${-offset}"/>`;
      offset += pct;
    });
    el.innerHTML =
      `<div class="donut-wrap"><div class="donut"><svg viewBox="0 0 42 42"><circle cx="21" cy="21" r="15.9155" fill="none" stroke="#f0f0ec" stroke-width="5"/>${segs}</svg>` +
      `<div class="mid"><b>${money(total)}</b><span>received</span></div></div>` +
      '<div class="legend">' + rows.map((r, i) =>
        `<div class="row-l"><span class="sw" style="background:${PAY_COLOR[i % PAY_COLOR.length]}"></span>${esc(PAY_LABEL[r.method] || r.method)}` +
        `<span class="amt">${money(r.amount)}</span><span class="pct">${Math.round((Number(r.amount) / total) * 100)}%</span></div>`).join('') + '</div></div>';
  }

  // ------------------------------------------------------------------ top products (bar)
  async function loadTop() {
    const rows = await api(`/reports/top-products?${qs({ by: state.topBy, limit: 10 })}`);
    state.topProducts = rows;
    const el = $('top-body');
    if (!rows.length) {
      el.innerHTML = '<div class="state-box"><i class="ph-duotone ph-trophy"></i><div>No product sales in this period</div></div>';
      return;
    }
    const valOf = (r) => state.topBy === 'quantity' ? Number(r.units_sold) : Number(r.revenue);
    const fmtOf = (r) => state.topBy === 'quantity' ? `${num(r.units_sold)} units` : money(r.revenue);
    const max = Math.max(...rows.map(valOf), 1);
    const alt = state.topBy === 'quantity';

    el.innerHTML = '<div class="bar-chart">' + rows.map((r) => {
      const pct = Math.max((valOf(r) / max) * 100, 2);
      return `<div class="row">
        <div class="lbl" title="${esc(r.name)}">${esc(r.name)}</div>
        <div class="track"><div class="fill ${alt ? 'alt' : ''}" style="width:${pct}%"></div></div>
        <div class="val">${fmtOf(r)}</div>
      </div>`;
    }).join('') + '</div>';
  }

  // ------------------------------------------------------------------ top customers
  async function loadCustomers() {
    const rows = await api('/reports/top-customers?limit=10');
    state.customers = rows;
    const el = $('cust-body');
    if (!rows.length) {
      el.innerHTML = '<div class="state-box"><i class="ph-duotone ph-users-three"></i><div>No customer purchases yet</div></div>';
      return;
    }
    el.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Customer</th><th class="num">Spent</th><th class="num">Orders</th><th class="num">Visits</th></tr></thead><tbody>' +
      rows.map((c) =>
        `<tr><td><div class="cell-main"><span class="thumb"><i class="ph-duotone ph-user"></i></span><div><b>${esc(c.full_name)}</b><small>${esc(c.phone || c.customer_code || '')}</small></div></div></td>` +
        `<td class="num"><b>${money(c.total_spent)}</b></td>` +
        `<td class="num">${num(c.purchase_count)}</td>` +
        `<td class="num">${num(c.visit_count)}</td></tr>`).join('') +
      '</tbody></table></div>';
  }

  // ------------------------------------------------------------------ P&L
  async function loadPnl() {
    const pnl = state.pnl || await api(`/reports/profit-and-loss?${qs()}`);
    state.pnl = pnl;
    const net = Number(pnl.net_sales);
    const gp = Number(pnl.estimated_gross_profit);
    const exp = Number(pnl.expenses);
    const np = Number(pnl.estimated_net_profit);
    const gpPct = net ? ((gp / net) * 100).toFixed(1) : '0.0';
    const npPct = net ? ((np / net) * 100).toFixed(1) : '0.0';

    $('pnl-body').innerHTML = `
      <table class="pnl-table">
        <thead><tr><th>Line</th><th class="amount">Amount</th><th class="amount">% of net sales</th></tr></thead>
        <tbody>
          <tr><td>Net sales</td><td class="amount">${money(net)}</td><td class="amount">100%</td></tr>
          <tr class="positive"><td>Estimated gross profit</td><td class="amount">${money(gp)}</td><td class="amount">${gpPct}%</td></tr>
          <tr class="negative"><td>Expenses</td><td class="amount">− ${money(exp)}</td><td class="amount">${net ? ((exp / net) * 100).toFixed(1) : '0.0'}%</td></tr>
          <tr class="total ${np < 0 ? 'negative' : ''}"><td>Estimated net profit</td><td class="amount">${money(np)}</td><td class="amount">${npPct}%</td></tr>
        </tbody>
      </table>`;
  }

  // ------------------------------------------------------------------ load everything
  async function loadAll() {
    const icon = $('btn-refresh').querySelector('i');
    icon.classList.add('spin');
    $('range-label').textContent = rangeLabel(state.from, state.to);

    const jobs = [
      loadKpis(),
      loadTrend(),
      loadPayments(),
      loadTop(),
      loadCustomers(),
    ];
    // loadPnl depends on state.pnl set by loadKpis but can fetch independently
    jobs.push(loadPnl());

    const results = await Promise.allSettled(jobs);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn('A report widget failed:', r.reason && r.reason.message);
      }
    });
    icon.classList.remove('spin');
  }

  // ------------------------------------------------------------------ events
  $('range-presets').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-preset]');
    if (!btn) return;
    state.preset = btn.dataset.preset;
    const { from, to } = presetRange(state.preset);
    state.from = from;
    state.to = to;
    $('range-from').value = from;
    $('range-to').value = to;
    $('range-presets').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    loadAll();
  });

  $('btn-apply-range').addEventListener('click', () => {
    const from = $('range-from').value;
    const to = $('range-to').value;
    if (from && to && from > to) { toast('"From" must be before "To"', true); return; }
    state.from = from;
    state.to = to;
    state.preset = '';
    $('range-presets').querySelectorAll('button').forEach((b) => b.classList.remove('on'));
    loadAll();
  });

  $('trend-metric').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-metric]');
    if (!btn) return;
    state.trendMetric = btn.dataset.metric;
    $('trend-metric').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    renderTrend();
  });

  $('top-metric').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-by]');
    if (!btn) return;
    state.topBy = btn.dataset.by;
    $('top-metric').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    loadTop();
  });

  document.querySelectorAll('.export-btn').forEach((btn) => {
    btn.addEventListener('click', () => exportWith(btn.dataset.export));
  });

  $('btn-refresh').addEventListener('click', loadAll);
  $('btn-print').addEventListener('click', () => window.print());

  $('trend-box').addEventListener('pointermove', trendHover);
  $('trend-box').addEventListener('pointerleave', trendLeave);

  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { if (state.series.length) renderTrend(); });
  }).observe($('trend-box'));

  // ------------------------------------------------------------------ boot
  (function init() {
    const { from, to } = presetRange('30');
    state.from = from;
    state.to = to;
    $('range-from').value = from;
    $('range-to').value = to;
    loadAll();
  })();

  if (shell.refreshNotifications) shell.refreshNotifications();
})();