/**
 * Read aloud (#60), with the computer's real voices (turned down):
 *  - Main menu and shortcuts (Acrobat's Read Out Loud keys) start it; the
 *    control bar shows the voices on this computer, the speed and colour
 *  - the word being read is highlighted where it is on the page (checked
 *    against PDFium's character boxes, and by the pixels under it: dark
 *    text under the highlight colour, also on a rotated page)
 *  - the highlight colour, speed and voice can be changed while reading,
 *    and are remembered
 *  - pause keeps the word, going on starts from it; stop clears everything
 *  - "this page" stops at the end of the page; "to the end" goes on,
 *    passing over a page without text
 *  - a page without text (scanned) offers to recognize its text
 *  - the bar stays in read mode; another tab stops the reading
 * Shortcuts use ⌘ on macOS, Ctrl elsewhere.
 *   node bench/check-read-aloud.mjs
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
  rgb,
} = require('../../node_modules/pdf-lib');
const { PNG } = require('../../node_modules/pngjs');

const mac = process.platform === 'darwin';
let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};

// 1: two lines; 2: rotated; 3: a picture, no text; 4: text
const dir = mkdtempSync(join(process.env.BENCH_TMP || tmpdir(), 'pw-ra-'));
const file = join(dir, 'read.pdf');
const FIRST = 'Paperwing reads this sentence aloud.';
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  p1.drawText(FIRST, { x: 72, y: 700, size: 24, font });
  p1.drawText('A second line, with more words.', {
    x: 72,
    y: 660,
    size: 18,
    font,
  });
  // (enough to still be reading while the voice and speed change)
  [
    'More sentences follow, so the page takes a while to read.',
    'Each one is spoken in turn, a sentence at a time.',
    'The voice and the speed can change while it reads.',
    'A highlight marks each word as the voice gets to it.',
    'And this is the last sentence on the first page.',
  ].forEach((line, i) =>
    p1.drawText(line, { x: 72, y: 620 - i * 24, size: 14, font })
  );
  const p2 = doc.addPage([612, 792]);
  p2.drawText('Turned pages are read too.', { x: 72, y: 700, size: 24, font });
  p2.drawText('Their words are highlighted where they are.', {
    x: 72,
    y: 660,
    size: 18,
    font,
  });
  p2.setRotation(degrees(90));
  const p3 = doc.addPage([612, 792]);
  p3.drawRectangle({
    x: 72,
    y: 400,
    width: 400,
    height: 300,
    color: rgb(0.4, 0.5, 0.7),
  });
  const p4 = doc.addPage([612, 792]);
  p4.drawText('The last page.', { x: 72, y: 700, size: 24, font });
  writeFileSync(file, await doc.save());
}

const app = await launch({ args: [file] });
const { page } = app;
await sleep(4000);
const cdp = await page.target().createCDPSession();
const MOD = mac ? 4 : 2;
const SHIFT = 8;
const press = async (key, code, modifiers = 0) => {
  for (const type of ['rawKeyDown', 'keyUp'])
    await cdp.send('Input.dispatchKeyEvent', { type, key, code, modifiers });
};
const shortcut = (letter) =>
  press(letter.toUpperCase(), `Key${letter.toUpperCase()}`, MOD | SHIFT);
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return v;
};
const state = () =>
  page.evaluate(() => {
    const ra = window.__acro.readAloud;
    const root = window.__acro.viewer.shadow();
    const words = [...(root?.querySelectorAll('.pw-ra-word') ?? [])];
    const r = words[0]?.getBoundingClientRect();
    const bar = document.querySelector('.ra-bar');
    return {
      active: ra.active,
      paused: ra.paused,
      speaking: speechSynthesis.speaking,
      status: document.querySelector('.ra-status')?.textContent ?? null,
      bar: !!bar,
      word: r
        ? {
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
            color: getComputedStyle(words[0]).backgroundColor,
          }
        : null,
      at: ra.session?.pos ?? null,
      page: ra.session ? ra.session.page + 1 : null,
    };
  });
// Quiet, and quick
await page.evaluate(() => {
  window.__acro.readAloud.volume = 0;
});
const voices = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const list = () =>
        speechSynthesis.getVoices().filter((v) => v.localService).length;
      if (list()) return resolve(list());
      speechSynthesis.onvoiceschanged = () => resolve(list());
      setTimeout(() => resolve(list()), 4000);
    })
);
console.log(`voices on this computer: ${voices}`);

// The main menu offers it
await page.click('#menu-btn');
await sleep(300);
const menu = await page.evaluate(() =>
  [...document.querySelectorAll('.menu .menu-item')].map((b) =>
    b.textContent.trim()
  )
);
check(
  menu.some((t) => t.startsWith('Read this page aloud')) &&
    menu.some((t) => t.startsWith('Read aloud to the end')),
  'Main menu: Read this page aloud, Read aloud to the end',
  JSON.stringify(menu.filter((t) => /read/i.test(t)))
);
await press('Escape', 'Escape');
await sleep(200);

if (!voices) {
  // No voices (some servers): it says so, and nothing starts
  await shortcut('v');
  await sleep(1500);
  const toast = await page.evaluate(
    () => document.querySelector('#toasts')?.textContent ?? ''
  );
  check(
    /No voices are installed/.test(toast) && !(await state()).active,
    'no voices: says so, nothing starts',
    toast
  );
  console.log('skip the rest: no voices on this computer');
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(
    failures ? `\n${failures} check(s) failed` : '\nall checks passed'
  );
  process.exit(failures ? 1 : 0);
}

// Can this computer speak at all? (A server without a sound device may
// list voices that never start.) If not, the app must say so.
const speaks = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance('Testing.');
      u.volume = 0;
      const timer = setTimeout(() => resolve('never started'), 12000);
      u.onstart = () => {
        clearTimeout(timer);
        speechSynthesis.cancel();
        resolve('ok');
      };
      u.onerror = (e) => {
        clearTimeout(timer);
        resolve(`error: ${e.error}`);
      };
      speechSynthesis.speak(u);
    })
);
console.log(`a voice speaks here: ${speaks}`);
if (speaks !== 'ok') {
  await shortcut('v');
  const said = await until(async () => {
    const t = await page.evaluate(
      () => document.querySelector('#toasts')?.textContent ?? ''
    );
    return /voice didn.t start|voice stopped reading/.test(t) && t;
  }, 20000);
  check(
    !!said && !(await state()).active,
    'a voice that can’t speak here: the app says so and stops',
    String(said)
  );
  console.log('skip the rest: voices on this computer can’t speak');
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(
    failures ? `\n${failures} check(s) failed` : '\nall checks passed'
  );
  process.exit(failures ? 1 : 0);
}

// Where PDFium says a word is, on the screen
const expected = (pageIndex, from, to) =>
  page.evaluate(
    async (pageIndex, from, to) => {
      const v = window.__acro.viewer;
      const t = await v.pageText(v.current, pageIndex);
      const size = v.pageSizes(v.current)[pageIndex];
      const boxes = t.boxes.slice(from, to).filter((b) => b.w > 0);
      const x0 = Math.min(...boxes.map((b) => b.x));
      const y0 = Math.min(...boxes.map((b) => b.y));
      const x1 = Math.max(...boxes.map((b) => b.x + b.w));
      const y1 = Math.max(...boxes.map((b) => b.y + b.h));
      // The highlight's page box (the one holding it)
      const layer = v.shadow().querySelector('.pw-ra-layer');
      const r = layer.parentElement.getBoundingClientRect();
      const k = r.width / size.width;
      return {
        x: r.x + x0 * k,
        y: r.y + y0 * k,
        w: (x1 - x0) * k,
        h: (y1 - y0) * k,
      };
    },
    pageIndex,
    from,
    to
  );
const near = (a, b, d = 4) =>
  Math.abs(a.x - b.x) <= d &&
  Math.abs(a.y - b.y) <= d &&
  Math.abs(a.x + a.w - (b.x + b.w)) <= d &&
  Math.abs(a.y + a.h - (b.y + b.h)) <= d;
/** Pixels under the highlight: some dark (the text), most tinted (paused
 *  meanwhile, so the highlight stays on one word) */
