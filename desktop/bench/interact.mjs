/**
 * Interaction benchmarks against the real desktop app:
 *   node bench/interact.mjs <heavy.pdf> [runs]
 *
 * - launch with a file (double-click a PDF in Explorer/Finder) -> first page visible
 * - open a PDF in the running app -> first page visible
 * - Home: switch to it, and render a 50-entry recent list
 * - scrolling a long document: frame times and blank (unrendered) area
 * - jump to page 250 -> page visible
 * - open a tool (Compress) on the document -> tool ready
 */
import { rmSync } from 'node:fs';
import { launch, sleep, stats } from './harness.mjs';

const [file, runsArg, ...sessionArgs] = process.argv.slice(2);
const SESSION_FILES = sessionArgs.length ? sessionArgs : [file];
const RUNS = Number(runsArg || 3);
const only = process.env.BENCH_ONLY?.split(',');
const want = (name) => !only || only.includes(name);

/** Helpers injected into the workspace page */
const PAGE_HELPERS = () => {
  const root = () =>
    document.querySelector('#viewer-host embedpdf-container')?.shadowRoot;
  const scroller = () => root()?.querySelector('div.bg-bg-app');
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  /** Share of the visible page area that shows a rendered page image */
  function coverage() {
    const r = root();
    const s = scroller();
    if (!r || !s) return null;
    const view = s.getBoundingClientRect();
    let total = 0;
    let shown = 0;
    const all = [...r.querySelectorAll('div')].filter(
      (d) => d.style.touchAction === 'none'
    );
    // Pages only: boxes that don't contain other page boxes
    const pagesOnly = all.filter(
      (d) => !all.some((o) => o !== d && d.contains(o))
    );
    for (const box of pagesOnly) {
      const b = box.getBoundingClientRect();
      const w = Math.min(b.right, view.right) - Math.max(b.left, view.left);
      const h = Math.min(b.bottom, view.bottom) - Math.max(b.top, view.top);
      if (w <= 0 || h <= 0) continue;
      total += w * h;
      const img = [...box.querySelectorAll('img')].find(
        (i) => i.complete && i.naturalWidth
      );
      if (img) shown += w * h;
    }
    return total ? shown / total : null;
  }
  async function until(fn, timeout = 30000) {
    const end = performance.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() > end) throw new Error('timeout');
      await Promise.race([raf(), new Promise((r) => setTimeout(r, 50))]);
    }
  }
  window.__bench = {
    root,
    scroller,
    coverage,
    until,
    raf,
    /** epoch ms when the first page image is on screen */
    async firstPage(timeout) {
      let last;
      try {
        await until(() => {
          last = coverage();
          if (
            last > 0 &&
            !performance.getEntriesByName('bench:first-pixels').length
          )
            performance.mark('bench:first-pixels');
          return last === 1;
        }, timeout);
      } catch {
        throw new Error(
          `first page never shown (coverage ${last}, doc ${!!document.querySelector('#view-doc.is-active')})`
        );
      }
      return performance.timeOrigin + performance.now();
    },
    drop(b64, name) {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
      const t0 = performance.now();
      window.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
        })
      );
      return t0;
    },
    async scroll(pxPerSec, seconds) {
      const s = scroller();
      s.scrollTop = 0;
      await until(() => coverage() === 1);
      const frames = [];
      const cover = [];
      let last = performance.now();
      const end = last + seconds * 1000;
      while (performance.now() < end) {
        await raf();
        const now = performance.now();
        frames.push(now - last);
        s.scrollTop += (pxPerSec * (now - last)) / 1000;
        last = now;
        const c = coverage();
        if (c != null) cover.push(c);
      }
      frames.sort((a, b) => a - b);
      const q = (p) =>
        frames[Math.min(frames.length - 1, Math.floor(frames.length * p))];
      return {
        fps: Math.round(frames.length / seconds),
        p50: +q(0.5).toFixed(1),
        p95: +q(0.95).toFixed(1),
        max: +frames[frames.length - 1].toFixed(1),
        longFrames: frames.filter((f) => f > 50).length,
        shownPct: Math.round(
          (cover.reduce((n, c) => n + c, 0) / cover.length) * 100
        ),
      };
    },
    async jump(fraction) {
      const s = scroller();
      const t0 = performance.now();
      s.scrollTop = s.scrollHeight * fraction;
      await raf();
      await until(() => coverage() === 1);
      return performance.now() - t0;
    },
    async home() {
      const t0 = performance.now();
      document.getElementById('home-btn').click();
      await until(() => document.querySelector('#view-home.is-active'));
      await raf();
      await raf();
      return performance.now() - t0;
    },
  };
};

const results = {};
const add = (k, v) => (results[k] ??= []).push(v);

/** Open the file as a second launch would (double-click while running) */
async function openDoc(app, label) {
  await app.page.evaluate(() => performance.clearMarks());
  const t0 = Date.now();
  const shown = app.page.evaluate(() => window.__bench.firstPage(60000));
  await app.openFile(file);
  const at = await shown;
  if (label) {
    const marks = await app.page.evaluate(() =>
      performance
        .getEntriesByType('mark')
        .map((m) => [m.name, performance.timeOrigin + m.startTime])
    );
    for (const [name, t] of marks)
      if (/^(pw|bench):/.test(name)) add(`  ${label}: ${name}`, t - t0);
  }
  return at - t0;
}

