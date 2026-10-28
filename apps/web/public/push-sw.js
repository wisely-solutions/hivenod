/* Web Push for Hivenod (card rN5Q12W2). Loaded by the generated service worker (importScripts).
 * The notifier sends {title, body, url, sentAt}; a tap opens (or focuses) the item.
 * Pop-ups are live only (item 3ENs): a push stamped more than 5 minutes ago (a device that woke
 * up, a browser that just started) is dropped; it is in the bell instead. */
(function (root) {
  var MAX_AGE_MS = 5 * 60 * 1000;

  // True when a push should still pop up. Pushes without a stamp come from an older notifier and
  // are shown as before.
  function pushIsFresh(data, now) {
    var sentAt = data && data.sentAt;
    if (typeof sentAt !== 'number' || !isFinite(sentAt)) return true;
    return now - sentAt <= MAX_AGE_MS;
  }

  var api = { pushIsFresh: pushIsFresh, MAX_AGE_MS: MAX_AGE_MS };
  root.hivenodPush = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(self);

self.addEventListener('push', function (event) {
  var data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Hivenod', body: event.data ? event.data.text() : '' };
  }
  if (!self.hivenodPush.pushIsFresh(data, Date.now())) return;
  var title = data.title || 'Hivenod';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.url || 'hivenod',
      renotify: true,
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var path = (event.notification.data && event.notification.data.url) || '/';
  // Absolute on the public address, so devices that subscribed on an old address open hivenod.com.
  var origin = self.hivenodHost
    ? self.hivenodHost.appOrigin(self.location.origin)
    : self.location.origin;
  var target = new URL(path, origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ('focus' in c && 'navigate' in c && new URL(c.url).origin === new URL(target).origin) {
          return c.navigate(target).then(function (w) {
            return (w || c).focus();
          });
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
