/* Host handling for the service worker (card HHyedSAg). Loaded first by the generated worker
 * (importScripts) and by push-sw.js. Hivenod has ONE public address, https://hivenod.com.
 * The Hosting site also answers on hivenod.web.app and hive-board-43be.web.app; visitors there
 * (with or without an older service worker) are sent to hivenod.com. Preview channels
 * (hivenod--<name>.web.app) and localhost are left alone. */
(function (root) {
  var PUBLIC = 'https://hivenod.com';
  var LEGACY = /^(hivenod|hive-board-43be)\.web\.app$/;

  // Where a navigation to `href` should go instead, or null to serve it normally.
  // /version.json, /cli/** and Firebase's /__/ handler stay on every host.
  function redirectTarget(href) {
    var u = new URL(href);
    if (!LEGACY.test(u.hostname)) return null;
    if (u.pathname === '/version.json' || u.pathname.indexOf('/cli/') === 0) return null;
    if (u.pathname.indexOf('/__/') === 0) return null;
    return PUBLIC + u.pathname + u.search + u.hash;
  }

  // The origin that notification taps open: hivenod.com for the legacy hosts, otherwise this origin.
  function appOrigin(origin) {
    return LEGACY.test(new URL(origin).hostname) ? PUBLIC : origin;
  }

  var api = { redirectTarget: redirectTarget, appOrigin: appOrigin };
  root.hivenodHost = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof root.addEventListener !== 'function' || !root.registration) return;

  // Navigations on a legacy host never get the cached shell: redirect right away.
  root.addEventListener('fetch', function (event) {
    if (event.request.mode !== 'navigate') return;
    var target = redirectTarget(event.request.url);
    if (target) event.respondWith(Response.redirect(target, 302));
  });

  // The new worker takes over at once; open windows on a legacy host are reloaded, and that
  // reload goes through the fetch handler above to hivenod.com. (WindowClient.navigate only
  // accepts same-origin URLs, so the reload is the way to move the page.)
  root.addEventListener('activate', function (event) {
    if (!LEGACY.test(root.location.hostname)) return;
    event.waitUntil(
      root.clients
        .claim()
        .then(function () {
          return root.clients.matchAll({ type: 'window', includeUncontrolled: true });
        })
        .then(function (list) {
          return Promise.all(
            list.map(function (c) {
              return redirectTarget(c.url) && 'navigate' in c
                ? c.navigate(c.url).catch(function () {})
                : null;
            }),
          );
        }),
    );
  });
})(self);
