// TENTEN service worker (site root, scope "/"): shows "opponent waiting" push
// alerts and opens TENTEN when one is tapped. Pushes are sent by the game
// servers to the subscriptions saved via /api/push-subscribe.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'TENTEN', {
    body: data.body || 'An opponent is waiting — tap to play',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'tenten',
    renotify: true,
    data: { url: data.url || '/' },
  }));
});

// Tap: bring an open TENTEN tab to the front (and take it to the match), or
// open TENTEN at the alert's link.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find(c => new URL(c.url).origin === self.location.origin);
    if (tab) {
      await tab.focus();
      if ('navigate' in tab) { try { await tab.navigate(url); } catch (e) {} }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
