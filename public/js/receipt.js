/** Shared WhatsApp receipt helpers (POS + Sales pages). Exposes HD.receipt { text, waNumber, open }. */
(function () {
  'use strict';
  const SHOP_FALLBACK = { name: 'HassDent Dental Supplies' };
  const nf = new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const kes = (n) => 'KES ' + nf.format(Number(n) || 0);
  const METHOD = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank_transfer: 'Bank transfer' };

  /** Kenyan numbers -> international digits for wa.me (0712345678 / 712345678 / +254712345678 -> 254712345678). */
  function waNumber(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (!d) return '';
    if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1);
    else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
    return d;
  }

  function receiptText(sale, shop) {
    const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(sale.sold_at || Date.now()));
    const L = [];
    L.push('*' + (shop.name || SHOP_FALLBACK.name) + '*');
    if (shop.address) L.push(shop.address);
    if (shop.phone) L.push('Tel: ' + shop.phone);
    L.push('');
    L.push('*Receipt ' + (sale.sale_number || '') + '*');
    L.push(when);
    if (sale.customer_name) L.push('Customer: ' + sale.customer_name);
    L.push('------------------------');
    (sale.items || []).forEach((i) => {
      L.push(i.product_name);
      L.push('  ' + i.quantity + ' x ' + nf.format(i.unit_price) + ' = ' + nf.format(i.line_total));
    });
    L.push('------------------------');
    if (Number(sale.discount_amount) > 0) L.push('Discount: -' + kes(sale.discount_amount));
    L.push('*TOTAL: ' + kes(sale.total) + '*');
    (sale.payments || []).forEach((p) => L.push((METHOD[p.method] || p.method) + ': ' + kes(p.amount)));
    if (Number(sale.balance) > 0) L.push('*Balance due: ' + kes(sale.balance) + '*');
    else L.push('Paid in full');
    L.push('');
    L.push(shop.footer || 'Thank you for shopping with us!');
    return L.join('\n');
  }

  /** Call straight from a click handler (no awaits before it) so browsers don't block the pop-up. */
  function open(sale, shop, phone) {
    const num = waNumber(phone);
    window.open((num ? 'https://wa.me/' + num : 'https://wa.me/') + '?text=' + encodeURIComponent(receiptText(sale, shop || SHOP_FALLBACK)), '_blank', 'noopener');
  }

  HD.receipt = { text: receiptText, waNumber, open };
})();
