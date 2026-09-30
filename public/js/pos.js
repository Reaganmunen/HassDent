(function () {
  'use strict';
  const { api, fmt, shell } = HD;
  const { esc, money2 } = fmt;
  const $ = (id) => document.getElementById(id);
  const cents = (v) => Math.round(Number(v) * 100);
  const KES = (c) => money2(c / 100);

  const cart = new Map();          // product_id -> { p, qty }
  let customer = null, walkinName = '', method = 'cash', payModal, doneModal, busy = false;

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const total = () => [...cart.values()].reduce((s, l) => s + cents(l.p.price) * l.qty, 0);

  // ------------------------------------------------------------ product search
  async function search() {
    const q = $('q').value.trim(), box = $('results');
    if (!q) { box.innerHTML = '<div class="state-box"><i class="ph-duotone ph-magnifying-glass"></i><div>Search for a product to add it to the sale</div></div>'; return null; }
    try {
      const rows = await api('/products/pos-search?q=' + encodeURIComponent(q) + (customer ? '&customer_id=' + customer.id : ''));
      if (!rows.length) { box.innerHTML = '<div class="state-box"><i class="ph-duotone ph-package"></i><div>No products match "' + esc(q) + '"</div></div>'; return rows; }
      box.innerHTML = rows.map((p) => {
        const out = Number(p.on_hand) <= 0;
        return `<button class="p-card" type="button" data-id="${p.id}" ${out ? 'disabled' : ''}><span class="nm">${esc(p.name)}</span><span class="sku">${esc(p.sku)}</span>` +
          `<span class="pr"><span>${money2(p.price)}</span><span class="pill ${out ? 'gone' : Number(p.on_hand) < 5 ? 'soon' : 'ok'} stk">${out ? 'Out of stock' : p.on_hand + ' in stock'}</span></span></button>`;
      }).join('');
      box.rows = rows;
      return rows;
    } catch (e) { box.innerHTML = '<div class="state-box"><i class="ph-duotone ph-warning-circle"></i><div>' + esc(e.message) + '</div></div>'; return null; }
  }
  $('q').addEventListener('input', debounce(search, 250));
  $('q').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const rows = await search();                       // scanner ends with Enter: exact single hit goes straight in the cart
    if (rows && rows.length === 1 && Number(rows[0].on_hand) > 0) { add(rows[0]); $('q').select(); }
  });
  $('results').addEventListener('click', (e) => {
    const b = e.target.closest('.p-card'); if (!b) return;
    add($('results').rows.find((r) => String(r.id) === b.dataset.id));
  });

  // ------------------------------------------------------------ cart
  function add(p) {
    if (!p) return;
    const l = cart.get(p.id) || { p, qty: 0 };
    if (l.qty + 1 > Number(p.on_hand)) return flash('Only ' + p.on_hand + ' of ' + p.name + ' in stock');
    l.qty++; l.p = p; cart.set(p.id, l); draw();
  }
  function flash(msg) { const s = $('cart-count'); s.textContent = msg; s.className = 'count-pill bad'; setTimeout(draw, 2200); }

  function draw() {
    const box = $('lines'), units = [...cart.values()].reduce((s, l) => s + l.qty, 0);
    $('cart-count').className = 'count-pill'; $('cart-count').textContent = units + (units === 1 ? ' item' : ' items');
    $('t-units').textContent = units; $('t-total').textContent = KES(total());
    $('pay').disabled = !cart.size; $('pay').firstElementChild.textContent = cart.size ? 'Charge ' + KES(total()) : 'Charge';
    if (!cart.size) { box.innerHTML = '<div class="state-box"><i class="ph-duotone ph-shopping-cart"></i><div>Cart is empty</div></div>'; return; }
    box.innerHTML = [...cart.values()].map(({ p, qty }) =>
      `<div class="line" data-id="${p.id}"><div class="info"><b>${esc(p.name)}</b><small>${money2(p.price)} each</small></div>` +
      `<div class="qty"><button type="button" data-act="dec" aria-label="Decrease">−</button><input type="number" min="1" value="${qty}" data-act="set" aria-label="Quantity"><button type="button" data-act="inc" aria-label="Increase">+</button></div>` +
      `<div class="amt">${KES(cents(p.price) * qty)}</div><button class="rm" type="button" data-act="rm" aria-label="Remove"><i class="ph-duotone ph-x-circle"></i></button></div>`).join('');
  }
  $('lines').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'), row = e.target.closest('.line'); if (!b || !row || b.tagName === 'INPUT') return;
    const l = cart.get(Number(row.dataset.id)); if (!l) return;
    if (b.dataset.act === 'rm' || (b.dataset.act === 'dec' && l.qty <= 1)) cart.delete(l.p.id);
    else if (b.dataset.act === 'dec') l.qty--;
    else if (l.qty + 1 > Number(l.p.on_hand)) return flash('Only ' + l.p.on_hand + ' in stock'); else l.qty++;
    draw();
  });
  $('lines').addEventListener('change', (e) => {
    const row = e.target.closest('.line'); if (!row || e.target.dataset.act !== 'set') return;
    const l = cart.get(Number(row.dataset.id)); const n = Math.floor(Number(e.target.value));
    if (!n || n < 1) cart.delete(l.p.id); else if (n > Number(l.p.on_hand)) { l.qty = Number(l.p.on_hand); flash('Only ' + l.p.on_hand + ' in stock'); } else l.qty = n;
    draw();
  });
  $('clear').addEventListener('click', () => { cart.clear(); draw(); });

  // ------------------------------------------------------------ customer (optional; needed for credit sales)
  const cSearch = debounce(async () => {
    const q = $('cq').value.trim(), box = $('cres');
    if (q.length < 2) { box.hidden = true; return; }
    try {
      const rows = await api('/customers/search?q=' + encodeURIComponent(q));
      box.innerHTML = rows.length ? rows.slice(0, 6).map((c) => `<button type="button" data-id="${c.id}">${esc(c.full_name)} <small>${esc(c.phone || '')}</small></button>`).join('')
        : '<div class="p-3 small text-muted">No customer found</div>';
      box.rows = rows; box.hidden = false;
    } catch (e) { box.hidden = true; }
  }, 250);
  if (!shell.can('customers.view')) $('saved-cust-wrap').hidden = true;
  $('cq').addEventListener('input', cSearch);
  $('cres').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    customer = $('cres').rows.find((c) => String(c.id) === b.dataset.id);
    $('cres').hidden = true; $('cq').value = ''; $('cq').parentElement.hidden = true;
    $('cchip').hidden = false;
    $('cchip').innerHTML = `<i class="ph-duotone ph-user-circle"></i>${esc(customer.full_name)}<button type="button" aria-label="Remove customer"><i class="ph-bold ph-x"></i></button>`;
    // Saved customer picked → hide walk-in field and clear any typed name
    $('walkin-wrap').hidden = true;
    walkinName = ''; $('wname').value = '';
    search();
  });
  $('cchip').addEventListener('click', (e) => {
    if (!e.target.closest('button')) return;
    customer = null; $('cchip').hidden = true; $('cq').parentElement.hidden = false;
    // Re-show walk-in field when saved customer is removed
    if (shell.can('customers.view')) $('saved-cust-wrap').hidden = false;
    $('walkin-wrap').hidden = false;
    search();
  });

  // Walk-in name input
  $('wname').addEventListener('input', () => { walkinName = $('wname').value.trim(); });

  // ------------------------------------------------------------ payment
  const amtC = () => cents($('m-amt').value || 0);
  function refresh() {
    const due = total(), got = amtC(), line = $('m-line');
    $('m-refwrap').hidden = method === 'cash';
    if (got >= due) { const ch = got - due; line.className = 'pay-line ok'; line.innerHTML = method === 'cash' ? `<span>Change</span><span>${KES(ch)}</span>` : `<span>Fully paid</span><span>${KES(due)}</span>`; }
    else if (customer && got >= 0) { line.className = 'pay-line warn'; line.innerHTML = `<span>On credit for ${esc(customer.full_name)}</span><span>${KES(due - got)}</span>`; }
    else { line.className = 'pay-line warn'; line.innerHTML = `<span>Still to pay</span><span>${KES(due - got)}</span>`; }
  }
  $('pay').addEventListener('click', () => {
    if (!cart.size) return;
    payModal = payModal || new bootstrap.Modal($('payModal'));
    const due = total(); $('m-due').textContent = KES(due); $('m-err').hidden = true; $('m-ref').value = '';
    $('m-amt').value = (due / 100).toFixed(2);
    const notes = [50, 100, 200, 500, 1000, 2000].filter((n) => n * 100 >= due).slice(0, 3);
    $('m-quick').innerHTML = `<button type="button" data-v="${(due / 100).toFixed(2)}">Exact</button>` + notes.map((n) => `<button type="button" data-v="${n}">${n}</button>`).join('');
    refresh(); payModal.show();
  });
  $('payModal').addEventListener('shown.bs.modal', () => $('m-amt').select());
  $('m-amt').addEventListener('input', refresh);
  $('m-quick').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { $('m-amt').value = b.dataset.v; refresh(); } });
  $('methods').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; method = b.dataset.m;
    $('methods').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    if (method !== 'cash' && amtC() > total()) $('m-amt').value = (total() / 100).toFixed(2);
    refresh();
  });

  $('m-confirm').addEventListener('click', async () => {
    if (busy) return;
    const due = total(), got = amtC(), err = $('m-err');
    const fail = (m) => { err.querySelector('span').textContent = m; err.hidden = false; };
    err.hidden = true;
    if (got <= 0 && !customer) return fail('Enter the amount received.');
    if (got < due && !customer) return fail('Full payment is required unless the sale is for a saved customer.');
    if (method !== 'cash' && got > due) return fail('Non-cash payments cannot be more than the amount due.');
    busy = true; const btn = $('m-confirm'); btn.disabled = true; btn.querySelector('.label').textContent = 'Processing…';
    try {
      const body = { items: [...cart.values()].map((l) => ({ product_id: l.p.id, quantity: l.qty })), payments: got > 0 ? [{ method, amount: got / 100, reference: $('m-ref').value.trim() || undefined }] : [] };
      if (customer) body.customer_id = customer.id;
      else if (walkinName) body.customer_name = walkinName;
      const sale = await api('/sales', { method: 'POST', body });
      payModal.hide();
      $('d-num').textContent = sale.sale_number ? 'Receipt ' + sale.sale_number : '';
      $('d-total').textContent = KES(due);
      $('d-change').textContent = method === 'cash' && got > due ? 'Change: ' + KES(got - due) : (got < due ? 'On credit: ' + KES(due - got) : 'Paid in full');
      doneModal = doneModal || new bootstrap.Modal($('doneModal')); doneModal.show();
    } catch (e) { fail(e.message); }
    finally { busy = false; btn.disabled = false; btn.querySelector('.label').textContent = 'Complete sale'; }
  });
  $('d-new').addEventListener('click', () => {
    doneModal.hide(); cart.clear(); customer = null; walkinName = '';
    $('cchip').hidden = true;
    if (shell.can('customers.view')) $('saved-cust-wrap').hidden = false;
    $('cq').parentElement.hidden = false;
    $('walkin-wrap').hidden = false; $('wname').value = '';
    $('q').value = ''; draw(); search(); $('q').focus();
  });

  draw();
})();