(function () {
  'use strict';
  const { api, Session, config } = HD;
  const $ = (id) => document.getElementById(id);

  $('year').textContent = new Date().getFullYear();

  // ------------------------------------------------------------------ view switching
  const views = { login: $('view-login'), forgot: $('view-forgot'), reset: $('view-reset') };

  function showView(name) {
    Object.entries(views).forEach(([key, el]) => { el.hidden = key !== name; });
    const first = views[name].querySelector('input');
    if (first && window.matchMedia('(min-width: 768px)').matches) first.focus({ preventScroll: true });
  }

  document.querySelectorAll('[data-view]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (link.dataset.view === 'forgot') $('forgot-email').value = $('login-email').value.trim();
      showView(link.dataset.view);
    });
  });

  // ------------------------------------------------------------------ small helpers
  function showAlert(id, message, type = 'danger') {
    const box = $(id);
    box.className = 'hd-alert hd-alert-' + type + ' mb-3';
    box.querySelector('i').className = 'ph-duotone ' + (type === 'success' ? 'ph-check-circle' : 'ph-warning-circle');
    box.querySelector('span').textContent = message;
    box.hidden = false;
    box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
  }
  const hideAlert = (id) => { $(id).hidden = true; };

  /** Swap the button into a "working" state; returns a function that restores it. */
  function setBusy(button, text) {
    const label = button.querySelector('.label');
    const icon = button.querySelector('.btn-icon');
    const before = { text: label.textContent, icon: icon.innerHTML };
    button.disabled = true;
    label.textContent = text;
    icon.innerHTML = '<i class="ph-bold ph-spinner-gap spin"></i>';
    return () => { button.disabled = false; label.textContent = before.text; icon.innerHTML = before.icon; };
  }

  // show / hide password
  document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.togglePassword);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.firstElementChild.className = 'ph-duotone ' + (show ? 'ph-eye-slash' : 'ph-eye');
      input.focus();
    });
  });

  // clear the red state as soon as the person starts fixing a field
  document.querySelectorAll('.form-control').forEach((input) => {
    input.addEventListener('input', () => input.classList.remove('is-invalid'));
  });

  function friendlyLoginError(err) {
    switch (err.code) {
      case 'INVALID_CREDENTIALS': return 'Incorrect email or password. Please try again.';
      case 'ACCOUNT_DISABLED': return 'This account has been disabled. Please contact your administrator.';
      case 'NETWORK_ERROR': return err.message;
      default: return err.message; // includes "too many attempts" (429) and validation messages from the API
    }
  }

  // ------------------------------------------------------------------ sign in
  const loginForm = $('login-form');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert('login-alert');
    if (!loginForm.checkValidity()) {
      [...loginForm.elements].forEach((el) => el.classList && el.classList.toggle('is-invalid', el.willValidate && !el.validity.valid));
      return;
    }
    const restore = setBusy($('login-submit'), 'Signing in…');
    try {
      const data = await api('/auth/login', {
        method: 'POST', auth: false,
        body: { email: $('login-email').value.trim(), password: $('login-password').value },
      });
      Session.save(
        { access_token: data.access_token, refresh_token: data.refresh_token, user: data.user },
        $('login-remember').checked,
      );
      $('login-submit').querySelector('.label').textContent = 'Welcome!';
      location.replace(config.HOME_PAGE);
    } catch (err) {
      restore();
      showAlert('login-alert', friendlyLoginError(err));
      $('login-password').value = '';
      $('login-password').focus();
    }
  });

  // ------------------------------------------------------------------ forgot password
  const forgotForm = $('forgot-form');
  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert('forgot-alert'); hideAlert('forgot-success');
    if (!forgotForm.checkValidity()) { $('forgot-email').classList.add('is-invalid'); return; }
    const restore = setBusy($('forgot-submit'), 'Sending…');
    try {
      const data = await api('/auth/forgot-password', { method: 'POST', auth: false, body: { email: $('forgot-email').value.trim() } });
      $('forgot-success').querySelector('span').textContent = data.message || 'If that email has an account, a reset link has been sent.';
      $('forgot-success').hidden = false;
    } catch (err) {
      showAlert('forgot-alert', err.message);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------ reset password (?token=...)
  const params = new URLSearchParams(location.search);
  const resetToken = params.get('token');
  const resetForm = $('reset-form');

  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert('reset-alert');
    const pw = $('reset-password'), confirm = $('reset-confirm');
    pw.classList.toggle('is-invalid', !pw.checkValidity());
    confirm.classList.toggle('is-invalid', pw.value !== confirm.value || !confirm.value);
    if (!pw.checkValidity() || pw.value !== confirm.value) return;

    const restore = setBusy($('reset-submit'), 'Updating…');
    try {
      await api('/auth/reset-password', { method: 'POST', auth: false, body: { token: resetToken, new_password: pw.value } });
      history.replaceState(null, '', location.pathname); // drop the token from the address bar
      resetForm.reset();
      showView('login');
      showAlert('login-alert', 'Password updated. Sign in with your new password.', 'success');
    } catch (err) {
      showAlert('reset-alert', err.message);
    } finally {
      restore();
    }
  });

  // ------------------------------------------------------------------ on load
  if (resetToken) {
    showView('reset');
  } else if (location.hash === '#forgot') {
    showView('forgot');
  } else if (Session.get()) {
    // already signed in? skip the form if the session is still good
    api('/auth/me').then((user) => {
      const s = Session.get();
      if (s) Session.save({ ...s, user });
      location.replace(config.HOME_PAGE);
    }).catch(() => { Session.clear(); });
  }
})();
