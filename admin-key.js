// Admin key for the admin pages (admin*.html). It is never in the code: the
// page asks for it once and keeps it for this browser tab only
// (sessionStorage). Any admin call answered 401 forgets it and asks again.
(function () {
  var STORE = 'tenten_admin_key';
  function read() { try { return sessionStorage.getItem(STORE) || ''; } catch (e) { return ''; } }
  function write(v) { try { if (v) sessionStorage.setItem(STORE, v); else sessionStorage.removeItem(STORE); } catch (e) {} }

  window.tentenAdminKey = function () {
    var key = read();
    while (!key) {
      key = (window.prompt('TENTEN admin key') || '').trim();
      if (!key) { document.documentElement.innerHTML = '<body style="background:#000;color:#fff;font:14px sans-serif;padding:24px">Admin key needed. Reload to try again.</body>'; throw new Error('no admin key'); }
    }
    write(key);
    return key;
  };

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    return realFetch(input, init).then(function (res) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      // Only tenten.run's own /api/admin decides the key is wrong: a game
      // server still on an old key just fails its own panel.
      var own = false;
      try { var u = new URL(url, location.href); own = u.origin === location.origin && u.pathname === '/api/admin'; } catch (e) {}
      if (res.status === 401 && own && read()) {
        write('');
        alert('That admin key was refused. Enter it again.');
        location.reload();
      }
      return res;
    });
  };
})();
