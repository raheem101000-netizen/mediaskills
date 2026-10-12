// Creator referral capture: a visitor arriving with ?ref=CODE keeps that code
// (first-party cookie + localStorage, 90 days) until they sign up, where
// api/signup.js attributes the new account to the creator. The first code
// captured wins — a later ?ref link doesn't replace it.
(function () {
  try {
    var KEY = 'tenten_ref', MAX_AGE = 90 * 24 * 60 * 60;
    var code = (new URLSearchParams(window.location.search).get('ref') || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return;
    var stored = document.cookie.match(/(?:^|;\s*)tenten_ref=([A-Z0-9]{6})/);
    var kept = stored ? stored[1] : null;
    try { kept = kept || localStorage.getItem(KEY); } catch (e) {}
    if (kept) return;
    document.cookie = KEY + '=' + code + '; Max-Age=' + MAX_AGE + '; Path=/; SameSite=Lax; Secure';
    try { localStorage.setItem(KEY, code); } catch (e) {}
  } catch (e) {}
})();

// The captured code (or null), for the signup page to send along.
window.tentenRefCode = function () {
  var m = document.cookie.match(/(?:^|;\s*)tenten_ref=([A-Z0-9]{6})/);
  if (m) return m[1];
  try { return localStorage.getItem('tenten_ref'); } catch (e) { return null; }
};