const underHighlight = async () => {
  await page.evaluate(() => window.__acro.readAloud.pause());
  // Until the highlight stays put (the page may still be moving there)
  let w = null;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const now = (await state()).word;
    if (now && w && JSON.stringify(now) === JSON.stringify(w)) break;
    w = now;
  }
  const inView = await page.evaluate(
    (w) => !!w && w.y >= 0 && w.y + w.h <= innerHeight && w.x >= 0,
    w
  );
  if (!inView) console.log(`  (highlight not on screen: ${JSON.stringify(w)})`);
  const result = w && inView ? await pixelsAt(w) : null;
  await page.evaluate(() => window.__acro.readAloud.resume());
  return result;
};
const pixelsAt = async (w) => {
  const png = PNG.sync.read(
    await page.screenshot({
      clip: { x: w.x, y: w.y, width: w.w, height: w.h },
      type: 'png',
    })
  );
  let dark = 0;
  let tinted = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const [r, g, b] = png.data.subarray(i * 4, i * 4 + 3);
    if (r + g + b < 200) dark++;
    else if (Math.max(r, g, b) - Math.min(r, g, b) > 60) tinted++;
  }
  return { dark: dark / n, tinted: tinted / n };
};

// Read this page (⇧⌃V)
await shortcut('v');
const started = await until(async () => {
  const s = await state();
  return s.active && s.word && s;
});
check(
  !!started?.bar && /Reading page 1 of 4/.test(started.status ?? ''),
  '⇧+Ctrl+V reads this page: the control bar shows',
  JSON.stringify(started?.status)
);
const bar = await page.evaluate(() => ({
  voices: document.querySelectorAll('.ra-voice option').length,
  speeds: [...document.querySelectorAll('.ra-speed option')].map(
    (o) => o.textContent
  ),
  buttons: [...document.querySelectorAll('.ra-bar button')].map(
    (b) => b.getAttribute('aria-label') ?? ''
  ),
}));
check(
  bar.voices === voices &&
    bar.speeds.includes('1×') &&
    bar.buttons.includes('Pause reading') &&
    bar.buttons.includes('Stop reading') &&
    bar.buttons.includes('Highlight colour'),
  'the bar: every voice on this computer, speeds, pause, stop, colour',
  JSON.stringify(bar)
);
const firstWord = await expected(0, 0, 'Paperwing'.length);
check(
  near(started.word, firstWord),
  'the first word is highlighted where it is on the page',
  `${JSON.stringify(started.word)} vs ${JSON.stringify(firstWord)}`
);
const pixels = await underHighlight();
check(
  pixels && pixels.dark > 0.08 && pixels.tinted > 0.3,
  'under the highlight: the word, in the highlight colour',
  JSON.stringify(pixels)
);

