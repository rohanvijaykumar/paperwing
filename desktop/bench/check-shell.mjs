/**
 * The workspace's own modes and notices (1.2.4), with real input:
 *  - full screen: one page at a time on black (portrait, landscape and
 *    rotated pages), turned by keys, the wheel and a click; Esc leaves at
 *    the zoom it had, on the page it got to; read mode stays its own mode
 *  - What's new: offered once after an update (also from 1.2.3, which
 *    didn't note its version), never on a first launch or going back
 *  - shortcuts follow the keyboard layout (#29): the key marked H is H on
 *    Colemak, a Russian layout uses the US places, and characters typed
 *    with AltGr or an input method never trigger shortcuts
 * Shortcuts use ⌘ on macOS, Ctrl elsewhere.
 *   node bench/check-shell.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep } from './harness.mjs';

const require = createRequire(import.meta.url);
const {
  PDFDocument,
  StandardFonts,
  degrees,
} = require('../../node_modules/pdf-lib');

const mac = process.platform === 'darwin';
let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};

// Six pages: portrait, landscape, rotated, portrait...
const dir = mkdtempSync(join(process.env.BENCH_TMP || tmpdir(), 'pw-shell-'));
const file = join(dir, 'mixed.pdf');
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [
    [612, 792, 0],
    [792, 612, 0],
    [612, 792, 90],
    [612, 792, 0],
    [612, 792, 0],
    [612, 792, 0],
  ];
  for (const [i, [w, h, rotation]] of pages.entries()) {
    const p = doc.addPage([w, h]);
    p.drawText(`Page ${i + 1}`, { x: 60, y: h - 100, size: 48, font });
    if (rotation) p.setRotation(degrees(rotation));
  }
  writeFileSync(file, await doc.save());
}

const app = await launch({ args: [file] });
const { page } = app;
await sleep(4000);
const cdp = await page.target().createCDPSession();
// CDP modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8
const MOD = mac ? 4 : 2;
const press = async (key, code, modifiers = 0) => {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    modifiers,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers,
  });
};
const state = () =>
  page.evaluate(() => {
    const v = window.__acro.viewer;
    const f = document.querySelector('.present-frame')?.getBoundingClientRect();
    return {
      page: v.pageInfo(v.current)?.current,
      zoom: Math.round((v.zoom(v.current) ?? 0) * 100),
      reading: document.body.classList.contains('is-reading'),
      frame: f && { w: Math.round(f.width), h: Math.round(f.height) },
      toasts: [...document.querySelectorAll('.toast')]
        .map((t) => t.textContent)
        .join(' | '),
    };
  });
const show = (s) =>
  `page ${s.page}, zoom ${s.zoom}%, frame ${s.frame ? `${s.frame.w}×${s.frame.h}` : 'none'}`;

/* Full screen ------------------------------------------------------------ */

// (once the document is open and zoomed)
let before = await state();
for (let i = 0; i < 50 && !before.zoom; i++) {
  await sleep(200);
  before = await state();
}
await page.mouse.click(700, 400);
await press('l', 'KeyL', MOD);
await sleep(mac ? 3000 : 1500);
let s = await state();
check(
  s.reading && s.frame && s.frame.h > s.frame.w,
  'full screen shows the page framed on black',
  show(s)
);
check(
  /Full screen — press Esc or (Ctrl\+L|⌘L) to exit/.test(s.toasts),
  'and says how to leave it',
  s.toasts
);
await press('ArrowRight', 'ArrowRight');
await sleep(900);
s = await state();
check(
  s.page === 2 && s.frame && s.frame.w > s.frame.h,
  'the right arrow turns to the next page (a landscape page, framed wide)',
  show(s)
);
await page.mouse.move(700, 400);
await page.mouse.wheel({ deltaY: 120 });
await sleep(900);
s = await state();
check(s.page === 3, 'the wheel turns one page (a rotated page)', show(s));
check(
  s.frame && s.frame.w > s.frame.h,
  'the rotated page is framed as it shows (wide)',
  show(s)
);
await page.mouse.click(720, 450);
await sleep(900);
s = await state();
check(s.page === 4, 'a click turns the page', show(s));
await press('ArrowLeft', 'ArrowLeft');
await sleep(900);
check((await state()).page === 3, 'the left arrow turns back');
await press('End', 'End');
await sleep(900);
check((await state()).page === 6, 'End goes to the last page');
await press('Home', 'Home');
await sleep(900);
check((await state()).page === 1, 'Home goes to the first page');
await press('PageDown', 'PageDown');
await press('PageDown', 'PageDown');
await sleep(1200);
s = await state();
check(s.page === 3, 'Page Down twice, quickly, turns two pages', show(s));
await press('Escape', 'Escape');
await sleep(mac ? 2500 : 1200);
s = await state();
check(
  !s.reading && !s.frame && s.zoom === before.zoom && s.page === 3,
  'Esc leaves at the zoom it had, on the page it got to',
  `${show(s)} (zoom before: ${before.zoom}%)`
);

