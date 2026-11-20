/**
 * PDF receipt + WhatsApp sharing (POS and Sales pages).
 * Layout matches the HassDent branded receipt (A5 landscape). All coordinates below are in the design's
 * 1484 x 1060 px space and are converted to mm with P().
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
  // jsPDF's built-in fonts only cover Latin-1, so swap common typographic characters and drop the rest
  const t = (s) => String(s == null ? '' : s)
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014\u2212]/g, '-').replace(/\u2026/g, '...')
    .replace(/[^\u0020-\u00ff]/g, '?');
  const dateParts = (iso) => {
    const o = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: '2-digit', month: '2-digit', year: 'numeric' })
      .formatToParts(new Date(iso || Date.now())).forEach((p) => { o[p.type] = p.value; });
    return o;
  };

  const K = 210 / 1484, P = (v) => v * K;
  const NAVY = [20, 39, 95], TEAL = [1, 129, 156], MID = [2, 66, 102], BAND = [247, 247, 249], PALE = [220, 236, 245], INK = [30, 34, 48], GREY = [110, 116, 134], WHITE = [255, 255, 255];
  const DEF = {
    address: 'Mercantile House, 1st Floor, Room 137, Koinange Street, P.O. Box 34363 - 00100, Nairobi, Kenya',
    phone: '+254 (0) 725 286 720 / (0) 702 910 810',
    email: 'info@hassdentsupplies.com', email2: 'customercare@hassdentsupplies.com', web: 'www.hassdentsupplies.com',
  };

  // Header logo: preloaded once so build() can stay synchronous
  let LOGO = null;
  try {
    const im = new Image();
    im.onload = () => { try { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0); LOGO = c.toDataURL('image/png'); } catch (e) { /* header falls back to text */ } };
    im.src = 'img/receipt-logo.png';
  } catch (e) { /* ignore */ }

  /** Splits items over pages: the last page carries the payment/totals block and holds up to 7 rows, earlier pages up to 14. */
  function paginate(items) {
    const rest = (items || []).slice(), out = [];
    while (rest.length > 7) out.push(rest.splice(0, Math.min(14, rest.length - 1)));
    out.push(rest);
    return out;
  }

  function build({ shop, sale: s }) {
    shop = shop || {};
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a5', orientation: 'landscape' });
    const W = 210, H = 148;

    const font = (style, size) => { doc.setFont('helvetica', style); doc.setFontSize(size); };
    const ink = (c) => doc.setTextColor(c[0], c[1], c[2]);
    const fill = (c) => doc.setFillColor(c[0], c[1], c[2]);
    const draw = (c, w) => { doc.setDrawColor(c[0], c[1], c[2]); doc.setLineWidth(w == null ? 0.25 : w); };
    const hline = (x1, x2, y, c, w) => { draw(c || NAVY, w); doc.line(P(x1), P(y), P(x2), P(y)); };
    const vline = (x, y1, y2, c, w) => { draw(c || NAVY, w); doc.line(P(x), P(y1), P(x), P(y2)); };
    const text = (str, x, y, opt) => doc.text(t(str), P(x), P(y), opt);
    const poly = (pts, c) => {
      fill(c); const rel = [];
      for (let i = 1; i < pts.length; i++) rel.push([P(pts[i][0] - pts[i - 1][0]), P(pts[i][1] - pts[i - 1][1])]);
      doc.lines(rel, P(pts[0][0]), P(pts[0][1]), [1, 1], 'F', true);
    };
    const clip = (str, w) => {
      str = t(str); const max = P(w);
      if (doc.getTextWidth(str) <= max) return str;
      while (str.length > 1 && doc.getTextWidth(str + '...') > max) str = str.slice(0, -1);
      return str + '...';
    };
    /** Value written on a form line: shrinks to fit, sits just above the line. */
    const field = (str, x1, x2, yLine, size, style) => {
      str = t(str); if (!str) return;
      let sz = size || 9; font(style || 'normal', sz);
      while (sz > 6 && doc.getTextWidth(str) > P(x2 - x1 - 12)) { sz -= 0.5; font(style || 'normal', sz); }
      ink(INK); doc.text(clip(str, x2 - x1 - 12), P(x1 + 8), P(yLine - 6));
    };
    const icon = (kind, cx, cy) => {
      fill(NAVY); doc.circle(P(cx), P(cy), P(15), 'F');
      fill(WHITE); draw(WHITE, P(1.8));
      if (kind === 'home') { doc.triangle(P(cx), P(cy - 8), P(cx + 8), P(cy), P(cx - 8), P(cy), 'F'); doc.rect(P(cx - 5), P(cy), P(10), P(7), 'F'); }
      else if (kind === 'phone') { draw(WHITE, P(4.5)); doc.setLineCap('round'); doc.line(P(cx - 5), P(cy - 5), P(cx + 5), P(cy + 5)); doc.setLineCap('butt'); }
      else if (kind === 'mail') { doc.rect(P(cx - 7), P(cy - 5), P(14), P(10), 'F'); draw(NAVY, P(1.4)); doc.line(P(cx - 7), P(cy - 5), P(cx), P(cy + 1), 'S'); doc.line(P(cx + 7), P(cy - 5), P(cx), P(cy + 1), 'S'); }
      else { doc.circle(P(cx), P(cy), P(8), 'S'); doc.ellipse(P(cx), P(cy), P(3.5), P(8), 'S'); doc.line(P(cx - 8), P(cy), P(cx + 8), P(cy)); }
    };
    const tick = (x, y) => { draw(TEAL, P(2.6)); doc.setLineCap('round'); doc.line(P(x + 3), P(y + 9), P(x + 7.5), P(y + 14)); doc.line(P(x + 7.5), P(y + 14), P(x + 15), P(y + 4)); doc.setLineCap('butt'); };

    const pays = (s.payments || []).filter((p) => p.status === 'completed');
    const completed = s.status === 'completed' || s.status === undefined;
    const balance = completed ? Number(s.balance) || 0 : 0;
    const used = new Set(pays.map((p) => p.method));
    const others = [...used].filter((m) => !['cash', 'mpesa', 'bank_transfer'].includes(m)).map((m) => PAY[m] || m);
    const refs = pays.map((p) => p.reference).filter(Boolean);
    const d = dateParts(s.sold_at);
    const addr = shop.address || DEF.address;
    const emails = [shop.email || DEF.email, DEF.email2].filter((e, i, a) => e && a.indexOf(e) === i).slice(0, 2);
    const pageList = paginate(s.items);

    pageList.forEach((rows, pi) => {
      const final = pi === pageList.length - 1;
      if (pi) doc.addPage('a5', 'landscape');

      // ---- header band + stripes
      poly([[25, 27], [808, 27], [670, 273], [25, 273]], BAND);
      poly([[808, 27], [822, 27], [684, 273], [670, 273]], TEAL);
      poly([[818, 27], [1002, 27], [974, 93], [790, 93]], TEAL);
      poly([[1012, 27], [1188, 27], [1160, 93], [984, 93]], MID);
      poly([[1198, 27], [1460, 27], [1460, 93], [1170, 93]], NAVY);
      if (LOGO) doc.addImage(LOGO, 'PNG', P(50), P(70), P(622), P(162));
      else { font('bolditalic', 26); ink(NAVY); text('HASSDENT', 250, 170); font('normal', 11); ink(TEAL); text('DENTAL SUPPLIES LTD', 250, 215); }

      icon('home', 800, 140);
      font('normal', 8); ink(INK);
      const aLines = doc.splitTextToSize(t(addr), P(205)).slice(0, 5);
      aLines.forEach((ln, i) => doc.text(ln, P(824), P(147 + i * 31)));
      if (shop.kra_pin && aLines.length < 5) doc.text('PIN: ' + t(shop.kra_pin), P(824), P(147 + aLines.length * 31));
      vline(1049, 124, 272, NAVY, 0.2);
      font('normal', 8.5); ink(NAVY);
      [['phone', shop.phone || DEF.phone], ['mail', emails[0]], ['mail', emails[1]], ['globe', shop.website || DEF.web]].forEach(([k, v], i) => {
        if (!v) return;
        const cy = 137 + i * 40; icon(k, 1090, cy); font('normal', 8.5); ink(NAVY); text(v, 1119, cy + 5);
      });

      // ---- title + number + date
      font('bold', 23); ink(NAVY); text('RECEIPT', 58, 343);
      font('bold', 11); text('No.', 796, 341); hline(846, 1023, 344);
      field(s.sale_number, 846, 1023, 344, 10, 'bold');
      text('Date:', 1123, 341);
      hline(1196, 1250, 344); hline(1274, 1329, 344); hline(1378, 1436, 344);
      font('normal', 11); ink(NAVY); text('/', 1257, 341); text('/ 20', 1337, 341);
      field(d.day, 1196, 1250, 344, 10); field(d.month, 1274, 1329, 344, 10); field(String(d.year || '').slice(-2), 1378, 1436, 344, 10);

      // ---- received from / sum / payment for
      font('normal', 10); ink(INK);
      text('Received from:', 58, 391); hline(205, 1436, 395);
      field(s.customer_name || 'Walk-in', 205, 1436, 395, 10);
      font('normal', 10); ink(INK); text('The sum of Ksh:', 58, 439); hline(205, 733, 442);
      field(n2(s.amount_paid != null ? s.amount_paid : s.total), 205, 733, 442, 10, 'bold');
      font('normal', 10); ink(INK); text('Being payment for:', 774, 439); hline(948, 1436, 442);
      field('Goods sold - ' + (s.sale_number || ''), 948, 1436, 442, 9);

      // ---- items table
      const n = final ? Math.max(7, rows.length) : rows.length;
      const tb = { x: 50, y: 472, w: 1387, hh: 31, rh: 34 };
      const th = tb.hh + n * tb.rh;
      fill(NAVY); doc.roundedRect(P(tb.x), P(tb.y), P(tb.w), P(tb.hh), P(8), P(8), 'F'); doc.rect(P(tb.x), P(tb.y + 16), P(tb.w), P(15), 'F');
      for (let i = 1; i <= n; i++) hline(tb.x, tb.x + tb.w, tb.y + tb.hh + i * tb.rh - tb.rh, NAVY, 0.15);
      [165, 979, 1212].forEach((x) => vline(x, tb.y + 2, tb.y + th, NAVY, 0.2));
      draw(NAVY, 0.3); doc.roundedRect(P(tb.x), P(tb.y), P(tb.w), P(th), P(8), P(8), 'S');
      font('bold', 8.5); ink(WHITE);
      [['QTY', 107], ['ITEM DESCRIPTION', 572], ['UNIT PRICE (KSH)', 1096], ['AMOUNT (KSH)', 1324]].forEach(([l, x]) => text(l, x, tb.y + 21, { align: 'center' }));
      rows.forEach((it, i) => {
        const by = tb.y + tb.hh + i * tb.rh + 22;
        font('normal', 8.5); ink(INK);
        text(String(it.quantity), 107, by, { align: 'center' });
        doc.text(clip(it.product_name, 790), P(178), P(by));
        text(n2(it.unit_price), 1198, by, { align: 'right' });
        text(n2(it.line_total), 1423, by, { align: 'right' });
      });

      if (!final) {
        font('italic', 9); ink(GREY); text('Continued on next page...', 742, 1000, { align: 'center' });
      } else {
        // ---- payment method
        fill(TEAL); doc.roundedRect(P(50), P(763), P(210), P(31), P(8), P(8), 'F');
        font('bold', 8.5); ink(WHITE); text('PAYMENT METHOD', 78, 784);
        if (refs.length) { font('normal', 7); ink(GREY); doc.text(clip('Ref: ' + refs.join(', '), 235), P(275), P(784)); }
        [['Cash', 51, 'cash'], ['Mpesa', 147, 'mpesa'], ['Bank Transfer', 252, 'bank_transfer'], ['Cheque', 406, null]].forEach(([l, x, k]) => {
          draw(NAVY, 0.25); doc.rect(P(x), P(824), P(18), P(18), 'S');
          if (k && used.has(k)) tick(x, 824);
          font('normal', 9.5); ink(INK); text(l, x + 25, 839);
        });
        draw(NAVY, 0.25); doc.rect(P(51), P(873), P(18), P(18), 'S');
        if (others.length) tick(51, 873);
        font('normal', 9.5); ink(INK); text('Other:', 76, 888); hline(142, 493, 892);
        if (others.length) field(others.join(', '), 142, 493, 892, 9);
        vline(521, 775, 892, TEAL, 0.25);
        font('bold', 8.5); ink(NAVY);
        text('PAID BY:', 548, 790); hline(635, 955, 794); field(s.customer_name || 'Walk-in', 635, 955, 794, 9);
        font('bold', 8.5); ink(NAVY); text('ID / NO.:', 548, 840); hline(635, 955, 844);
        text('SIGNATURE:', 548, 889); hline(664, 955, 892);
        font('normal', 10); ink(INK); text('Received by:', 58, 969); hline(183, 481, 970);
        field(s.sold_by_name || '', 183, 481, 970, 9);
        font('bold', 7.5); ink(NAVY);
        let ny = 965;
        if (shop.paybill) { text('M-PESA PAYBILL ' + shop.paybill + (shop.paybill_account ? '  |  ACC ' + shop.paybill_account : ''), 548, ny); ny += 20; }
        if (shop.kra_pin && aLines.length >= 5) { font('normal', 7.5); ink(GREY); text('PIN: ' + shop.kra_pin, 548, ny); }

        // ---- totals
        const disc = (Number(s.discount_amount) || 0) + (Number(s.loyalty_discount) || 0);
        [['SUBTOTAL', n2(s.subtotal), 0], ['DISCOUNT', n2(disc), 0], ['TOTAL (KSH)', n2(s.total), 1], ['PAID', n2(s.amount_paid), 0], ['BALANCE DUE', n2(balance), 2]].forEach(([l, v, k], i) => {
          const y0 = 749 + i * 38.4;
          fill(k === 2 ? TEAL : PALE); doc.rect(P(1010), P(y0), P(201), P(38.4), 'F');
          draw(NAVY, 0.25); doc.rect(P(1010), P(y0), P(201), P(38.4), 'S'); doc.rect(P(1211), P(y0), P(226), P(38.4), 'S');
          font(k ? 'bold' : 'normal', 9); ink(k === 2 ? WHITE : k === 1 ? TEAL : NAVY); text(l, 1180, y0 + 25, { align: 'right' });
          font(k ? 'bold' : 'normal', 10); ink(INK); text(v, 1424, y0 + 25, { align: 'right' });
        });
        if (Number(s.tax_total) > 0) { font('normal', 7); ink(GREY); text('Includes VAT of KSh ' + n2(s.tax_total), 1437, 962, { align: 'right' }); }

        // ---- footer
        hline(25, 531, 1013, TEAL, 0.25); hline(953, 1459, 1013, TEAL, 0.25);
        font('italic', 14); ink(TEAL); text(shop.footer || 'Thank you for your business!', 742, 1021, { align: 'center' });
      }

      if (s.status === 'voided') {
        doc.setGState(new doc.GState({ opacity: 0.2 }));
        font('bold', 64); ink([176, 0, 32]); doc.text('VOIDED', W / 2, H / 2 + 12, { align: 'center', angle: 18 });
        doc.setGState(new doc.GState({ opacity: 1 }));
      }
    });
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