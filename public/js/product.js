(function () {
  'use strict';
  const { api } = HD;
  const { shell, fmt } = HD;
  const { esc, num, money2 } = fmt;
  const $ = (id) => document.getElementById(id);
  const canManage = shell.can('products.manage');
  const LIMIT = 15;

  const state = { page: 1, search: '', category: '', brand: '', active: '', low: false, total: 0, items: [] };
  let lookups = { categories: [], brands: [], units: [], taxRates: [] };
  let editingId = null;
  const pModal = new bootstrap.Modal($('pModal'));
  const drawer = new bootstrap.Offcanvas($('drawer'));

  const stateBox = (icon, text, retry) =>
    `<div class="state-box"><i class="ph-duotone ${icon}"></i><div>${esc(text)}</div>${retry ? '<button class="retry" type="button">Try again</button>' : ''}</div>`;
  const opts = (rows, label) => rows.map((r) => `<option value="${r.id}">${esc(label ? label(r) : r.name)}</option>`).join('');
  const orNull = (v) => (String(v).trim() === '' ? null : v);

  // ------------------------------------------------------------------ list
  function query() {
    const p = new URLSearchParams({ page: state.page, limit: LIMIT });
    if (state.search) p.set('search', state.search);
    if (state.category) p.set('category_id', state.category);
    if (state.brand) p.set('brand_id', state.brand);
    if (state.active) p.set('active', state.active);
    if (state.low) p.set('low_stock', 'true');
    return p.toString();
  }

  async function load() {
    $('btn-refresh').querySelector('i').classList.add('spin');
    try {
      const res = await api('/products?' + query(), { full: true });
      state.items = res.data; state.total = res.meta.total;
      render(res.meta);
    } catch (err) {
      $('list').innerHTML = stateBox(err.code === 'NETWORK_ERROR' ? 'ph-wifi-slash' : 'ph-warning-circle', err.message, true);
      $('list').querySelector('.retry').addEventListener('click', load);
      $('pager').hidden = true;
    } finally { $('btn-refresh').querySelector('i').classList.remove('spin'); }
  }

  function stockCell(p) {
    const on = Number(p.on_hand), lvl = Number(p.reorder_level);
    const ratio = lvl > 0 ? Math.min(on / lvl, 1) : 1;
    const low = on <= lvl;
    return `<span class="meter"><i class="${ratio > .5 ? 'mid' : ''}" style="width:${Math.max(ratio * 100, 6)}%;${low ? '' : 'background:var(--hd-success)'}"></i></span>` +
      `${num(on)} <small style="color:var(--hd-muted)">${esc(p.unit || '')}</small>`;
  }

  function render(meta) {
    $('sub').textContent = `${num(state.total)} ${state.total === 1 ? 'product' : 'products'}`;
    if (!state.items.length) {
      $('list').innerHTML = stateBox('ph-package', state.search || state.category || state.brand || state.low ? 'No products match your filters' : 'No products yet. Add your first one to get started.');
      $('pager').hidden = true; return;
    }
    $('list').innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th><th>Category</th><th>Brand</th>' +
      (canManage ? '<th class="num">Cost</th>' : '') + '<th class="num">Price</th><th>Stock</th><th>Status</th>' + (canManage ? '<th></th>' : '') + '</tr></thead><tbody>' +
      state.items.map((p) =>
        `<tr class="clickable" data-id="${p.id}"><td><div class="cell-main"><span class="thumb"><i class="ph-duotone ph-package"></i></span><div class="trunc"><b>${esc(p.name)}</b><small>${esc(p.sku)}${p.barcode ? ' · ' + esc(p.barcode) : ''}</small></div></div></td>` +
        `<td>${esc(p.category || '–')}</td><td>${esc(p.brand || '–')}</td>` +
        (canManage ? `<td class="num">${money2(p.cost_price)}</td>` : '') +
        `<td class="num">${money2(p.selling_price)}</td><td style="white-space:nowrap">${stockCell(p)}</td>` +
        `<td>${p.is_active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}${p.tracks_expiry ? ' <span class="pill soon" title="Tracks batches and expiry"><i class="ph-bold ph-hourglass-high"></i></span>' : ''}</td>` +
        (canManage ? `<td><div class="act"><button class="mini-btn" data-act="edit" title="Edit" aria-label="Edit ${esc(p.name)}"><i class="ph-duotone ph-pencil-simple"></i></button>` +
          `<button class="mini-btn" data-act="toggle" title="${p.is_active ? 'Deactivate' : 'Activate'}" aria-label="${p.is_active ? 'Deactivate' : 'Activate'} ${esc(p.name)}"><i class="ph-duotone ${p.is_active ? 'ph-eye-slash' : 'ph-eye'}"></i></button></div></td>` : '') +
        '</tr>').join('') + '</tbody></table></div>';

    const pg = $('pager');
    pg.hidden = meta.pages <= 1 && state.total <= LIMIT;
    pg.innerHTML = `<span>Showing ${meta.offset + 1}–${meta.offset + state.items.length} of ${num(meta.total)}</span>` +
      `<div class="btns"><button type="button" data-p="-1" ${meta.page <= 1 ? 'disabled' : ''}>Previous</button><button type="button" data-p="1" ${meta.page >= meta.pages ? 'disabled' : ''}>Next</button></div>`;
  }

  $('list').addEventListener('click', async (e) => {
    const row = e.target.closest('tr[data-id]'); if (!row) return;
    const id = Number(row.dataset.id), act = e.target.closest('[data-act]');
    if (!act) return openDetail(id);
    const p = state.items.find((x) => x.id === id);
    if (act.dataset.act === 'edit') return openForm(id);
    act.disabled = true;
    try { await api(`/products/${id}/active`, { method: 'POST', body: { is_active: !p.is_active } }); load(); }
    catch (err) { act.disabled = false; alert(err.message); }
  });
  $('pager').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-p]'); if (!b) return;
    state.page += Number(b.dataset.p); load();
  });

  // ------------------------------------------------------------------ filters
  const reload = () => { state.page = 1; load(); };
  let timer;
  $('f-search').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { state.search = e.target.value.trim(); reload(); }, 300); });
  $('f-category').addEventListener('change', (e) => { state.category = e.target.value; reload(); });
  $('f-brand').addEventListener('change', (e) => { state.brand = e.target.value; reload(); });
  $('f-low').addEventListener('change', (e) => { state.low = e.target.checked; reload(); });
  $('f-status').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    state.active = b.dataset.v;
    $('f-status').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    reload();
  });
  $('btn-refresh').addEventListener('click', load);

  // ------------------------------------------------------------------ detail drawer
  const miniTable = (head, rows) => rows.length
    ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '<div class="text-muted small">None</div>';

  async function openDetail(id) {
    $('drawer-title').textContent = 'Product';
    $('drawer-body').innerHTML = '<div class="sk sk-line"></div><div class="sk sk-line"></div><div class="sk sk-line"></div>';
    drawer.show();
    try {
      const p = await api('/products/' + id);
      $('drawer-title').textContent = p.name;
      const dt = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
      const hist = canManage ? await api(`/products/${id}/price-history`).catch(() => []) : [];
      $('drawer-body').innerHTML =
        `<div class="mb-3">${p.is_active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}</div>` +
        '<dl class="dl">' + dt('SKU', esc(p.sku)) + dt('Barcode', esc(p.barcode || '–')) + dt('Category', esc(p.category || '–')) + dt('Brand', esc(p.brand || '–')) +
        dt('Unit', esc(p.unit || '–')) + dt('Tax', p.tax_name ? `${esc(p.tax_name)} (${num(p.tax_rate)}%)` : '–') +
        (canManage ? dt('Cost price', money2(p.cost_price)) : '') + dt('Selling price', money2(p.selling_price)) +
        dt('Minimum price', p.min_price == null ? '–' : money2(p.min_price)) + dt('Reorder at', `${num(p.reorder_level)} (order ${num(p.reorder_qty)})`) +
        dt('Total on hand', num(p.total_on_hand)) + dt('Batch tracking', p.tracks_expiry ? 'Yes' : 'No') + '</dl>' +
        (p.description ? `<p class="small">${esc(p.description)}</p>` : '') +
        '<div class="dh">Stock by location</div>' + miniTable(['Location', 'On hand'], p.stock_by_location.map((l) => `<tr><td>${esc(l.location)}</td><td class="num">${num(l.on_hand)}</td></tr>`)) +
        (p.tracks_expiry ? '<div class="dh">Batches</div>' + miniTable(['Batch', 'Expiry', 'On hand'], p.batches.map((b) =>
          `<tr><td>${esc(b.batch_number)}</td><td class="num">${b.expiry_date ? fmt.dayLabel(fmt.dateKey(b.expiry_date), { day: 'numeric', month: 'short', year: 'numeric' }) : '–'}${b.is_expired ? ' <span class="pill gone">Expired</span>' : ''}</td><td class="num">${num(b.on_hand)}</td></tr>`)) : '') +
        '<div class="dh">Group prices</div>' + miniTable(['Group', 'Price'], p.group_prices.map((g) => `<tr><td>${esc(g.group_name)}</td><td class="num">${money2(g.price)}</td></tr>`)) +
        (canManage ? '<div class="dh">Suppliers</div>' + miniTable(['Supplier', 'Last cost'], p.suppliers.map((s) =>
          `<tr><td>${esc(s.supplier_name)}${s.is_preferred ? ' <span class="pill ok">Preferred</span>' : ''}</td><td class="num">${s.last_cost == null ? '–' : money2(s.last_cost)}</td></tr>`)) : '') +
        (canManage ? '<div class="dh">Price history</div>' + miniTable(['Changed', 'Cost', 'Selling'], hist.slice(0, 8).map((h) =>
          `<tr><td>${fmt.when(h.changed_at)}</td><td class="num">${h.old_cost_price == null ? '–' : num(h.old_cost_price)} → ${num(h.new_cost_price)}</td><td class="num">${h.old_selling_price == null ? '–' : num(h.old_selling_price)} → ${num(h.new_selling_price)}</td></tr>`)) +
          `<button class="btn btn-hd mt-4 w-100" type="button" id="d-edit"><i class="ph-bold ph-pencil-simple"></i> Edit product</button>` : '');
      if (canManage) $('d-edit').addEventListener('click', () => { drawer.hide(); openForm(id); });
    } catch (err) { $('drawer-body').innerHTML = stateBox('ph-warning-circle', err.message); }
  }

  // ------------------------------------------------------------------ add / edit
  const F = { name: 'p-name', sku: 'p-sku', barcode: 'p-barcode', description: 'p-desc', category_id: 'p-category', brand_id: 'p-brand',
    unit_id: 'p-unit', tax_rate_id: 'p-tax', cost_price: 'p-cost', selling_price: 'p-price', min_price: 'p-min', reorder_level: 'p-reorder', reorder_qty: 'p-reorderqty' };

  function showError(msg) { const b = $('p-error'); b.hidden = !msg; b.querySelector('span').textContent = msg || ''; }

  async function openForm(id) {
    editingId = id || null; showError('');
    $('p-form').reset();
    $('p-title').textContent = id ? 'Edit product' : 'Add product';
    $('p-open-wrap').hidden = Boolean(id);
    const defTax = lookups.taxRates.find((t) => t.is_default);
    $('p-tax').value = defTax ? defTax.id : '';
    if (id) {
      try {
        const p = await api('/products/' + id);
        Object.entries(F).forEach(([k, el]) => { $(el).value = p[k] == null ? '' : p[k]; });
        $('p-expiry').checked = p.tracks_expiry;
      } catch (err) { alert(err.message); return; }
    }
    pModal.show();
  }

  $('btn-add').addEventListener('click', () => openForm());

  $('p-form').addEventListener('submit', async (e) => {
    e.preventDefault(); showError('');
    const v = (k) => $(F[k]).value;
    if (!v('name').trim() || !v('sku').trim() || !v('unit_id')) return showError('Name, SKU and unit are required.');
    const body = {
      name: v('name').trim(), sku: v('sku').trim(), barcode: orNull(v('barcode')), description: orNull(v('description')),
      category_id: orNull(v('category_id')), brand_id: orNull(v('brand_id')), unit_id: v('unit_id'), tax_rate_id: orNull(v('tax_rate_id')),
      cost_price: orNull(v('cost_price')) ?? 0, selling_price: orNull(v('selling_price')) ?? 0, min_price: orNull(v('min_price')),
      reorder_level: orNull(v('reorder_level')) ?? 0, reorder_qty: orNull(v('reorder_qty')) ?? 0, tracks_expiry: $('p-expiry').checked,
    };
    if (!editingId) body.opening_stock = Number($('p-open').value) || 0;
    const btn = $('p-save'); btn.disabled = true;
    try {
      await api(editingId ? '/products/' + editingId : '/products', { method: editingId ? 'PATCH' : 'POST', body });
      pModal.hide(); load();
    } catch (err) { showError(err.message); }
    finally { btn.disabled = false; }
  });

  // ------------------------------------------------------------------ boot
  async function boot() {
    load();
    const [categories, brands, units, taxRates] = await Promise.all(
      ['/categories', '/brands', '/units', '/tax-rates'].map((p) => api(p).catch(() => [])));
    lookups = { categories, brands, units, taxRates };
    $('f-category').innerHTML += opts(categories); $('f-brand').innerHTML += opts(brands);
    $('p-category').innerHTML += opts(categories); $('p-brand').innerHTML += opts(brands);
    $('p-unit').innerHTML = opts(units, (u) => u.abbreviation ? `${u.name} (${u.abbreviation})` : u.name);
    $('p-tax').innerHTML = '<option value="">None</option>' + opts(taxRates, (t) => `${t.name} (${num(t.rate)}%)`);
  }
  boot();
})();