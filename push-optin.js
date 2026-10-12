// "🔔 Get notified when rooms open" on the homepage. Registers /sw.js (scope
// "/"), asks for notification permission, subscribes with the VAPID public key
// from /api/push-subscribe and saves the subscription there.
//
// iPhone/iPad: web push only works for TENTEN added to the Home Screen and
// opened from that icon, so Safari tabs get instructions instead of a button.
(function () {
  var box = document.getElementById('push-optin');
  if (!box) return;

  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function show(html) { box.innerHTML = html; box.hidden = false; }
  function note(text, cls) { show('<span class="po-note ' + (cls || '') + '"></span>'); box.firstChild.textContent = text; }
  function on() { show('<span class="po-on">✓ Alerts on</span><span class="po-sub">We’ll buzz you when a room opens.</span>'); }
  function button(err) {
    show('<button type="button" class="po-btn" id="push-optin-btn">🔔 Get notified when rooms open</button>' + (err ? '<span class="po-note po-err"></span>' : ''));
    if (err) box.lastChild.textContent = err;
    document.getElementById('push-optin-btn').addEventListener('click', enable);
  }

  function keyBytes(base64) {
    var pad = '='.repeat((4 - base64.length % 4) % 4);
    var raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function save(sub) {
    return fetch('/api/push-subscribe', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) })
      .then(function (r) { if (!r.ok) throw new Error('save failed'); });
  }

  function enable() {
    var btn = document.getElementById('push-optin-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Turning on…'; }
    // Ask first, straight from the tap (Safari only allows the prompt from a user gesture).
    var asked = Notification.requestPermission();
    Promise.resolve(asked).then(function (permission) {
      if (permission !== 'granted') {
        if (permission === 'denied') note('Alerts are blocked — allow notifications for tenten.run in your settings to turn them on.', 'po-err');
        else button();
        return null;
      }
      return Promise.all([
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function () { return navigator.serviceWorker.ready; }),
        fetch('/api/push-subscribe', { cache: 'no-store' }).then(function (r) { return r.json(); }),
      ]).then(function (parts) {
        var reg = parts[0], key = parts[1] && parts[1].publicKey;
        if (!key) throw new Error('Alerts aren’t set up yet — try again later.');
        return reg.pushManager.getSubscription().then(function (existing) {
          return existing || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
        });
      }).then(function (sub) { return save(sub); }).then(on);
    }).catch(function (e) {
      button((e && e.message && /set up yet/.test(e.message)) ? e.message : 'Couldn’t turn alerts on — please try again.');
    });
  }

  if (isIOS && !standalone) {
    note('On iPhone? Tap the Share button, then ‘Add to Home Screen’ — then open TENTEN from that icon to turn on alerts.');
    return;
  }
  if (!supported) { note('Room alerts aren’t supported in this browser.'); return; }
  if (Notification.permission === 'denied') { note('Alerts are blocked — allow notifications for tenten.run in your settings to turn them on.', 'po-err'); return; }

  // Already on? (permission granted and this browser still has its subscription.)
  // Re-saved quietly, so a subscription the server dropped comes back.
  if (Notification.permission === 'granted') {
    navigator.serviceWorker.getRegistration('/').then(function (reg) {
      return reg ? reg.pushManager.getSubscription() : null;
    }).then(function (sub) {
      if (sub) { on(); save(sub).catch(function () {}); } else button();
    }).catch(function () { button(); });
    return;
  }
  button();
})();
