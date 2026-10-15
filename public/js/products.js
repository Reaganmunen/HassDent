(function () {
  'use strict';
  const { api, fmt, shell } = HD;
  const { esc, money2 } = fmt;
  const $ = (id) => document.getElementById(id);
  const canManage = shell.can('products.manage');
  const PAGE_SIZE = 20;

  let page = 1, pages = 1, editing = null, modal, busy = false;
  const products = new Map(); // id -> row currently on screen

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const dash = '<span class="muted">—</span>';

  // ------------------------------------------------------------ list
  async function load() {
    const body = $('p-body');
    try {
      const q = $('p-q').value.trim();
      const r = await api('/products?limit=' + PAGE_SIZE + '&page=' + page + '&active=all' + (q ? '&search=' + encodeURIComponent(q) : ''), { full: true });
      pages = r.meta.pages; products.clear();
      $('p-count').textContent = r.meta.total + (r.meta.total === 1 ? ' product' : ' products');
      $('p-pager').hidden = pages <= 1;
      $('p-page').textContent = 'Page ' + page + ' of ' + pages;
      $('p-prev').disabled = page <= 1; $('p-next').disabled = page >= pages;
      if (!r.data.length) { body.innerHTML = '<tr><td colspan="7"><div class="state-box"><i class="ph-duotone ph-package"></i><div>No products found</div></div></td></tr>'; return; }
      body.innerHTML = r.data.map((p) => {
        products.set(p.id, p);
        const stock = Number(p.on_hand);
        const pill = stock <= 0 ? 'gone' : stock <= Number(p.reorder_level) ? 'soon' : 'ok';
        return `<tr class="${p.is_active ? '' : 'off'}"><td class="nm"><b>${esc(p.name)}</b><small>${esc(p.sku)}${p.is_active ? '' : ' · inactive'}</small></td>` +
          `<td class="d-none d-md-table-cell">${esc(p.category || '') || dash}</td>` +
          `<td class="text-end cost-col" data-perm="products.manage">${money2(p.cost_price)}</td>` +
          `<td class="text-end fw-bold">${money2(p.selling_price)}</td>` +
          `<td class="text-end">${p.min_price === null || p.min_price === undefined ? dash : money2(p.min_price)}</td>` +
          `<td class="text-end"><span class="pill ${pill}">${stock}</span></td>` +
          `<td class="text-end" data-perm="products.manage"><button class="edit-btn" type="button" data-id="${p.id}"><i class="ph-duotone ph-pencil-simple"></i> Edit</button></td></tr>`;
      }).join('');
      shell.applyPerms(body);
    } catch (e) {
      body.innerHTML = '<tr><td colspan="7"><div class="state-box"><i class="ph-duotone ph-warning-circle"></i><div>' + esc(e.message) + '</div></div></td></tr>';
    }
  }
  $('p-q').addEventListener('input', debounce(() => { page = 1; load(); }, 250));
  $('p-prev').addEventListener('click', () => { if (page > 1) { page--; load(); } });
  $('p-next').addEventListener('click', () => { if (page < pages) { page++; load(); } });
  $('p-body').addEventListener('click', (e) => {
    const b = e.target.closest('.edit-btn'); if (b) openForm(products.get(Number(b.dataset.id)));
  });

  // ------------------------------------------------------------ lookups for the dropdowns
  async function fillSelect(id, path, label, keepEmpty) {
    try {
      const rows = await api(path);
      $(id).innerHTML = (keepEmpty ? '<option value="">None</option>' : '') + rows.map((r) => `<option value="${r.id}">${esc(label(r))}</option>`).join('');
    } catch (e) { /* the select just stays empty */ }
  }
  const lookups = Promise.all([
    fillSelect('f-category', '/categories', (r) => r.name, true),
    fillSelect('f-brand', '/brands', (r) => r.name, true),
    fillSelect('f-unit', '/units', (r) => r.name + (r.abbreviation ? ' (' + r.abbreviation + ')' : ''), false),
  ]);

  // ------------------------------------------------------------ form
  const num = (id) => { const v = $(id).value.trim(); return v === '' ? null : Number(v); };

  function hint() {
    const cost = num('f-cost'), price = num('f-price'), min = num('f-min'), h = $('f-hint');
    h.className = 'price-hint';
    if (price !== null && min !== null && min > price) { h.classList.add('bad'); h.textContent = 'Minimum price cannot be higher than the selling price.'; return; }
    const bits = [];
    if (price !== null && cost !== null && price > 0) bits.push('Margin at selling price: ' + money2(price - cost) + ' (' + Math.round(((price - cost) / price) * 100) + '%)');
    if (min !== null && cost !== null && min < cost) bits.push('Minimum is below cost, so you could sell at a loss');
    h.textContent = bits.join(' · ') || (min === null ? 'Leave minimum price empty if this product has no price floor.' : '');
  }
  ['f-cost', 'f-price', 'f-min'].forEach((id) => $(id).addEventListener('input', hint));

  async function openForm(p) {
    await lookups;
    editing = p || null;
    $('f-title').textContent = p ? 'Edit product' : 'Add product';
    $('f-err').hidden = true;
    $('f-name').value = p ? p.name : '';
    $('f-sku').value = p ? p.sku : '';
    $('f-barcode').value = p && p.barcode ? p.barcode : '';
    $('f-category').value = p && p.category_id ? p.category_id : '';
    $('f-brand').value = p && p.brand_id ? p.brand_id : '';
    if (p && p.unit_id) $('f-unit').value = p.unit_id;
    $('f-cost').value = p ? p.cost_price : '';
    $('f-price').value = p ? p.selling_price : '';
    $('f-min').value = p && p.min_price !== null && p.min_price !== undefined ? p.min_price : '';
    $('f-reorder').value = p ? p.reorder_level : '';
    $('f-open').value = '';
    $('f-open-wrap').hidden = Boolean(p);   // opening stock only applies to a brand-new product
    $('f-expiry').checked = p ? Boolean(p.tracks_expiry) : false;
    $('f-expiry').disabled = Boolean(p);
    document.querySelectorAll('#prodModal .is-invalid').forEach((x) => x.classList.remove('is-invalid'));
    hint();
    modal = modal || new bootstrap.Modal($('prodModal'));
    modal.show();
  }
  $('add-product').addEventListener('click', () => openForm(null));

  $('f-save').addEventListener('click', async () => {
    if (busy) return;
    const err = $('f-err'), fail = (m, field) => { err.querySelector('span').textContent = m; err.hidden = false; if (field) $(field).classList.add('is-invalid'); };
    err.hidden = true;
    document.querySelectorAll('#prodModal .is-invalid').forEach((x) => x.classList.remove('is-invalid'));

    const name = $('f-name').value.trim(), sku = $('f-sku').value.trim();
    const cost = num('f-cost'), price = num('f-price'), min = num('f-min');
    if (!name) return fail('Enter the product name.', 'f-name');
    if (!sku) return fail('Enter a SKU.', 'f-sku');
    if (!$('f-unit').value) return fail('Choose a unit.', 'f-unit');
    if ([cost, price, min].some((n) => n !== null && (!Number.isFinite(n) || n < 0))) return fail('Prices cannot be negative.');
    if (price !== null && min !== null && min > price) return fail('Minimum price cannot be higher than the selling price.', 'f-min');

    const body = {
      name, sku, barcode: $('f-barcode').value.trim() || null,
      category_id: $('f-category').value ? Number($('f-category').value) : null,
      brand_id: $('f-brand').value ? Number($('f-brand').value) : null,
      unit_id: Number($('f-unit').value),
      cost_price: cost === null ? 0 : cost,
      selling_price: price === null ? 0 : price,
      min_price: min,                                   // null clears the floor
      reorder_level: num('f-reorder') || 0,
    };
    if (!editing) {
      body.tracks_expiry = $('f-expiry').checked;
      const open = num('f-open');
      if (open) body.opening_stock = open;
    }

    busy = true; const btn = $('f-save'); btn.disabled = true; btn.querySelector('.label').textContent = 'Saving…';
    try {
      if (editing) await api('/products/' + editing.id, { method: 'PATCH', body });
      else await api('/products', { method: 'POST', body });
      modal.hide(); load();
    } catch (e) { fail(e.message); }
    finally { busy = false; btn.disabled = false; btn.querySelector('.label').textContent = 'Save product'; }
  });

  load();
})();