// The highlight moves on, word by word
const seen = new Set();
await until(async () => {
  const s = await state();
  if (s.at != null) seen.add(s.at);
  return seen.size >= 4;
}, 15000);
check(
  seen.size >= 4,
  'the highlight moves from word to word',
  [...seen].join(',')
);

// Colour: Green, from the bar's menu
await page.click('.ra-color');
await sleep(300);
await page.evaluate(() =>
  [...document.querySelectorAll('.menu .menu-item')]
    .find((b) => b.textContent.trim() === 'Green')
    ?.click()
);
await sleep(400);
const green = await until(async () => {
  const s = await state();
  return s.word?.color === 'rgb(74, 222, 128)' && s;
}, 4000);
check(
  !!green,
  'highlight colour: Green from the bar',
  JSON.stringify((await state()).word?.color)
);

// Pause (⇧⌃C): the voice stops, the word stays
await shortcut('c');
await sleep(500);
const paused = await state();
check(
  paused.paused &&
    !paused.speaking &&
    !!paused.word &&
    /Paused/.test(paused.status ?? ''),
  '⇧+Ctrl+C pauses: the voice stops, the word stays highlighted',
  JSON.stringify(paused)
);
await sleep(800);
check(
  (await state()).at === paused.at,
  'paused: the reading stays on that word'
);
// Going on: from that word
await shortcut('c');
const resumed = await until(async () => {
  const s = await state();
  return s.speaking && !s.paused && s;
}, 5000);
check(
  !!resumed && resumed.at === paused.at,
  'going on starts again from that word',
  `${paused.at} → ${resumed?.at}`
);

// Speed 2×, remembered; reading carries on
await page.select('.ra-speed', '2');
await sleep(300);
const moving = await until(async () => {
  const s = await state();
  return s.speaking && s.at !== resumed?.at && s;
}, 6000);
const prefs = () =>
  page.evaluate(
    () => JSON.parse(localStorage.getItem('paperwing:prefs') || '{}').readAloud
  );
