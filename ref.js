// Creator referral capture, loaded on every public TENTEN page: a visitor
// arriving with ?ref=CODE keeps that code on this device for 30 days (cookie
// + localStorage with the capture time), so the signup page's Referral Code
// field is pre-filled even if they sign up later. The first code captured
// wins until it expires — a later ?ref link doesn't replace it. A code typed
// into the field always beats the stored one (the field is what's sent).

// The kept code (or null): the cookie (the browser expires it), else the
// localStorage copy if it's under 30 days old.
window.tentenRefCode = function () {
  var m = document.cookie.match(/(?:^|;\s*)tenten_ref=([A-Z0-9]{6})/);
  if (m) return m[1];
  try {
    var raw = localStorage.getItem('tenten_ref');
    if (!raw) return null;
    if (/^[A-Z0-9]{6}$/.test(raw)) return raw;   // stored by an earlier version (no time)
    var v = JSON.parse(raw);
    if (v && /^[A-Z0-9]{6}$/.test(v.code) && Date.now() - v.at < 30 * 24 * 60 * 60 * 1000) return v.code;
    localStorage.removeItem('tenten_ref');
  } catch (e) {}
  return null;
};

// After a successful signup the code has done its job.
window.tentenRefClear = function () {
  document.cookie = 'tenten_ref=; Max-Age=0; Path=/; SameSite=Lax; Secure';
  try { localStorage.removeItem('tenten_ref'); } catch (e) {}
};

// Capture (after the helpers above are defined).
(function () {
  try {
    var KEY = 'tenten_ref', MAX_AGE = 30 * 24 * 60 * 60;
    var code = (new URLSearchParams(window.location.search).get('ref') || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return;
    if (window.tentenRefCode()) return;   // an unexpired code is already kept
    document.cookie = KEY + '=' + code + '; Max-Age=' + MAX_AGE + '; Path=/; SameSite=Lax; Secure';
    try { localStorage.setItem(KEY, JSON.stringify({ code: code, at: Date.now() })); } catch (e) {}
  } catch (e) {}
})();
