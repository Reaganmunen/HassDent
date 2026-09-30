(function () {
  'use strict';
  const { api } = HD;
  const { shell, fmt } = HD;
  const { esc, num, money } = fmt;
  const $ = (id) => document.getElementById(id);
  const can = shell.can;
  const LIMIT = 20;

  const state = { tab: 'levels', locations: [], levels: [], low: [], expiring: [], q: '',
    mov: { page: 1, location: '', type: '', from: '', to: '' }, take: null, m: { mode: 'adjust', lines: [] } };
  const mModal = new bootstrap.Modal($('mModal'));
  const nModal = new bootstrap.Modal($('nModal'));
  const cModal = new bootstrap.Modal($('cModal'));

  const TYPES = { opening: ['Opening', 'ok'], purchase: ['Purchase', 'ok'], sale: ['Sale', 'partial'], sale_return: ['Sale return', 'ok'],
    supplier_return: ['Supplier return', 'soon'], adjustment: ['Adjustment', 'soon'], damage: ['Damaged', 'gone'], expiry_writeoff: ['Expired', 'gone'],
    transfer_in: ['Transfer in', 'ok'], transfer_out: ['Transfer out', 'soon'], stock_take: ['Count', 'soon'] };

  const stateBox = (icon, text, retry) =>
    `<div class="state-box"><i class="ph-duotone ${icon}"></i><div>${esc(text)}</div>${retry ? '<button class="retry" type="button">Try again</button>' : ''}</div>`;
  const opts = (rows, sel) => rows.map((r) => `<option value="${r.id}"${String(r.id) === String(sel) ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
  const dateLbl = (d) => fmt.dayLabel(fmt.dateKey(d), { day: 'numeric', month: 'short', year: 'numeric' });
  const showErr = (id, msg) => { const b = $(id); b.hidden = !msg; b.querySelector('span').textContent = msg || ''; };
  let flashTimer;
  function flash(msg) { const f = $('flash'); f.querySelector('span').textContent = msg; f.hidden = false; clearTimeout(flashTimer); flashTimer = setTimeout(() => { f.hidden = true; }, 4500); }
  function fail(el, err, again) {
    el.innerHTML = stateBox(err.code === 'NETWORK_ERROR' ? 'ph-wifi-slash' : 'ph-warning-circle', err.message, true);
    el.querySelector('.retry').addEventListener('click', again);
  }

  // ------------------------------------------------------------------ stats + base data
  function setStat(id, v, f) {
    const c = $(id), ve = c.querySelector('[data-v]'), fe = c.querySelector('[data-f]');
    ve.classList.remove('sk'); fe.classList.remove('sk'); ve.innerHTML = v; fe.innerHTML = f;
  }

  async function loadBase() {
    $('btn-refresh').querySelector('i').classList.add('spin');
    try {
      const [levels, low, expiring] = await Promise.all([api('/stock/levels'), api('/stock/low'), api('/stock/expiring')]);
      Object.assign(state, { levels, low, expiring });
      setStat('stat-units', num(levels.reduce((s, r) => s + Number(r.on_hand), 0)), `${num(new Set(levels.map((r) => r.product_id)).size)} products stocked`);
      setStat('stat-low', num(low.length), low.length ? 'At or below reorder level' : 'Everything is above reorder level');
      const gone = expiring.filter((r) => r.is_expired).length;
      setStat('stat-exp', num(expiring.length), expiring.length ? `${num(gone)} already expired` : 'No batches close to expiry');
    } catch (err) { fail($('panel'), err, loadBase); }
    if (can('reports.view')) {
      api('/stock/valuation').then((rows) => setStat('stat-value', `<small>KES</small>${num(rows.reduce((s, r) => s + Number(r.value), 0))}`,
        rows.map((r) => `${esc(r.location)} ${fmt.compact(r.value)}`).join(' · ') || 'At cost price')).catch(() => {});
      api('/stock/integrity').then((r) => {
        const b = $('integrity'); b.hidden = r.healthy;
        if (!r.healthy) b.querySelector('span').textContent = `Stock balances disagree with the movement ledger for ${r.problems.length} item(s). Investigate before trusting these numbers.`;
      }).catch(() => {});
    }
    $('btn-refresh').querySelector('i').classList.remove('spin');
    showTab();
  }

  // ------------------------------------------------------------------ tabs
  function tools() {
    const t = $('tools');
    if (state.tab === 'levels') t.innerHTML = `<input class="form-control" type="search" id="t-q" placeholder="Filter products" value="${esc(state.q)}">`;
    else if (state.tab === 'movements') {
      const m = state.mov;
      t.innerHTML = `<select class="form-select" id="t-loc"><option value="">All locations</option>${opts(state.locations, m.location)}</select>` +
        `<select class="form-select" id="t-type"><option value="">All types</option>${Object.entries(TYPES).map(([k, v]) => `<option value="${k}"${m.type === k ? ' selected' : ''}>${v[0]}</option>`).join('')}</select>` +
        `<input class="form-control" type="date" id="t-from" value="${m.from}" aria-label="From"><input class="form-control" type="date" id="t-to" value="${m.to}" aria-label="To">`;
    } else if (state.tab === 'takes') t.innerHTML = '<button class="btn btn-hd" type="button" id="t-new"><i class="ph-bold ph-plus"></i> New count</button>';
    else t.innerHTML = '';
  }

  function showTab() {
    tools(); $('pager').hidden = true;
    ({ levels: renderLevels, movements: loadMovements, low: renderLow, expiring: renderExpiring, takes: loadTakes })[state.tab]();
  }

  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    state.tab = b.dataset.tab;
    $('tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    showTab();
  });

  $('tools').addEventListener('input', (e) => { if (e.target.id === 't-q') { state.q = e.target.value; renderLevels(); } });
  $('tools').addEventListener('change', (e) => {
    const map = { 't-loc': 'location', 't-type': 'type', 't-from': 'from', 't-to': 'to' };
    if (map[e.target.id]) { state.mov[map[e.target.id]] = e.target.value; state.mov.page = 1; loadMovements(); }
  });
  $('tools').addEventListener('click', (e) => { if (e.target.closest('#t-new')) openNewCount(); });
  $('btn-refresh').addEventListener('click', loadBase);

  // ------------------------------------------------------------------ levels (one row per product, a column per location)
  function renderLevels() {
    const lowIds = new Set(state.low.map((r) => r.product_id));
    const by = new Map();
    state.levels.forEach((r) => {
      const p = by.get(r.product_id) || { id: r.product_id, name: r.name, sku: r.sku, loc: {}, total: 0 };
      p.loc[r.location_id] = Number(r.on_hand); p.total += Number(r.on_hand); by.set(r.product_id, p);
    });
    const q = state.q.trim().toLowerCase();
    const rows = [...by.values()].filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.sku).toLowerCase().includes(q));
    if (!rows.length) { $('panel').innerHTML = stateBox('ph-stack', q ? 'No products match your filter' : 'No stock recorded yet'); return; }
    $('panel').innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th>' + state.locations.map((l) => `<th class="num">${esc(l.name)}</th>`).join('') +
      '<th class="num">Total</th><th></th></tr></thead><tbody>' + rows.map((p) =>
        `<tr><td><div class="cell-main"><span class="thumb"><i class="ph-duotone ph-package"></i></span><div class="trunc"><b>${esc(p.name)}</b><small>${esc(p.sku)}</small></div></div></td>` +
        state.locations.map((l) => `<td class="num${p.loc[l.id] ? '' : ' dim'}">${num(p.loc[l.id] || 0)}</td>`).join('') +
        `<td class="num"><b>${num(p.total)}</b></td><td>${lowIds.has(p.id) ? '<span class="pill soon">Low</span>' : ''}</td></tr>`).join('') + '</tbody></table></div>';
  }

  // ------------------------------------------------------------------ low stock / expiring
  function renderLow() {
    if (!state.low.length) { $('panel').innerHTML = stateBox('ph-seal-check', 'All products are above their reorder level'); return; }
    $('panel').innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th><th>On hand</th><th class="num">Reorder level</th><th class="num">Suggested order</th></tr></thead><tbody>' +
      state.low.map((r) => {
        const ratio = r.reorder_level > 0 ? Math.min(r.on_hand / r.reorder_level, 1) : 0;
        return `<tr><td><div class="cell-main"><span class="thumb"><i class="ph-duotone ph-package"></i></span><div class="trunc"><b>${esc(r.name)}</b><small>${esc(r.sku)}</small></div></div></td>` +
          `<td style="white-space:nowrap"><span class="meter"><i class="${ratio > .5 ? 'mid' : ''}" style="width:${Math.max(ratio * 100, 6)}%"></i></span>${num(r.on_hand)}</td>` +
          `<td class="num">${num(r.reorder_level)}</td><td class="num">${r.reorder_qty ? num(r.reorder_qty) : '–'}</td></tr>`;
      }).join('') + '</tbody></table></div>';
  }

  function renderExpiring() {
    if (!state.expiring.length) { $('panel').innerHTML = stateBox('ph-seal-check', 'No batches are close to expiry'); return; }
    $('panel').innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th><th>Batch</th><th>Expires</th><th class="num">Units</th></tr></thead><tbody>' +
      state.expiring.map((r) => {
        const left = Number(r.days_left);
        const p = r.is_expired ? '<span class="pill gone">Expired</span>' : `<span class="pill ${left <= 14 ? 'gone' : 'soon'}">${left} ${left === 1 ? 'day' : 'days'}</span>`;
        return `<tr><td><div class="cell-main"><span class="thumb"><i class="ph-duotone ph-hourglass-high"></i></span><b class="trunc">${esc(r.name)}</b></div></td><td>${esc(r.batch_number)}</td>` +
          `<td style="white-space:nowrap">${p} <small style="color:var(--hd-muted)">${dateLbl(r.expiry_date)}</small></td><td class="num">${num(r.on_hand)}</td></tr>`;
      }).join('') + '</tbody></table></div>';
  }

  // ------------------------------------------------------------------ movements (ledger)
  async function loadMovements() {
    const m = state.mov, p = new URLSearchParams({ page: m.page, limit: LIMIT });
    if (m.location) p.set('location_id', m.location);
    if (m.type) p.set('movement_type', m.type);
    if (m.from) p.set('from', m.from);
    if (m.to) p.set('to', m.to);
    $('panel').innerHTML = '<div class="sk sk-line"></div><div class="sk sk-line"></div><div class="sk sk-line"></div><div class="sk sk-line"></div>';
    try {
      const rows = await api('/stock/movements?' + p);
      const locName = new Map(state.locations.map((l) => [l.id, l.name]));
      if (!rows.length) { $('panel').innerHTML = stateBox('ph-list-magnifying-glass', m.page > 1 ? 'No more movements' : 'No movements match your filters'); }
      else $('panel').innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Product</th><th>Type</th><th>Location</th><th class="num">Qty</th><th>By</th><th>Note</th></tr></thead><tbody>' +
        rows.map((r) => {
          const t = TYPES[r.movement_type] || [r.movement_type, 'off'], q = Number(r.quantity);
          return `<tr><td style="white-space:nowrap">${fmt.when(r.created_at)}</td><td><div class="trunc"><b>${esc(r.product_name)}</b>${r.batch_number ? `<small class="d-block text-muted fw-normal">Batch ${esc(r.batch_number)}</small>` : ''}</div></td>` +
            `<td><span class="pill ${t[1]}">${t[0]}</span></td><td>${esc(locName.get(r.location_id) || '')}</td><td class="num ${q > 0 ? 'q-in' : 'q-out'}">${q > 0 ? '+' : ''}${num(q)}</td>` +
            `<td>${esc(r.user_name || '–')}</td><td class="trunc">${esc(r.note || '')}</td></tr>`;
        }).join('') + '</tbody></table></div>';
      const pg = $('pager'); pg.hidden = m.page === 1 && rows.length < LIMIT;
      pg.innerHTML = `<span>Page ${m.page}</span><div class="btns"><button type="button" data-p="-1" ${m.page <= 1 ? 'disabled' : ''}>Newer</button><button type="button" data-p="1" ${rows.length < LIMIT ? 'disabled' : ''}>Older</button></div>`;
    } catch (err) { fail($('panel'), err, loadMovements); }
  }
  $('pager').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-p]'); if (!b) return;
    state.mov.page = Math.max(1, state.mov.page + Number(b.dataset.p)); loadMovements();
  });

  // ------------------------------------------------------------------ line editor shared by adjust + transfer
  const onHand = (pid, loc) => state.levels.filter((r) => r.product_id === pid && String(r.location_id) === String(loc)).reduce((s, r) => s + Number(r.on_hand), 0);
  const srcLoc = () => $('m-loc').value;

  function openMovement(mode) {
    state.m = { mode, lines: [] }; showErr('m-error', '');
    $('m-form').reset();
    const adjust = mode === 'adjust';
    $('m-title').textContent = adjust ? 'Adjust stock' : 'Transfer stock';
    $('m-loc-label').textContent = adjust ? 'Location' : 'From location';
    $('m-to-wrap').hidden = adjust; $('m-reason-wrap').hidden = !adjust;
    const def = state.locations.find((l) => l.is_default) || state.locations[0];
    $('m-loc').innerHTML = opts(state.locations, def && def.id);
    $('m-to').innerHTML = opts(state.locations, (state.locations.find((l) => !def || l.id !== def.id) || {}).id);
    $('m-save').textContent = adjust ? 'Save adjustment' : 'Transfer stock';
    $('m-results').hidden = true; drawLines(); mModal.show();
  }
  $('btn-adjust').addEventListener('click', () => openMovement('adjust'));
  $('btn-transfer').addEventListener('click', () => openMovement('transfer'));

  let searchTimer;
  $('m-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim(), box = $('m-results');
    if (q.length < 2) { box.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      try {
        const res = await api('/products?limit=8&search=' + encodeURIComponent(q));
        box.hidden = false;
        box.innerHTML = res.length ? res.map((p) => `<button type="button" data-id="${p.id}">${esc(p.name)}<small>${esc(p.sku)} · ${num(p.on_hand)} in stock</small></button>`).join('') : '<div class="none">No products found</div>';
        box._items = res;
      } catch (err) { box.hidden = false; box.innerHTML = `<div class="none">${esc(err.message)}</div>`; }
    }, 250);
  });
  $('m-results').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]'); if (!b) return;
    const p = $('m-results')._items.find((x) => String(x.id) === b.dataset.id);
    $('m-results').hidden = true; $('m-search').value = '';
    if (state.m.lines.some((l) => l.product_id === p.id)) return;
    const line = { product_id: p.id, name: p.name, sku: p.sku, tracks: p.tracks_expiry, batches: [], batch_id: '', qty: '' };
    state.m.lines.push(line); drawLines();
    if (line.tracks) loadBatches(line);
  });

  async function loadBatches(line) {
    try {
      line.batches = await api(`/stock/batches?product_id=${line.product_id}&location_id=${srcLoc()}` + (state.m.mode === 'adjust' ? '&with_stock=false' : ''));
      if (!line.batches.some((b) => String(b.id) === String(line.batch_id))) line.batch_id = '';
    } catch (e) { line.batches = []; }
    drawLines();
  }
  $('m-loc').addEventListener('change', () => { state.m.lines.forEach((l) => { if (l.tracks) loadBatches(l); }); drawLines(); });

  function drawLines() {
    const { lines, mode } = state.m;
    $('m-lines').innerHTML = lines.length ? lines.map((l, i) =>
      `<div class="line"><div class="nm"><b>${esc(l.name)}</b><small>${esc(l.sku)} · ${num(onHand(l.product_id, srcLoc()))} on hand here</small></div>` +
      (l.tracks ? `<select class="form-select" data-i="${i}" data-f="batch_id"><option value="">${mode === 'adjust' ? 'Pick a batch' : 'Earliest expiry first'}</option>` +
        l.batches.map((b) => `<option value="${b.id}"${String(b.id) === String(l.batch_id) ? ' selected' : ''}>${esc(b.batch_number)} · ${b.expiry_date ? dateLbl(b.expiry_date) : 'no expiry'} · ${num(b.on_hand)}</option>`).join('') + '</select>' : '<div class="small text-muted">No batch</div>') +
      `<input class="form-control" type="number" step="1" ${mode === 'transfer' ? 'min="1"' : ''} data-i="${i}" data-f="qty" placeholder="${mode === 'adjust' ? '+5 or -3' : 'Qty'}" value="${esc(l.qty)}" aria-label="Quantity">` +
      `<button class="mini-btn" type="button" data-rm="${i}" aria-label="Remove"><i class="ph-bold ph-x"></i></button></div>`).join('')
      : '<div class="empty">Search above to add products</div>';
  }
  $('m-lines').addEventListener('input', (e) => { const t = e.target; if (t.dataset.f) state.m.lines[t.dataset.i][t.dataset.f] = t.value; });
  $('m-lines').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { state.m.lines.splice(Number(b.dataset.rm), 1); drawLines(); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('.picker')) $('m-results').hidden = true; });

  $('m-form').addEventListener('submit', async (e) => {
    e.preventDefault(); showErr('m-error', '');
    const { mode, lines } = state.m;
    if (!lines.length) return showErr('m-error', 'Add at least one product.');
    const bad = lines.find((l) => !Number.isInteger(Number(l.qty)) || l.qty === '' || Number(l.qty) === 0 || (mode === 'transfer' && Number(l.qty) < 0));
    if (bad) return showErr('m-error', `Enter a whole-number quantity for "${bad.name}"${mode === 'transfer' ? ' (1 or more)' : ' (positive to add, negative to remove)'}.`);
    let path, body;
    if (mode === 'adjust') {
      path = '/stock/adjustments';
      body = { location_id: Number(srcLoc()), reason: $('m-reason').value, notes: $('m-notes').value.trim() || undefined,
        items: lines.map((l) => ({ product_id: l.product_id, quantity_change: Number(l.qty), batch_id: l.batch_id ? Number(l.batch_id) : undefined })) };
    } else {
      if (srcLoc() === $('m-to').value) return showErr('m-error', 'Choose two different locations.');
      path = '/stock/transfers';
      body = { from_location_id: Number(srcLoc()), to_location_id: Number($('m-to').value), notes: $('m-notes').value.trim() || undefined,
        items: lines.map((l) => ({ product_id: l.product_id, quantity: Number(l.qty), batch_id: l.batch_id ? Number(l.batch_id) : undefined })) };
    }
    const btn = $('m-save'); btn.disabled = true;
    try { await api(path, { method: 'POST', body }); mModal.hide(); flash(mode === 'adjust' ? 'Stock adjustment saved.' : 'Stock transferred.'); loadBase(); }
    catch (err) { showErr('m-error', err.message); }
    finally { btn.disabled = false; }
  });

  // ------------------------------------------------------------------ stock counts
  async function loadTakes() {
    $('panel').innerHTML = '<div class="sk sk-line"></div><div class="sk sk-line"></div><div class="sk sk-line"></div>';
    try {
      const rows = await api('/stock/takes?limit=30');
      if (!rows.length) { $('panel').innerHTML = stateBox('ph-clipboard-text', 'No stock counts yet. Start one to compare shelves against the system.'); return; }
      const pill = { in_progress: ['soon', 'In progress'], completed: ['ok', 'Completed'], cancelled: ['off', 'Cancelled'] };
      $('panel').innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Count</th><th>Location</th><th>Status</th><th>Progress</th><th>Started</th><th></th></tr></thead><tbody>' +
        rows.map((r) => `<tr class="clickable" data-take="${r.id}"><td><b>${esc(r.take_number)}</b><small class="d-block text-muted fw-normal">${esc(r.started_by_name || '')}</small></td><td>${esc(r.location)}</td>` +
          `<td><span class="pill ${pill[r.status][0]}">${pill[r.status][1]}</span></td><td>${num(r.counted_count)} / ${num(r.item_count)} counted</td><td style="white-space:nowrap">${fmt.when(r.started_at)}</td>` +
          `<td class="num"><i class="ph-bold ph-caret-right"></i></td></tr>`).join('') + '</tbody></table></div>';
    } catch (err) { fail($('panel'), err, loadTakes); }
  }
  $('panel').addEventListener('click', (e) => { const r = e.target.closest('tr[data-take]'); if (r) openTake(Number(r.dataset.take)); });

  function openNewCount() {
    showErr('n-error', ''); $('n-form').reset();
    const def = state.locations.find((l) => l.is_default) || state.locations[0];
    $('n-loc').innerHTML = opts(state.locations, def && def.id); nModal.show();
  }
  $('n-form').addEventListener('submit', async (e) => {
    e.preventDefault(); showErr('n-error', ''); const btn = $('n-save'); btn.disabled = true;
    try {
      const t = await api('/stock/takes', { method: 'POST', body: { location_id: Number($('n-loc').value), notes: $('n-notes').value.trim() || undefined } });
      nModal.hide(); loadTakes(); openTake(t.id);
    } catch (err) { showErr('n-error', err.message); } finally { btn.disabled = false; }
  });

  async function openTake(id) {
    showErr('c-error', ''); $('c-search').value = ''; $('c-body').innerHTML = '<div class="sk sk-line"></div><div class="sk sk-line"></div><div class="sk sk-line"></div>';
    $('c-complete').hidden = true; cModal.show();
    try { state.take = await api('/stock/takes/' + id); drawTake(); }
    catch (err) { fail($('c-body'), err, () => openTake(id)); }
  }

  function drawTake() {
    const t = state.take, open = t.status === 'in_progress', q = $('c-search').value.trim().toLowerCase();
    const counted = t.items.filter((i) => i.counted_qty != null).length;
    $('c-title').textContent = t.take_number;
    $('c-sub').textContent = `${(state.locations.find((l) => l.id === t.location_id) || {}).name || ''} · ${counted} of ${t.items.length} counted · ${t.status.replace('_', ' ')}`;
    $('c-complete').hidden = !open;
    const items = t.items.filter((i) => !q || i.product_name.toLowerCase().includes(q) || String(i.sku).toLowerCase().includes(q));
    if (!items.length) { $('c-body').innerHTML = stateBox('ph-clipboard-text', 'Nothing to show'); return; }
    $('c-body').innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th><th class="num">System</th><th class="num">Counted</th><th class="num">Variance</th></tr></thead><tbody>' +
      items.map((i) => `<tr><td><div class="trunc"><b>${esc(i.product_name)}</b><small class="d-block text-muted fw-normal">${esc(i.sku)}${i.batch_number ? ' · Batch ' + esc(i.batch_number) : ''}</small></div></td><td class="num">${num(i.system_qty)}</td>` +
        `<td class="num">${open ? `<input class="form-control count-in d-inline-block" type="number" min="0" step="1" data-item="${i.id}" value="${i.counted_qty == null ? '' : i.counted_qty}" aria-label="Counted quantity">` : (i.counted_qty == null ? '–' : num(i.counted_qty))}</td>` +
        `<td class="num" id="var-${i.id}">${varCell(i)}</td></tr>`).join('') + '</tbody></table></div>';
  }
  function varCell(i) {
    if (i.counted_qty == null) return '<span class="text-muted">–</span>';
    const v = Number(i.counted_qty) - Number(i.system_qty);
    return v === 0 ? '<span class="pill ok">Match</span>' : `<span class="pill ${v > 0 ? 'ok' : 'gone'}">${v > 0 ? '+' : ''}${num(v)}</span>`;
  }
  $('c-search').addEventListener('input', () => { if (state.take) drawTake(); });
  $('c-body').addEventListener('change', async (e) => {
    const inp = e.target.closest('input[data-item]'); if (!inp) return;
    const item = state.take.items.find((i) => String(i.id) === inp.dataset.item);
    if (inp.value === '' ) return;
    showErr('c-error', '');
    try {
      const row = await api(`/stock/takes/${state.take.id}/items/${item.id}`, { method: 'PATCH', body: { counted_qty: Number(inp.value) } });
      item.counted_qty = row.counted_qty; $(`var-${item.id}`).innerHTML = varCell(item); inp.classList.add('saved');
      $('c-sub').textContent = $('c-sub').textContent.replace(/\d+ of/, state.take.items.filter((i) => i.counted_qty != null).length + ' of');
    } catch (err) { showErr('c-error', err.message); }
  });
  $('c-complete').addEventListener('click', async () => {
    const t = state.take, changes = t.items.filter((i) => i.counted_qty != null && i.counted_qty !== i.system_qty).length;
    if (!confirm(`Complete ${t.take_number}? ${changes} counted variance(s) will be applied to stock. Uncounted items are left unchanged. This cannot be undone.`)) return;
    const btn = $('c-complete'); btn.disabled = true;
    try { const r = await api(`/stock/takes/${t.id}/complete`, { method: 'POST' }); cModal.hide(); flash(`${t.take_number} completed. ${r.adjusted_items} item(s) adjusted.`); loadBase(); }
    catch (err) { showErr('c-error', err.message); } finally { btn.disabled = false; }
  });

  // ------------------------------------------------------------------ boot
  (async function boot() {
    try { state.locations = (await api('/locations')).filter((l) => l.is_active !== false); } catch (e) { state.locations = []; }
    loadBase();
  })();
})();