for (let run = 0; run < RUNS; run++) {
  // 1. Launch with a file from the OS
  if (want('launchFile')) {
    const t = Date.now();
    const app = await launch({ args: [file] });
    await app.page.evaluate(PAGE_HELPERS);
    const shownAt = await app.page.evaluate(() =>
      window.__bench.firstPage(60000)
    );
    add('launch with file -> page visible', shownAt - t);
    // Where the time went, relative to the launch
    const marks = await app.page.evaluate(() =>
      performance
        .getEntriesByType('mark')
        .map((m) => [m.name, performance.timeOrigin + m.startTime])
    );
    for (const [name, at] of marks)
      if (/^(pw|bench):/.test(name)) add(`  launch: ${name}`, at - t);
    for (const k of ['app ready', 'main window shown'])
      if (app.marks[k]) add(`  launch: ${k} (main)`, app.marks[k]);
    await sleep(400);
    add(
      '  launch: doc scrolled from top (px)',
      await app.page.evaluate(() => window.__bench.scroller().scrollTop)
    );
    await app.close();
    await sleep(500);
  }

  // 1b. Launch with a session of 4 documents to restore
  if (want('session')) {
    const prep = await launch();
    await prep.page.evaluate(PAGE_HELPERS);
    for (const f of SESSION_FILES) {
      const shown = prep.page.evaluate(() => window.__bench.firstPage(60000));
      await prep.openFile(f);
      await shown;
    }
    await sleep(3000); // let localStorage/IndexedDB commit
    const profile = prep.userData;
    await prep.close({ keepProfile: true });
    await sleep(500);
    const t = Date.now();
    const app = await launch({ profile });
    await app.page.evaluate(PAGE_HELPERS);
    const shownAt = await app.page.evaluate(() =>
      window.__bench.firstPage(60000)
    );
    add('launch with 4-doc session -> page visible', shownAt - t);
    // CPU is free again once the front document is shown; switching to
    // another restored tab then loads it (lazily, after the fix)
    await sleep(1500);
    const switchMs = await app.page.evaluate(async () => {
      const opened = performance.getEntriesByName('pw:doc-opened').length;
      const other = [
        ...document.querySelectorAll('#tabs .tab:not(.is-active)'),
      ][0];
      const label = other.textContent.trim();
      const t0 = performance.now();
      other.click();
      // (the tab strip is re-rendered, so compare by label)
      await window.__bench.until(
        () =>
          document.querySelector('#tabs .tab.is-active')?.textContent.trim() ===
          label
      );
      // Either it was loaded already or it loads now
      await new Promise((r) => setTimeout(r, 30));
      await window.__bench.until(() => window.__bench.coverage() === 1, 60000);
      return {
        ms: performance.now() - t0,
        loadedNow:
          performance.getEntriesByName('pw:doc-opened').length > opened,
      };
    });
    add('session: switch to another restored tab -> visible', switchMs.ms);
    add(
      'session: docs loaded at launch',
      await app.page.evaluate(
        () => performance.getEntriesByName('pw:doc-opened').length - 1
      )
    );
    await app.close();
    try {
      rmSync(profile, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    } catch {}
    await sleep(500);
  }

  const app = await launch();
  await app.page.evaluate(PAGE_HELPERS);
  await sleep(2500); // let the app settle (engine warm-up, idle work)

  // 2. Open a PDF in the running app
  if (want('open')) add('open PDF (app running)', await openDoc(app, 'open'));
  else await openDoc(app);

  // 3. Scrolling
  if (want('scroll')) {
    await sleep(800);
    const slow = await app.page.evaluate(() => window.__bench.scroll(1500, 5));
    const fast = await app.page.evaluate(() => window.__bench.scroll(6000, 5));
    for (const [k, v] of Object.entries(slow)) add(`scroll 1500px/s ${k}`, v);
    for (const [k, v] of Object.entries(fast)) add(`scroll 6000px/s ${k}`, v);
  }

  // 4. Jump deep into the document
  if (want('jump')) {
    await sleep(500);
    add(
      'jump to 83% of doc -> visible',
      await app.page.evaluate(() => window.__bench.jump(249 / 300))
    );
  }

  // 5. Home
  if (want('home')) {
    await sleep(500);
    add('switch to Home', await app.page.evaluate(() => window.__bench.home()));
  }

  // 6. Open a tool on the document
  if (want('tool')) {
    await app.page.evaluate(() => {
      document.querySelector('#tabs [role="tab"]:not(.tab-home)')?.click();
    });
    await sleep(800);
    const ms = await app.page.evaluate(async () => {
      const ready = new Promise((r) =>
        window.addEventListener(
          'message',
          (e) => e.data?.type === 'acro:ready' && r(),
          { once: false }
        )
      );
      const btn = [
        ...document.querySelectorAll(
          '#left-panel button, #left-panel [role="button"]'
        ),
      ].find((b) => /^Compress/i.test(b.textContent.trim()));
      if (!btn) return null;
      const t0 = performance.now();
      btn.click();
      await ready;
      return performance.now() - t0;
    });
    if (ms != null) add('open Compress tool -> ready', ms);
  }
  await app.close();
  await sleep(500);
}

console.log(`interaction benchmarks, ${RUNS} runs (ms unless noted)`);
for (const [k, vals] of Object.entries(results)) {
  console.log(`  ${k.padEnd(36)} ${JSON.stringify(stats(vals))}`);
}
