(function () {
  'use strict';
  const { api, Session } = HD;
  const { shell, fmt } = HD;
  const can = shell.can;
  const $ = (id) => document.getElementById(id);

  const user = Session.user() || {};
  $('greeting').textContent = `${fmt.greeting()}, ${String(user.name || '').split(' ')[0] || 'there'} · ` +
    fmt.dayLabel(fmt.today(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

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

  const SHOP_FIELDS = ['shop_name', 'currency', 'phone', 'email', 'kra_pin', 'address', 'receipt_footer'];
  const OPS_FIELDS = ['loyalty_points_per_kes', 'loyalty_kes_per_point', 'frequent_customer_min_visits', 'expiry_alert_days'];

  function fillForm(settings) {
    [...SHOP_FIELDS, ...OPS_FIELDS].forEach((k) => {
      const el = $(k);
      if (el && settings[k] !== undefined && settings[k] !== null) el.value = settings[k];
    });
  }

  function applyPermissions() {
    if (can('settings.manage')) return;
    const banner = document.createElement('div');
    banner.className = 'read-only-banner';
    banner.innerHTML = '<i class="ph-duotone ph-lock-simple"></i> You are viewing these settings in read-only mode.';
    document.querySelector('.row.grid-gap').prepend(banner);
    document.querySelectorAll('input, select, textarea, button[type=submit]').forEach((el) => { el.disabled = true; });
  }

  async function load() {
    try { fillForm(await api('/settings') || {}); }
    catch (err) { toast(err.message, true); }
  }

  function collect(keys) {
    const data = {};
    keys.forEach((k) => {
      const el = $(k);
      if (!el) return;
      const v = el.value;
      if (v === '' || v === null) return;
      data[k] = el.type === 'number' ? Number(v) : v;
    });
    return data;
  }

  async function save(keys, btn) {
    const payload = collect(keys);
    if (!Object.keys(payload).length) { toast('Nothing to save', true); return; }
    btn.disabled = true;
    try { await api('/settings', { method: 'PATCH', body: payload }); toast('Settings saved'); }
    catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; }
  }

  $('shop-form').addEventListener('submit', (e) => { e.preventDefault(); save(SHOP_FIELDS, $('btn-save-shop')); });
  $('ops-form').addEventListener('submit', (e) => { e.preventDefault(); save(OPS_FIELDS, $('btn-save-ops')); });
  $('btn-refresh').addEventListener('click', () => {
    const icon = $('btn-refresh').querySelector('i');
    icon.classList.add('spin');
    load().finally(() => icon.classList.remove('spin'));
  });

  (async function init() { applyPermissions(); await load(); })();
  if (shell.refreshNotifications) shell.refreshNotifications();
})();