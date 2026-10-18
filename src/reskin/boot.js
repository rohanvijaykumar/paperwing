/*
 * Inlined into the <head> of every tool page (reskin/vite-plugin-reskin.ts),
 * so it runs before the page is first drawn. reskin.ts, a module, only runs
 * after the page has been painted once; until then an embedded tool would
 * show its standalone header, upload box and default theme for a frame or
 * two. This sets what the stylesheet needs for the very first paint:
 *   data-page                    page-specific styling
 *   rs-embedded, rs-full/-panel  inside the Paperwing workspace (?embed=)
 *   rs-has-doc                   the workspace is sending a document (?doc=1)
 *   data-theme, color-scheme     the workspace's theme (?theme=)
 * It only sets classes and attributes; reskin.ts still does the real work
 * (and checks who is embedding the page before trusting any messages).
 */
(function () {
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const page = (location.pathname.split('/').pop() || '').replace(
    /\.html$/,
    ''
  );
  root.setAttribute('data-page', page || 'index');

  const embedded = window.self !== window.top;
  if (embedded) {
    root.classList.add('rs-embedded');
    const mode = params.get('embed');
    if (mode === 'full' || mode === 'panel') root.classList.add('rs-' + mode);
    if (params.get('doc') === '1') root.classList.add('rs-has-doc');
  }

  const isPref = (v) => v === 'system' || v === 'light' || v === 'dark';
  let pref = embedded ? params.get('theme') : null;
  if (!isPref(pref)) {
    try {
      pref = localStorage.getItem('paperwing:theme');
    } catch {
      pref = null;
    }
  }
  let dark;
  if (pref === 'light' || pref === 'dark') {
    root.setAttribute('data-theme', pref);
    dark = pref === 'dark';
  } else {
    dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  root.style.colorScheme = dark ? 'dark' : 'light';
})();