check(
  !!moving && (await prefs())?.rate === 2,
  'speed 2×: remembered, and the reading goes on',
  JSON.stringify(await prefs())
);
// Another voice (if there is one)
if (voices > 1) {
  const other = await page.evaluate(() => {
    const s = document.querySelector('.ra-voice');
    return [...s.options].find((o) => o.value !== s.value)?.value;
  });
  await page.select('.ra-voice', other);
  await sleep(1500);
  const s = await state();
  check(
    (await prefs())?.voice === other && s.active,
    'another voice: remembered, and the reading goes on',
    other
  );
}

// Stop (⇧⌃E): everything goes
await shortcut('e');
await sleep(400);
const stopped = await state();
check(
  !stopped.active && !stopped.bar && !stopped.word && !stopped.speaking,
  '⇧+Ctrl+E stops: no voice, no bar, no highlight',
  JSON.stringify(stopped)
);

// "This page" stops at its end (not page 2)
let pages = new Set();
await shortcut('v');
await until(async () => {
  const s = await state();
  if (s.page) pages.add(s.page);
  return s.active;
}, 5000);
const endedPage = await until(async () => {
  const s = await state();
  if (s.page) pages.add(s.page);
  return !s.active;
}, 30000);
check(
  !!endedPage && [...pages].join() === '1' && !(await state()).bar,
  'read this page: it stops at the end of the page',
  `pages read: ${[...pages].join(',')}`
);

// To the end, from the rotated page 2: page 3 has no text, page 4 is read
await page.evaluate(() =>
  window.__acro.viewer.goToPage(window.__acro.viewer.current, 2)
);
await sleep(1200);
pages = new Set();
await shortcut('b');
const onRotated = await until(async () => {
  const s = await state();
  return s.page === 2 && s.word && s;
}, 8000);
const rotatedPixels = await underHighlight();
check(
  !!onRotated && rotatedPixels?.dark > 0.08 && rotatedPixels?.tinted > 0.3,
  'a turned page: the highlight is on its words',
  JSON.stringify(rotatedPixels)
);
await until(async () => {
  const s = await state();
  if (s.page) pages.add(s.page);
  return !s.active;
}, 40000);
check(
  [...pages].join() === '2,4',
  'read to the end: on past the page without text, to the last page',
  `pages read: ${[...pages].join(',')}`
);

// A page with no text: offers to recognize it
await page.evaluate(() =>
  window.__acro.viewer.goToPage(window.__acro.viewer.current, 3)
);
await sleep(1200);
await shortcut('v');
await sleep(1500);
const hint = await page.evaluate(() => ({
  text: document.querySelector('#toasts')?.textContent ?? '',
  button: [...document.querySelectorAll('#toasts button')].map(
    (b) => b.textContent
  ),
}));
check(
  /no text to read/.test(hint.text) &&
    hint.button.includes('Recognize text') &&
    !(await state()).active,
  'a page without text (scanned): offers to recognize its text',
  JSON.stringify(hint)
);

// Read mode keeps the bar
await page.evaluate(() =>
  window.__acro.viewer.goToPage(window.__acro.viewer.current, 1)
);
await sleep(1000);
if (mac) await press('H', 'KeyH', MOD | SHIFT);
else await press('h', 'KeyH', MOD);
await sleep(600);
await shortcut('b');
await until(async () => (await state()).word, 6000);
const inReadMode = await page.evaluate(() => {
  const bar = document.querySelector('.ra-bar');
  const r = bar?.getBoundingClientRect();
  return {
    reading: document.body.classList.contains('is-reading'),
    shown: !!r && r.height > 0 && r.bottom <= innerHeight,
  };
});
check(
  inReadMode.reading && inReadMode.shown,
  'read mode: the bar stays',
  JSON.stringify(inReadMode)
);
await press('Escape', 'Escape');
await sleep(500);

// Another tab (Home) stops it
await page.click('#home-btn');
await sleep(600);
check(!(await state()).active, 'going to another tab stops the reading');

// The colour is remembered
check(
  (await prefs())?.color === '#4ade80',
  'the highlight colour is remembered',
  JSON.stringify(await prefs())
);

await app.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