// Read mode: its own mode, its own message
await press('h', 'KeyH', mac ? MOD | 8 : MOD);
await sleep(800);
s = await state();
check(
  s.reading && !s.frame && /Read mode — press Esc/.test(s.toasts),
  'read mode hides the toolbars, with its own message',
  s.toasts
);
await press('Escape', 'Escape');
await sleep(500);

/* Shortcuts and keyboard layouts (#29) --------------------------------- */

const reading = async () => (await state()).reading;
const readMods = mac ? MOD | 8 : MOD;
await press('h', 'KeyJ', readMods); // Colemak: H sits where QWERTY has J
await sleep(500);
check(await reading(), 'Colemak: the key marked H is H (read mode)');
await press('Escape', 'Escape');
await sleep(400);
await press('j', 'KeyH', readMods); // and QWERTY's H place types J
await sleep(500);
check(!(await reading()), "Colemak: the key in QWERTY's H place isn't H");
await press('р', 'KeyH', readMods); // Russian: the key in H's place
await sleep(500);
check(await reading(), "Russian: the key in H's US place is H");
await press('Escape', 'Escape');
await sleep(400);
if (!mac) {
  await press('ħ', 'KeyH', 2 | 1); // AltGr = Ctrl+Alt
  await sleep(500);
  check(!(await reading()), 'a character typed with AltGr is no shortcut');
}
await press('Process', 'KeyH', readMods); // an input method composing
await sleep(500);
check(!(await reading()), 'a key an input method is composing is no shortcut');

/* What's new ----------------------------------------------------------- */

const toasts = async () => (await state()).toasts;
const seen = () =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('paperwing:prefs') || '{}').seenVersion
  );
const version = await seen();
check(
  !/was updated/.test(await toasts()) && !!version,
  'a first launch notes the version and offers nothing',
  String(version)
);
const relaunch = async (prefs) => {
  await page.evaluate(
    (p) => localStorage.setItem('paperwing:prefs', JSON.stringify(p)),
    prefs
  );
  await page.reload();
  await sleep(2500);
  return toasts();
};
check(
  /was updated to/.test(await relaunch({ restoreSession: false })),
  "updated from 1.2.3 (which didn't note its version): What's new is offered"
);
check(
  !/was updated/.test(
    await relaunch({ restoreSession: false, seenVersion: version })
  ),
  'the same version again: nothing'
);
check(
  /was updated to/.test(
    await relaunch({ restoreSession: false, seenVersion: '1.2.3' })
  ),
  "updated from a version that noted itself: What's new is offered"
);
await page.evaluate(() =>
  [...document.querySelectorAll('.toast button')]
    .find((b) => b.textContent === "What's new")
    ?.click()
);
await sleep(800);
const dialog = await page.evaluate(() => {
  const d = document.querySelector('.dlg-whats-new');
  return (
    d && {
      title: d.querySelector('h2').textContent,
      sections: [...d.querySelectorAll('h3')].map((x) => x.textContent),
      items: d.querySelectorAll('li').length,
    }
  );
});
check(
  dialog?.title === `What's new in Paperwing ${version}` &&
    dialog.sections.length >= 2 &&
    dialog.items > 3,
  "What's new shows this version's notes",
  JSON.stringify(dialog)
);
await press('Escape', 'Escape');
await sleep(300);
check(
  !/was updated/.test(
    await relaunch({ restoreSession: false, seenVersion: '99.0.0' })
  ),
  'going back to an older version: nothing'
);
check((await seen()) === version, 'and the version is noted again');

await app.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
