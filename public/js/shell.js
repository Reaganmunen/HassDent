/**
 * App shell shared by every page after login: sidebar, top bar, notifications, permission helpers, formatters.
 * Load order at the bottom of each page:  bootstrap.bundle.min.js -> api.js -> shell.js -> <page>.js
 * Page markup needs:  <body data-page="dashboard">, <aside id="sidebar">, <div id="sb-scrim">, and the top bar ids used below.
 */
(function () {
  'use strict';
  const { Session, api, config } = HD;

  // No session -> straight to the login page before anything is drawn.
  if (!Session.get()) { location.replace(config.LOGIN_PAGE); return; }

  const $ = (id) => document.getElementById(id);
  const can = (p) => Session.can(p);
  const canAny = (list) => !list || !list.length || list.some(can);

  // ------------------------------------------------------------------ formatters (Nairobi time throughout)
  const TZ = 'Africa/Nairobi';
  const nf0 = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // YYYY-MM-DD
  const fmt = {
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    num: (n) => nf0.format(Number(n) || 0),
    money: (n) => 'KES ' + nf0.format(Number(n) || 0),
    money2: (n) => 'KES ' + nf2.format(Number(n) || 0),
    compact(n) {
      n = Number(n) || 0;
      if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(/\.0$/, '') + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 ? 1 : 0).replace(/\.0$/, '') + 'K';
      return String(Math.round(n));
    },
    today: () => dayKey(new Date()),
    /** 'YYYY-MM-DD' plus n days (pure calendar maths, no timezone surprises). */
    addDays(key, n) { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); },
    /** Postgres DATE columns can arrive as 'YYYY-MM-DD' or as a full ISO timestamp; normalise to the Nairobi calendar day. */
    dateKey: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : dayKey(new Date(v))),
    dayLabel(key, opts) { return new Date(key + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', ...(opts || { day: 'numeric', month: 'short' }) }); },
    when(iso) {
      const d = new Date(iso);
      const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
      const k = dayKey(d), t = fmt.today();
      if (k === t) return 'Today, ' + time;
      if (k === fmt.addDays(t, -1)) return 'Yesterday, ' + time;
      return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' }).format(d) + ', ' + time;
    },
    ago(iso) {
      const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      if (s < 604800) return Math.floor(s / 86400) + 'd ago';
      return fmt.dayLabel(dayKey(new Date(iso)));
    },
    greeting() {
      const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date())) % 24;
      return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    },
    initials: (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase(),
  };

  // ------------------------------------------------------------------ permissions in markup: data-perm="a,b" = any of
  function applyPerms(root) {
    (root || document).querySelectorAll('[data-perm]').forEach((el) => {
      el.hidden = !canAny(el.dataset.perm.split(',').map((s) => s.trim()));
    });
  }

  // ------------------------------------------------------------------ sidebar
  const NAV = [
    { section: 'MENU' },
    { href: '/dashboard.html', page: 'dashboard', icon: 'ph-squares-four', label: 'Dashboard' },
    { href: '/pos.html', page: 'pos', icon: 'ph-cash-register', label: 'Point of Sale', perm: ['sales.create'] },
    { href: '/sales.html', page: 'sales', icon: 'ph-receipt', label: 'Sales', perm: ['sales.view'] },
    { href: '/products.html', page: 'products', icon: 'ph-package', label: 'Products', perm: ['products.view'] },
    { href: '/stock.html', page: 'stock', icon: 'ph-stack', label: 'Stock', perm: ['stock.view'] },
    { href: '/purchases.html', page: 'purchases', icon: 'ph-truck', label: 'Purchases', perm: ['purchases.view'] },
    { href: '/suppliers.html', page: 'suppliers', icon: 'ph-handshake', label: 'Suppliers', perm: ['purchases.view', 'suppliers.manage', 'products.manage'] },
    { href: '/customers.html', page: 'customers', icon: 'ph-users-three', label: 'Customers', perm: ['customers.view'] },
    { href: '/expenses.html', page: 'expenses', icon: 'ph-wallet', label: 'Expenses', perm: ['expenses.manage', 'reports.view'] },
    { href: '/reports.html', page: 'reports', icon: 'ph-chart-line-up', label: 'Reports', perm: ['reports.view'] },
    { section: 'GENERAL' },
    { href: '/users.html', page: 'users', icon: 'ph-user-gear', label: 'Users & Roles', perm: ['users.manage'] },
    { href: '/settings.html', page: 'settings', icon: 'ph-gear-six', label: 'Settings', perm: ['settings.manage'] },
  ];

  function renderSidebar() {
    const page = document.body.dataset.page;
    const u = Session.user() || {};
    let html = '<a class="sb-brand" href="/dashboard.html" aria-label="HassDent home"><img src="/img/logo.png" alt="HassDent Dental Supplies"></a>';
    let pendingSection = null, open = false;
    NAV.forEach((item) => {
      if (item.section) { pendingSection = item.section; return; }
      if (!canAny(item.perm)) return;
      if (pendingSection) {
        if (open) html += '</ul>';
        html += `<div class="sb-section">${pendingSection}</div><ul class="sb-nav">`; open = true; pendingSection = null;
      }
      html += `<li><a class="sb-link${item.page === page ? ' active' : ''}" href="${item.href}"${item.page === page ? ' aria-current="page"' : ''}>` +
        `<i class="ph-duotone ${item.icon}"></i><span>${item.label}</span></a></li>`;
    });
    if (open) html += '</ul>';
    html += '<div class="sb-spacer"></div>' +
      `<div class="sb-user"><div class="avatar">${fmt.esc(fmt.initials(u.name))}</div>` +
      `<div class="who"><b>${fmt.esc(u.name || 'User')}</b><small>${fmt.esc(String(u.role || '').replace('_', ' '))}</small></div>` +
      '<button class="sb-logout" id="btn-logout" type="button" title="Sign out" aria-label="Sign out"><i class="ph-duotone ph-sign-out"></i></button></div>';
    $('sidebar').innerHTML = html;
    $('btn-logout').addEventListener('click', () => HD.logout());
  }

  function setupMobileMenu() {
    const toggle = $('menu-toggle');
    const set = (open) => document.body.classList.toggle('sb-open', open);
    if (toggle) toggle.addEventListener('click', () => set(!document.body.classList.contains('sb-open')));
    $('sb-scrim').addEventListener('click', () => set(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  }

  // ------------------------------------------------------------------ notifications bell
  const N_STYLE = {
    low_stock: ['ph-package', '#fff1d6', '#9a5b00'],
    expiry: ['ph-hourglass-high', '#fdecec', '#b3262b'],
    payment: ['ph-hand-coins', '#e3f6ec', '#146c43'],
    reminder: ['ph-bell-ringing', '#dff3f7', '#1d6b8a'],
    system: ['ph-info', '#f0f0ec', '#1a1a1c'],
  };
  let notifs = [];

  function drawNotifications() {
    const list = $('notif-list'); if (!list) return;
    const unread = notifs.filter((n) => !n.is_read).length;
    const dot = $('notif-dot');
    dot.hidden = unread === 0; dot.textContent = unread > 9 ? '9+' : unread;
    $('notif-readall').hidden = unread === 0;
    if (!notifs.length) {
      list.innerHTML = '<div class="notif-empty"><i class="ph-duotone ph-bell-slash"></i>You\'re all caught up</div>';
      return;
    }
    list.innerHTML = notifs.map((n) => {
      const [ic, bg, fg] = N_STYLE[n.type] || N_STYLE.system;
      return `<div class="notif-item${n.is_read ? '' : ' unread'}" data-id="${n.id}" role="button" tabindex="0">` +
        `<span class="n-ico" style="background:${bg};color:${fg}"><i class="ph-duotone ${ic}"></i></span>` +
        `<div><b>${fmt.esc(n.title)}</b>${n.message ? `<small>${fmt.esc(n.message)}</small><br>` : ''}<small>${fmt.ago(n.created_at)}</small></div></div>`;
    }).join('');
  }

  async function refreshNotifications() {
    try { notifs = await api('/notifications?limit=15'); drawNotifications(); } catch (e) { /* bell just stays as it was */ }
  }

  function setupNotifications() {
    if (!$('notif-list')) return;
    $('notif-list').addEventListener('click', async (e) => {
      const item = e.target.closest('.notif-item'); if (!item) return;
      const n = notifs.find((x) => String(x.id) === item.dataset.id);
      if (n && !n.is_read) { n.is_read = true; drawNotifications(); api('/notifications/' + n.id + '/read', { method: 'POST' }).catch(() => {}); }
    });
    $('notif-readall').addEventListener('click', async () => {
      notifs.forEach((n) => { n.is_read = true; }); drawNotifications();
      api('/notifications/read-all', { method: 'POST' }).catch(() => {});
    });
    refreshNotifications();
    setInterval(refreshNotifications, 120000);
  }

  // ------------------------------------------------------------------ boot
  renderSidebar();
  setupMobileMenu();
  applyPerms();
  setupNotifications();

  // Keep the stored user (role/permissions) fresh; a disabled account is signed out.
  api('/auth/me').then((me) => { const s = Session.get(); if (s) Session.save({ ...s, user: me }); })
    .catch((e) => { if (e.code === 'ACCOUNT_DISABLED') { Session.clear(); location.replace(config.LOGIN_PAGE); } });

  HD.fmt = fmt;
  HD.shell = { can, canAny, applyPerms, refreshNotifications };
})();