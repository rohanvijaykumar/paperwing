/**
 * The controls look and work alike everywhere, in the dark and the light
 * theme (pass/fail), with the real mouse and keyboard. Found in a UI audit of
 * 1.3.0, which the other benches missed:
 *  - dropdowns draw their own list, styled like the app's menus: the system's
 *    list showed the highlighted option in pale blue with grey text in the
 *    dark theme. Hover and keyboard focus colours, contrast, Escape closing
 *    just the list (not the dialog), choosing with the keyboard, a long
 *    choice cut short with "…", the app's font in every dialog
 *  - the scan dialog's links (Add by IP address…) are text links, no grey
 *    pill; their focus ring isn't cut off by the scrolling settings
 *  - the scan dialog's status line is under the pages, not against the
 *    settings' scrolled-off edge
 *  - Use a certificate's bar shows its whole title (it was cut to "Use a
 *    cer…": half the page wide at most), and its tools open titled as its
 *    buttons say
 *  - switching to Import from a scanner app leaves no stale status
 *  - the main menu's Create PDF from scanner lists your own presets; the
 *    command palette lists Scan & OCR and Enhance scanned pages once
 *   node bench/check-controls.mjs
 */
import { fileURLToPath } from 'node:url';
import * as L from './scan-bench-lib.mjs';

const { check, until, sleep, click, press, choose, dialog } = L;
const sample = fileURLToPath(
  new URL(
    '../../docs/screenshots/samples/Invoice INV-2048.pdf',
    import.meta.url
  )
);
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const app = await L.start();
const { page } = app;

async function setTheme(theme) {
  await page.evaluate(async (t) => {
    localStorage.setItem('paperwing:theme', t);
    window.dispatchEvent(new CustomEvent('paperwing:themechange'));
    await window.paperwing?.setTheme(t);
  }, theme);
  await sleep(400);
}

/** WCAG contrast of two computed colours (rgb()/rgba() on an opaque one) */
function contrast(fg, bg) {
  const rgb = (c) =>
    c
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) =>
      (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** The app's colours for this theme */
const tokens = () =>
  page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    const probe = document.createElement('div');
    document.body.append(probe);
    const resolve = (v) => {
      probe.style.color = `var(${v})`;
      return getComputedStyle(probe).color;
    };
    const out = {
      hoverSoft: resolve('--hover-soft'),
      text: resolve('--text'),
      surface: resolve('--surface'),
      accent: resolve('--accent'),
    };
    probe.remove();
    return out;
  });

/** Opens a dropdown with the mouse; returns what its list shows */
async function openList(label, scope = '.dlg-scan') {
  await click(page, `${scope} select[aria-label="${label}"]`);
  return until(
    page,
    ({ label, scope }) => {
      const s = document.querySelector(
        `${scope} select[aria-label="${label}"]`
      );
      return s?.matches(':open') && { open: true };
    },
    { label, scope },
    3000
  );
}

/** Colours of an option in an open list: hovered with the mouse, and with
 *  keyboard focus */
