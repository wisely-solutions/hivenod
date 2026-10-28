(function () {
  // The Hosting site also answers on hivenod.web.app and hive-board-43be.web.app (same files; Hosting
  // cannot redirect by host on one site). Send people who land there to the one public address.
  // Exact hosts only, so preview channels (hivenod--<name>.web.app) keep working.
  // Firebase's /__/ handler pages (auth handler, init.json) stay where they are.
  if (
    /^(hivenod|hive-board-43be)\.web\.app$/.test(location.hostname) &&
    location.pathname.indexOf('/__/') !== 0
  ) {
    location.replace('https://hivenod.com' + location.pathname + location.search + location.hash);
    return;
  }
  var root = document.documentElement;
  var stored = null;
  try {
    // Looks signed in: the HTML's own skeleton shows until the app takes over.
    if (localStorage.getItem('hive-auth') === '1') root.dataset.auth = '1';
  } catch {
    /* storage blocked */
  }
  try {
    stored = localStorage.getItem('hive-theme');
  } catch {
    /* storage blocked */
  }
  if (stored === 'light' || stored === 'dark') {
    root.dataset.theme = stored;
    return;
  }
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  root.dataset.theme = mq.matches ? 'dark' : 'light';
  mq.addEventListener('change', function (e) {
    var s = null;
    try {
      s = localStorage.getItem('hive-theme');
    } catch {
      /* storage blocked */
    }
    if (s !== 'light' && s !== 'dark') root.dataset.theme = e.matches ? 'dark' : 'light';
  });
})();
