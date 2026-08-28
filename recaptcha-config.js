/* ================= reCAPTCHA v3 client config (one shared file for every form page) =====
   The SITE key below is public by design (it appears in every visitor's browser).
   The SECRET key lives ONLY in the RECAPTCHA_SECRET_KEY Vercel env var — never here.
   Keys admin: https://www.google.com/recaptcha/admin (label: DesignsLab AI, v3). */
window.RECAPTCHA_SITE_KEY = '6LevQp0tAAAAAIr9nJi8cQrUWCnfoQtjiutCgHAN';

// Loads Google's api.js once, only when a key is configured — pages keep working with an
// empty key (server-side verification also skips when its secret is absent).
(function () {
  if (!window.RECAPTCHA_SITE_KEY) return;
  var s = document.createElement('script');
  s.src = 'https://www.google.com/recaptcha/api.js?render=' + window.RECAPTCHA_SITE_KEY;
  s.async = true;
  document.head.appendChild(s);
})();

/* Returns a v3 token for the given action name (e.g. 'contact', 'enterprise', 'signup',
   'login'), or null if reCAPTCHA isn't configured/loaded — callers just attach whatever
   comes back; the server decides whether a missing token matters. Never throws. */
async function getRecaptchaToken(action) {
  try {
    if (!window.RECAPTCHA_SITE_KEY || !window.grecaptcha) return null;
    await new Promise(function (resolve) { window.grecaptcha.ready(resolve); });
    return await window.grecaptcha.execute(window.RECAPTCHA_SITE_KEY, { action: action });
  } catch (e) {
    return null;
  }
}
