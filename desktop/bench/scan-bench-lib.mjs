/**
 * What the scanning benches (check-scan*.mjs) share: starting the app with
 * the stand-in scanners, real mouse clicks on what the dialog shows, and
 * reading the dialog back the way a person sees it.
 */
import { launch, sleep } from './harness.mjs';

export { sleep };

let failures = 0;
export const check = (ok, what, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  return ok;
};
export const finish = () => {
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
};

export const until = async (page, fn, arg, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  return null;
};

export async function start(env = {}, args = []) {
  const app = await launch({
    // (pages up to 100 dpi, unless a bench asks for more: they stay quick)
    env: { PAPERWING_SCAN_TEST: '1', PAPERWING_SCAN_TEST_MAX_DPI: '100', ...env },
    args,
  });
  await sleep(2500);
  return app;
}

/** A real mouse click on the first visible element matching `selector`
 *  (and whose text starts with `text`, if given) */
export async function click(page, selector, text) {
  const box = await page.evaluate(
    ({ selector, text }) => {
      const visible = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !e.closest('[hidden]');
      };
      const e = [...document.querySelectorAll(selector)].find(
        (x) =>
          visible(x) &&
          (text === undefined ||
            x.textContent.trim().startsWith(text) ||
            x.getAttribute('aria-label')?.startsWith(text))
      );
      if (!e) return null;
      e.scrollIntoView({ block: 'nearest' });
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    { selector, text }
  );
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  return true;
}

/** A button in the scan dialog's actions, by its text */
export const press = (page, text) =>
  click(page, '.dlg-scan .dlg-actions button', text);