async function optionLooks(label, scope = '.dlg-scan') {
  const at = await page.evaluate(
    ({ label, scope }) => {
      const s = document.querySelector(
        `${scope} select[aria-label="${label}"]`
      );
      const o = [...s.options].find((x) => !x.selected) ?? s.options[0];
      const r = o.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    { label, scope }
  );
  await page.mouse.move(at.x, at.y, { steps: 3 });
  await sleep(200);
  const look = (sel) =>
    page.evaluate((sel) => {
      const o = [...document.querySelectorAll(sel)].find((x) =>
        x.matches(':hover')
      );
      if (!o) return null;
      const st = getComputedStyle(o);
      const picker = getComputedStyle(o.closest('select'), '::picker(select)');
      return {
        bg: st.backgroundColor,
        color: st.color,
        shadow: st.boxShadow,
        pickerBg: picker.backgroundColor,
      };
    }, sel);
  const hover = await look(`${scope} select[aria-label="${label}"] option`);
  await page.keyboard.press('ArrowDown');
  await sleep(150);
  const focus = await page.evaluate(() => {
    const o = document.activeElement;
    if (o?.tagName !== 'OPTION') return null;
    const st = getComputedStyle(o);
    return { bg: st.backgroundColor, color: st.color, shadow: st.boxShadow };
  });
  return { hover, focus };
}

/* The scan dialog, in each theme ----------------------------------------- */
for (const theme of ['dark', 'light']) {
  await setTheme(theme);
  const t = await tokens();
  check(await L.openDialog(page), `${theme}: the scan dialog opens`);
  check(
    await page.evaluate(() =>
      [...document.querySelectorAll('.dlg-scan select')].every(
        (s) => getComputedStyle(s).appearance === 'base-select'
      )
    ),
    `${theme}: its dropdowns draw their own list`
  );
  check(
    !!(await openList('Color mode')),
    `${theme}: a dropdown opens with a click`
  );
  const looks = await optionLooks('Color mode');
  check(
    looks.hover &&
      looks.hover.bg === t.hoverSoft &&
      looks.hover.color === t.text,
    `${theme}: the option under the pointer is highlighted like a menu item (not the system's pale blue)`,
    JSON.stringify(looks.hover)
  );
  check(
    looks.focus &&
      looks.focus.bg === t.hoverSoft &&
      looks.focus.color === t.text &&
      looks.focus.shadow.includes(t.accent),
    `${theme}: the option with keyboard focus too, with the accent ring`,
    JSON.stringify(looks.focus)
  );
  check(
    looks.focus &&
      looks.hover &&
      contrast(looks.focus.color, looks.focus.bg) >= 4.5 &&
      looks.hover.pickerBg === t.surface,
    `${theme}: its text has contrast (at least 4.5:1) on the list's own background`,
    looks.focus && contrast(looks.focus.color, looks.focus.bg).toFixed(1)
  );
  await page.keyboard.press('Escape');
  await sleep(300);
  const afterEscape = await page.evaluate(() => ({
    open: document
      .querySelector('.dlg-scan select[aria-label="Color mode"]')
      ?.matches(':open'),
    dialog: !!document.querySelector('.dlg-scan'),
    focus: document.activeElement?.getAttribute('aria-label'),
  }));
  check(
    afterEscape.open === false &&
      afterEscape.dialog &&
      afterEscape.focus === 'Color mode',
    `${theme}: Escape closes just the list (the dialog stays, focus on the dropdown)`,
    JSON.stringify(afterEscape)
  );
  // Keyboard only: open (Space: Enter doesn't open one on macOS), the next
  // option, Enter
  const { was, last } = await page.evaluate(() => {
    const s = document.querySelector(
      '.dlg-scan select[aria-label="Color mode"]'
    );
    return { was: s.value, last: s.selectedIndex === s.options.length - 1 };
  });
  await page.keyboard.press('Space');
  await sleep(200);
  await page.keyboard.press(last ? 'ArrowUp' : 'ArrowDown');
  await page.keyboard.press('Enter');
  await sleep(300);
  const now = await page.evaluate(() => ({
    value: document.querySelector('.dlg-scan select[aria-label="Color mode"]')
      .value,
    shown: document.querySelector(
      '.dlg-scan select[aria-label="Color mode"] selectedcontent'
    )?.textContent,
    summary: document.querySelector('.dlg-scan .sd-summary').textContent,
  }));
  check(
    now.value !== was && now.summary.startsWith(now.shown ?? '?'),
    `${theme}: chosen with the keyboard (Space, arrow, Enter), shown and used`,
    `${was} → ${JSON.stringify(now)}`
  );

  // Links: no pill on hover; the focus ring inside what's shown
  await page.evaluate(() =>
    document.querySelector('.dlg-scan .sd-settings').scrollTo(0, 0)
  );
  await L.click(page, '.dlg-scan .sd-tabs .pd-seg-btn', 'Pages');
  const link = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.dlg-scan .sd-link')].find((x) =>
      x.textContent.startsWith('Add by IP')
    );
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(link.x - 40, link.y);
  await page.mouse.move(link.x, link.y, { steps: 4 });
  await sleep(250);
  const hovered = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.dlg-scan .sd-link')].find((x) =>
      x.textContent.startsWith('Add by IP')
    );
    const s = getComputedStyle(b);
    return { bg: s.backgroundColor, underline: s.textDecorationLine };
  });
  check(
    hovered.bg === 'rgba(0, 0, 0, 0)' && hovered.underline === 'underline',
    `${theme}: Add by IP address… on hover: underlined text, no grey pill`,
    JSON.stringify(hovered)
  );
  await page.mouse.move(2, 2);
  await page.evaluate(() =>
    document.querySelector('.dlg-scan .sd-scanner .tb-btn').focus()
  );
  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => {
    const b = document.activeElement;
    const s = getComputedStyle(b);
    const p = b.closest('.sd-settings');
    const pr = p.getBoundingClientRect();
    const r = b.getBoundingClientRect();
    const out = parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset);
    return {
      name: b.textContent,
      bg: s.backgroundColor,
      outline: s.outlineStyle,
      // (the scrolling settings cut off whatever is outside their padding box)
      inside:
        r.left - out >= pr.left + p.clientLeft - 0.5 &&
        r.right + out <= pr.left + p.clientLeft + p.clientWidth + 0.5,
    };
  });
  check(
    ring.name.startsWith('Add by IP') &&
      ring.bg === 'rgba(0, 0, 0, 0)' &&
      ring.outline === 'solid' &&
      ring.inside,
    `${theme}: Add by IP address… with keyboard focus: the focus ring, whole, no pill`,
    JSON.stringify(ring)
  );
  check(
    await page.evaluate(
      () => !!document.querySelector('.dlg-scan .sd-right .sd-status')
    ),
    `${theme}: the status line is under the pages`
  );
  await press(page, 'Cancel');
  await until(page, () => !document.querySelector('.dlg-scan'));
}

