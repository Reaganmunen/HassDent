/**
 * PDF receipt + WhatsApp sharing (POS and Sales pages).
 * Needs vendor/jspdf/jspdf.umd.min.js loaded first. Exposes HD.receiptPdf { file, share }.
 *   file({ shop, sale })              -> File (application/pdf), built entirely in the browser
 *   share(file, { text, phone })      -> Promise<'shared' | 'cancelled' | 'downloaded'>   (call from a click handler)
 * WhatsApp cannot be given a file through a link, so share() uses the phone/computer's share sheet (WhatsApp is listed there).
 * Where the browser has no file sharing it saves the PDF and opens the WhatsApp chat so it can be attached.
 */
(function () {
  'use strict';

  const PAY = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank_transfer: 'Bank transfer', loyalty: 'Loyalty points' };
  const nf = new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const n2 = (v) => nf.format(Number(v) || 0);
  const kes = (v) => 'KSh ' + n2(v);
  // jsPDF's built-in fonts only cover Latin-1, so swap common typographic characters and drop the rest
  const t = (s) => String(s == null ? '' : s)
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014\u2212]/g, '-').replace(/\u2026/g, '...')
    .replace(/[^\u0020-\u00ff]/g, '?');
  const when = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

  function build({ shop, sale: s }) {
    shop = shop || {};
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, M = 15, R = W - M, BOTTOM = 280;
    const COL = { qty: 128, price: 160, total: R };
    let y = 20;

    const font = (style, size) => { doc.setFont('helvetica', style); doc.setFontSize(size); };
    const line = (yy, gray, x1, x2) => { doc.setDrawColor(gray); doc.setLineWidth(0.2); doc.line(x1 || M, yy, x2 || R, yy); };
    const need = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = 20; return true; } return false; };

    // ---- shop header
    doc.setTextColor(17);
    font('bold', 20); doc.text(t(shop.name || 'HassDent').toUpperCase(), W / 2, y, { align: 'center' }); y += 7;
    font('normal', 9);
    if (shop.address) { doc.text(doc.splitTextToSize(t(shop.address), 150), W / 2, y, { align: 'center' }); y += 5; }
    [shop.phone, shop.email, shop.kra_pin ? 'PIN: ' + shop.kra_pin : ''].filter(Boolean).forEach((c) => { font('normal', 10); doc.text(t(c), W / 2, y, { align: 'center' }); y += 5; });

    y += 5; font('bold', 16); doc.text('RECEIPT', W / 2, y, { align: 'center' }); y += 9;

    // ---- meta
    font('bold', 10); doc.text('RECEIPT No.', M, y); font('normal', 10); doc.text(t(s.sale_number), M + 27, y);
    doc.text(when(s.sold_at), R, y, { align: 'right' }); y += 5.5;
    font('bold', 10); doc.text('Customer', M, y); y += 5;
    font('normal', 10); doc.text(t(s.customer_name || 'Walk-in'), M, y); y += 5;
    if (s.customer_phone) { font('bold', 10); doc.text('Mobile:', M, y); font('normal', 10); doc.text(t(s.customer_phone), M + 15, y); y += 5; }
    y += 2; font('bold', 10); doc.text('Served by:', M, y); font('normal', 10); doc.text(t(s.sold_by_name || '-'), M + 21, y); y += 8;

    // ---- items
    const head = () => {
      font('bold', 9); doc.text('ITEM', M, y);
      doc.text('QTY', COL.qty, y, { align: 'right' }); doc.text('PRICE', COL.price, y, { align: 'right' }); doc.text('TOTAL', COL.total, y, { align: 'right' });
      y += 2; line(y, 180); y += 5;
    };
    head();
    (s.items || []).forEach((i) => {
      const name = doc.splitTextToSize(t(i.product_name + (i.sku ? ', ' + i.sku : '')), 100);
      const h = name.length * 4.6 + 2;
      if (need(h + 6)) head();
      font('normal', 10);
      doc.text(name, M, y);
      doc.text(String(i.quantity) + ' Pc(s)', COL.qty, y, { align: 'right' });
      doc.text(n2(i.unit_price), COL.price, y, { align: 'right' });
      doc.text(n2(i.line_total), COL.total, y, { align: 'right' });
      y += h; line(y - 3, 235);
    });

    // ---- payments (left) and totals (right)
    const completed = s.status === 'completed' || s.status === undefined;
    const balance = completed ? Number(s.balance) || 0 : 0;
    const left = [];
    (s.payments || []).filter((p) => p.status === 'completed').forEach((p) => left.push([(PAY[p.method] || p.method) + (p.reference ? ' (' + p.reference + ')' : ''), kes(p.amount), false]));
    left.push(['Total Paid', kes(s.amount_paid), true]);
    if (completed) left.push(['Total Due', kes(balance), true, balance > 0]);
    const right = [['Subtotal', kes(s.subtotal), true]];
    if (Number(s.discount_amount) > 0) right.push(['Discount', '- ' + kes(s.discount_amount), false]);
    if (Number(s.loyalty_discount) > 0) right.push(['Loyalty', '- ' + kes(s.loyalty_discount), false]);
    right.push(['VAT included', kes(s.tax_total), false], ['Total', kes(s.total), true]);

    y += 3; need(Math.max(left.length, right.length) * 6 + 30);
    line(y, 40); y += 7;
    const draw = (rows, x1, x2, startY) => {
      let yy = startY;
      rows.forEach(([l, r, bold, due]) => {
        font(bold ? 'bold' : 'normal', 10);
        doc.setTextColor(due ? 176 : 17, due ? 0 : 17, due ? 32 : 17);
        doc.text(t(l), x1, yy); doc.text(t(r), x2, yy, { align: 'right' });
        yy += 6; line(yy - 4, 235, x1, x2);
      });
      doc.setTextColor(17);
    };
    draw(left, M, 98, y); draw(right, 112, R, y);
    y += Math.max(left.length, right.length) * 6 + 8;

    // ---- paybill + footer
    need(30);
    if (shop.paybill) {
      font('bolditalic', 10); doc.text('M-PESA PAYBILL', W / 2, y, { align: 'center' }); y += 5;
      doc.text(t(shop.paybill), W / 2, y, { align: 'center' }); y += 5;
      if (shop.paybill_account) { doc.text('ACC ' + t(shop.paybill_account), W / 2, y, { align: 'center' }); y += 5; }
      y += 3;
    }
    font('normal', 10); doc.text(t(shop.footer || 'Thank you for allowing us to serve you!'), W / 2, y, { align: 'center' });
    return doc.output('blob');
  }

  function file(r) {
    return new File([build(r)], (r.sale.sale_number || 'receipt') + '.pdf', { type: 'application/pdf' });
  }

  /** Opens the share sheet with the PDF; falls back to download + the WhatsApp chat. Call straight from a click. */
  function share(f, { text, phone } = {}) {
    const data = { files: [f], title: f.name, text: text || '' };
    const fallback = () => {
      const url = URL.createObjectURL(f);
      const a = document.createElement('a'); a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      let d = String(phone || '').replace(/\D/g, '');
      if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1); else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
      window.open((d ? 'https://wa.me/' + d : 'https://wa.me/') + '?text=' + encodeURIComponent(text || ''), '_blank', 'noopener');
      return 'downloaded';
    };
    if (navigator.canShare && navigator.canShare(data)) {
      return navigator.share(data).then(() => 'shared', (e) => (e && e.name === 'AbortError' ? 'cancelled' : fallback()));
    }
    return Promise.resolve(fallback());
  }

  HD.receiptPdf = { file, share };
})();