/** Chooses an option of one of the dialog's dropdowns (by its label) */
export const choose = (page, label, text, scope = '.dlg-scan') =>
  page.evaluate(
    ({ label, text, scope }) => {
      const s = [...document.querySelectorAll(`${scope} select[aria-label="${label}"]`)].find(
        (x) => !x.closest('[hidden]')
      );
      const o = s && [...s.options].find((x) => x.textContent === text);
      if (!o) return false;
      s.focus();
      s.value = o.value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    { label, text, scope }
  );

/** Ticks or unticks a checkbox by its label, with a click */
export async function tick(page, label, on = true, scope = '.dlg-scan') {
  const state = await page.evaluate(
    ({ label, scope }) =>
      [...document.querySelectorAll(`${scope} input[aria-label="${label}"]`)].find(
        (x) => !x.closest('[hidden]')
      )?.checked,
    { label, scope }
  );
  if (state === undefined) return false;
  if (state !== on) await click(page, `${scope} input[aria-label="${label}"]`);
  return true;
}

/** Sets a slider or number field by its label */
export const setValue = (page, label, value, scope = '.dlg-scan') =>
  page.evaluate(
    ({ label, value, scope }) => {
      const i = document.querySelector(`${scope} input[aria-label="${label}"]`);
      if (!i) return false;
      i.value = String(value);
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    { label, value, scope }
  );

/** Opens a collapsed group of settings */
export const openGroup = (page, title) =>
  page.evaluate((title) => {
    const b = [...document.querySelectorAll('.dlg-scan .sd-toggle')].find(
      (x) => x.textContent.trim() === title
    );
    if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
    return !!b;
  }, title);

/** Create ▸ From scanner, with the mouse; waits until it can scan */
export async function openDialog(page) {
  // (a document that just opened may still be settling: try again then)
  for (let attempt = 0; attempt < 3; attempt++) {
    await until(page, () => !document.querySelector('.dlg-backdrop'), undefined, 10000);
    await click(page, '#create-btn');
    if (
      (await until(page, () => document.querySelector('.menu .menu-item'), undefined, 5000)) &&
      (await click(page, '.menu .menu-item', 'From scanner')) &&
      (await until(page, () => document.querySelector('.dlg-scan'), undefined, 10000))
    )
      return waitReady(page);
    await page.keyboard.press('Escape');
    await sleep(1000);
  }
  return false;
}

/** The dialog is there, its scanner ready */
export const waitReady = (page, timeout = 20000) =>
  until(
    page,
    () => {
      const d = document.querySelector('.dlg-scan');
      if (!d) return false;
      const scan = [...d.querySelectorAll('.dlg-actions button')].find(
        (b) => b.textContent === 'Scan' || b.textContent === 'Scan more pages'
      );
      return !!scan && !scan.disabled;
    },
    undefined,
    timeout
  );

/** Waits for a scan, preview or making the PDF to end */
export const waitIdle = (page, timeout = 30000) =>
  until(
    page,
    () => {
      const d = document.querySelector('.dlg-scan');
      if (!d) return 'closed';
      const buttons = [...d.querySelectorAll('.dlg-actions button')];
      return (
        !buttons.some((b) => b.textContent === 'Stop') &&
        buttons.some(
          (b) =>
            !b.disabled &&
            ['Scan', 'Scan more pages', 'Scan is complete'].includes(b.textContent)
        ) &&
        ![...d.querySelectorAll('.sr-wait')].length
      );
    },
    undefined,
    timeout
  );

/** What the dialog shows */
export const dialog = (page) =>
  page.evaluate(() => {
    const d = document.querySelector('.dlg-scan');
    if (!d) return null;
    const shown = (e) => !!e && !e.closest('[hidden]');
    const opts = (label) => {
      const s = [...d.querySelectorAll(`select[aria-label="${label}"]`)].find(shown);
      return s ? [...s.options].map((o) => o.textContent) : null;
    };
    const value = (label) => {
      const s = [...d.querySelectorAll(`select[aria-label="${label}"]`)].find(shown);
      return s ? s.options[s.selectedIndex]?.textContent : null;
    };
    return {
      title: d.querySelector('.dlg-head h2').textContent,
      scanners: opts('Scanner'),
      scanner: value('Scanner'),
      preset: value('Preset'),
      presets: opts('Preset'),
      sources: opts('Source'),
      sides: opts('Pages'),
      colors: opts('Color mode'),
      dpi: opts('Resolution'),
      papers: opts('Paper size'),
      paper: value('Paper size'),
      summary: d.querySelector('.sd-summary').textContent,
      status: d.querySelector('.sd-status').textContent,
      thumbs: d.querySelectorAll('.sr-page').length,
      leftOut: d.querySelectorAll('.sr-page.is-left-out').length,
      pages: [...d.querySelectorAll('.sr-page')].map((p) => p.getAttribute('aria-label')),
      buttons: [...d.querySelectorAll('.dlg-actions button')]
        .filter((b) => !b.hidden)
        .map((b) => b.textContent),
      first: d.querySelector('.dlg-actions .accent-btn')?.textContent,
      previewTab: shown(d.querySelector('.sd-tabs .pd-seg-btn')),
      box: (() => {
        const b = d.querySelector('.sp-box');
        return b && !b.hidden ? b.getAttribute('style') : null;
      })(),
    };
  });

/** dialog() with has(label) answered for these labels */
export async function shows(page, labels) {
  return page.evaluate((labels) => {
    const d = document.querySelector('.dlg-scan');
    const shown = (e) => !!e && !e.closest('[hidden]');
    return Object.fromEntries(
      labels.map((l) => [l, [...d.querySelectorAll(`[aria-label="${l}"]`)].some(shown)])
    );
  }, labels);
}

export const docInfo = (page) =>
  page.evaluate(async () => {
    const v = window.__acro.viewer;
    const tab = document.querySelector('#tabs .tab.is-active');
    const id = v.docIds.get(v.current);
    const doc = id && v.cap('document-manager').getDocument(id);
    return {
      name: tab?.textContent.trim(),
      dirty: !!tab?.classList.contains('is-dirty'),
      pages: v.pageInfo(v.current)?.total ?? 0,
      size: doc?.pages?.[0]?.size,
    };
  });

export const pageCount = (page) =>
  page.evaluate(() => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total ?? 0);

export const toasts = (page) =>
  page.evaluate(() => document.querySelector('#toasts')?.textContent ?? '');

/** Ctrl+Z (⌘Z) as a real key press */
export async function undo(page) {
  const cdp = await page.target().createCDPSession();
  const MOD = process.platform === 'darwin' ? 4 : 2;
  for (const type of ['rawKeyDown', 'keyUp'])
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', modifiers: MOD });
}

/* Shared by the benches that check what a scan made ---------------------- */

/** Scan is complete: the new document's bytes once it has `pages` pages */
export async function complete(page, pages, timeout = 90000) {
  const tabs = await page.evaluate(() => document.querySelectorAll('#tabs .tab').length);
  if (!(await press(page, 'Scan is complete'))) check(false, '(setting up) Scan is complete');
  await until(page, () => !document.querySelector('.dlg-scan'), undefined, timeout);
  const ok = await until(
    page,
    ({ n, t }) =>
      document.querySelectorAll('#tabs .tab').length > t &&
      window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === n,
    { n: pages, t: tabs },
    timeout
  );
  if (!ok) check(false, `a new document with ${pages} pages`, JSON.stringify(await docInfo(page)));
  await sleep(800);
  const b64 = await page.evaluate(async () => {
    const v = window.__acro.viewer;
    const bytes = new Uint8Array(await v.exportBytes(v.current));
    let s = '';
    for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}

/** The scan box drawn on the glass, in inches */
export async function boxNow(page, glass) {
  const style = (await dialog(page))?.box;
  if (!style) return null;
  const n = (k) => Number(new RegExp(`${k}: ([\\d.]+)%`).exec(style)?.[1]);
  return {
    x: (n('left') / 100) * glass.width,
    y: (n('top') / 100) * glass.height,
    width: (n('width') / 100) * glass.width,
    height: (n('height') / 100) * glass.height,
  };
}

/** Drags a corner of the box to (x, y) inches on the glass, with the mouse */
export async function dragCorner(page, corner, x, y, glass) {
  const at = await page.evaluate(
    ({ corner, x, y, glass }) => {
      const st = document.querySelector('.dlg-scan .sp-stage');
      const h = document.querySelector(`.dlg-scan .sp-${corner}`);
      if (!st || !h || h.hidden) return null;
      const r = st.getBoundingClientRect();
      const hr = h.getBoundingClientRect();
      return {
        from: { x: hr.x + hr.width / 2, y: hr.y + hr.height / 2 },
        to: { x: r.left + (x / glass.width) * r.width, y: r.top + (y / glass.height) * r.height },
      };
    },
    { corner, x, y, glass }
  );
  if (!at) return false;
  await page.mouse.move(at.from.x, at.from.y);
  await page.mouse.down();
  await page.mouse.move((at.from.x + at.to.x) / 2, (at.from.y + at.to.y) / 2, { steps: 5 });
  await page.mouse.move(at.to.x, at.to.y, { steps: 5 });
  await page.mouse.up();
  return true;
}

/** The preview as shown (after the live adjustments): RGBA, and its dpi
 *  (its width over the glass's) */
export async function previewPixels(page, glass) {
  const r = await page.evaluate(() => {
    const c = document.querySelector('.dlg-scan .sp-image');
    if (!c || c.hidden || !c.width) return null;
    const b = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let s = '';
    for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode(...b.subarray(k, k + 0x8000));
    return { width: c.width, height: c.height, share: parseFloat(c.style.width) / 100, b64: btoa(s) };
  });
  if (!r) return null;
  return {
    width: r.width,
    height: r.height,
    data: new Uint8ClampedArray(Buffer.from(r.b64, 'base64')),
    dpi: r.width / (glass.width * r.share),
  };
}

/** Waits until the live preview shows these settings (scan.ts notes them) */
export const lookShows = (page, want) =>
  until(
    page,
    (want) => {
      const look = document.querySelector('.dlg-scan .sp-glass')?.dataset.look;
      if (!look) return false;
      const l = JSON.parse(look);
      return Object.entries(want).every(([k, v]) => l[k] === v);
    },
    want,
    15000
  );