/* A long choice; your own presets in the main menu ------------------------ */
await L.openDialog(page);
await click(page, '.dlg-scan .sd-link', 'Save as preset');
await until(page, () =>
  document.querySelector('input[aria-label="Preset name"]')
);
await page.keyboard.type('Receipts and invoices for the tax return');
await page.keyboard.press('Enter');
await sleep(400);
const long = await page.evaluate(() => {
  const s = document.querySelector('.dlg-scan select[aria-label="Preset"]');
  const c = s.querySelector('selectedcontent');
  const cs = getComputedStyle(c);
  return {
    shown: c.textContent,
    cut: c.scrollWidth > c.clientWidth && cs.textOverflow === 'ellipsis',
    fits:
      s.getBoundingClientRect().right <=
      s.closest('.pref-row').getBoundingClientRect().right + 0.5,
    oneLine: c.getBoundingClientRect().height < 24,
  };
});
check(
  long.shown === 'Receipts and invoices for the tax return' &&
    long.cut &&
    long.fits &&
    long.oneLine,
  'a long choice is cut short with "…", on one line, inside its row',
  JSON.stringify(long)
);
// (the status said "Saved the preset…"; it stayed after switching to
// Import from a scanner app)
await choose(page, 'Scanner', 'Import from a scanner app…');
await sleep(400);
check(
  (await dialog(page)).status === '',
  'Import from a scanner app: no stale status from before',
  (await dialog(page)).status
);
await press(page, 'Cancel');
await until(page, () => !document.querySelector('.dlg-scan'));
await click(page, '#menu-btn');
await until(page, () => document.querySelector('.menu .menu-item'));
await click(page, '.menu .menu-item', 'Create PDF from scanner');
const presetMenu = await until(page, () => {
  const items = [...document.querySelectorAll('.menu .menu-item')].map((m) =>
    m.textContent.trim()
  );
  return items.includes('Grayscale document') && items;
});
check(
  presetMenu?.includes('Receipts and invoices for the tax return'),
  'Main menu ▸ Create PDF from scanner lists your own presets too',
  JSON.stringify(presetMenu)
);
await page.keyboard.press('Escape');
await sleep(300);

