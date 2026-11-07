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
    env: { PAPERWING_SCAN_TEST: '1', ...env },
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
  await click(page, '#create-btn');
  if (!(await until(page, () => document.querySelector('.menu .menu-item')))) return false;
  if (!(await click(page, '.menu .menu-item', 'From scanner'))) return false;
  return waitReady(page);
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
    const has = (label) =>
      [...d.querySelectorAll(`[aria-label="${label}"]`)].some(shown);
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
      has,
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
