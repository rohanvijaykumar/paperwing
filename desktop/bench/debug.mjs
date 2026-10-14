import { launch, sleep } from './harness.mjs';
const app = await launch();
await sleep(2500);
await app.page.evaluate(() => {
  window.__ev = [];
  const t0 = () => performance.now();
  const watch = () => {
    const host = document.querySelector('#viewer-host embedpdf-container');
    if (!host?.shadowRoot) return setTimeout(watch, 5);
    new MutationObserver((muts) => {
      for (const m of muts)
        for (const n of m.addedNodes) {
          const imgs =
            n.tagName === 'IMG'
              ? [n]
              : n.querySelectorAll
                ? [...n.querySelectorAll('img')]
                : [];
          for (const img of imgs) {
            window.__ev.push(['img-added', t0(), img.style.width]);
            img.addEventListener('load', () =>
              window.__ev.push([
                'img-load',
                t0(),
                img.style.width,
                img.naturalWidth,
              ])
            );
          }
        }
      for (const m of muts)
        if (m.type === 'attributes' && m.target.tagName === 'IMG')
          window.__ev.push(['img-attr', t0(), m.attributeName]);
    }).observe(host.shadowRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  };
  watch();
  const po = new PerformanceObserver((l) =>
    l
      .getEntries()
      .forEach((e) => window.__ev.push(['mark ' + e.name, e.startTime]))
  );
  po.observe({ type: 'mark', buffered: false });
  new PerformanceObserver((l) =>
    l
      .getEntries()
      .forEach((e) =>
        window.__ev.push([
          'LONGTASK ' + Math.round(e.duration) + 'ms',
          e.startTime,
        ])
      )
  ).observe({ type: 'longtask' });
  const st = window.setTimeout;
  window.setTimeout = function (fn, ms, ...a) {
    if (ms >= 100)
      window.__ev.push([
        'setTimeout ' + ms,
        t0(),
        (new Error().stack || '')
          .split(String.fromCharCode(10))[2]
          ?.trim()
          .slice(0, 110),
      ]);
    return st.call(this, fn, ms, ...a);
  };
  window.__ev.push(['start', t0()]);
  const seen = new WeakSet();
  const desc = (d) => {
    try {
      if (!d || typeof d !== 'object') return String(d).slice(0, 60);
      const keys = Object.keys(d).slice(0, 6);
      const name = d.type ?? d.method ?? d.name ?? d.fn ?? d.kind ?? '';
      const inner =
        (d.method ?? '') + ' ' + (d.request?.method ?? d.data?.type ?? '');
      return `${name} ${inner} {${keys.join(',')}}`.slice(0, 120);
    } catch {
      return '?';
    }
  };
  const orig = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (msg, ...rest) {
    if (!seen.has(this)) {
      seen.add(this);
      this.addEventListener('message', (e) =>
        window.__ev.push(['<- worker', t0(), desc(e.data)])
      );
    }
    window.__ev.push(['-> worker', t0(), desc(msg)]);
    return orig.call(this, msg, ...rest);
  };
});
await app.openFile(process.argv[2]);
await sleep(3000);
const ev = await app.page.evaluate(() => window.__ev);
const base = ev[0][1];
for (const e of ev)
  console.log(
    String(Math.round(e[1] - base)).padStart(6),
    e[0],
    e.slice(2).join(' ')
  );
await app.close();
