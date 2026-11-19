// Runs before first paint (classic script, no module) so the page never flashes the wrong theme.
(function () {
  var q = new URLSearchParams(location.search).get('theme');
  var saved = null; try { saved = localStorage.getItem('gator-theme'); } catch (e) {}
  var sys = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  var t = (q === 'dark' || q === 'light') ? q : (saved || sys);
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.setAttribute('data-theme-src', (q === 'dark' || q === 'light') ? 'url' : saved ? 'user' : 'system');
})();