/* Preferences: the dropdowns in the app's font; Escape in a list ---------- */
await click(page, '#menu-btn');
await until(page, () => document.querySelector('.menu .menu-item'));
await click(page, '.menu .menu-item', 'Preferences');
await until(page, () =>
  document.querySelector('.dlg select[aria-label="Appearance"]')
);
const fonts = await page.evaluate(() => ({
  body: getComputedStyle(document.body).fontFamily,
  selects: [...document.querySelectorAll('.dlg select')].map(
    (s) => getComputedStyle(s).fontFamily
  ),
}));
check(
  fonts.selects.length > 0 && fonts.selects.every((f) => f === fonts.body),
  "Preferences' dropdowns use the app's font",
  JSON.stringify(fonts.selects)
);
check(
  !!(await openList('Appearance', '.dlg')),
  'Preferences: the Theme dropdown opens'
);
await page.keyboard.press('Escape');
await sleep(300);
check(
  await page.evaluate(
    () =>
      !!document.querySelector('.dlg select[aria-label="Appearance"]') &&
      !document
        .querySelector('.dlg select[aria-label="Appearance"]')
        .matches(':open')
  ),
  'Escape in its list closes the list, not Preferences'
);
await page.keyboard.press('Escape');
await until(page, () => !document.querySelector('.dlg-backdrop'));

/* The command palette ---------------------------------------------------- */
await page.keyboard.down(MOD);
await page.keyboard.down('Shift');
await page.keyboard.press('KeyP');
await page.keyboard.up('Shift');
await page.keyboard.up(MOD);
await sleep(400);
await page.keyboard.type('scan');
await sleep(500);
const found = await page.evaluate(() =>
  [...document.querySelectorAll('.find-results .menu-item')].map((m) =>
    m.textContent.trim()
  )
);
const twice = found.filter((x, k) => found.indexOf(x) !== k);
check(
  found.includes('Scan & OCR') &&
    found.includes('Enhance scanned pages') &&
    !twice.length,
  'the command palette lists Scan & OCR and Enhance scanned pages once each',
  JSON.stringify(found)
);
await page.keyboard.press('Escape');
await sleep(300);

/* Use a certificate's bar ------------------------------------------------- */
await app.openFile(sample);
await until(
  page,
  () =>
    (window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total ?? 0) >
    0,
  undefined,
  20000
);
await sleep(1500);
check(
  await click(page, '.lp:not([hidden]) .lp-tool', 'Use a certificate'),
  'All tools ▸ Use a certificate'
);
await until(page, () => document.querySelector('#cert-bar'));
await sleep(400);
const bar = await page.evaluate(() => {
  const b = document.querySelector('#cert-bar');
  const t = b.querySelector('.cb-title');
  const r = b.getBoundingClientRect();
  const s = document.querySelector('#doc-stage').getBoundingClientRect();
  return {
    title: t.textContent,
    whole: t.scrollWidth <= t.clientWidth,
    centred: Math.abs(r.left + r.width / 2 - (s.left + s.width / 2)) < 2,
    width: Math.round(r.width),
    stage: Math.round(s.width),
  };
});
check(
  bar.whole && bar.centred,
  'Use a certificate’s bar shows its whole title, centred on the page',
  JSON.stringify(bar)
);
for (const name of ['Validate signatures', 'Add a timestamp']) {
  await click(page, '#cert-bar button', name);
  const title = await until(
    page,
    (name) =>
      [...document.querySelectorAll('.lp-title')].find(
        (x) => x.offsetParent && x.textContent === name
      )?.textContent,
    name,
    20000
  );
  check(
    title === name,
    `the bar’s ${name} opens titled “${name}”`,
    title ??
      (await page.evaluate(() =>
        [...document.querySelectorAll('.lp-title')]
          .filter((x) => x.offsetParent)
          .map((x) => x.textContent)
          .join(' | ')
      ))
  );
}

await app.close();
L.finish();
