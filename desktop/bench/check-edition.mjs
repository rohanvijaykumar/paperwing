/**
 * Checks this release's look for Home and About (src/acro/edition/) in the
 * real desktop app, in the light and the dark theme:
 * - Home wears the edition's background; in dark the tool cards are the app's
 *   own cards (colour and shadow), whatever the edition
 * - About shows the theme's picture (it loads), decorative for screen readers;
 *   the details sit on a glass panel with no border or outline; all the
 *   credits and links are there; Escape still closes it
 * - text contrast is at least 4.5:1 (3:1 for large text), measured on the
 *   rendered pixels behind each line of text: About's whole panel, and on Home
 *   the text on the edition's background (plus the cards in light, which the
 *   edition styles)
 *
 *   node bench/check-edition.mjs [screenshot-dir]
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './harness.mjs';

const [shotDir] = process.argv.slice(2);
if (shotDir) mkdirSync(shotDir, { recursive: true });
const SAMPLES = new URL('../../docs/screenshots/samples/', import.meta.url);

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

const app = await launch();
const { page } = app;
await page.setViewport({ width: 1440, height: 900 });

// A few recent files, so Home shows its list: opened the way Explorer does,
// then their tabs closed
for (const name of [
  'Invoice INV-2048.pdf',
  'Client intake - Northbeam.pdf',
  'Service Agreement - Northbeam.pdf',
]) {
  await app.openFile(fileURLToPath(new URL(name, SAMPLES)));
  await sleep(2500);
}
for (let i = 0; i < 5; i++) {
  await page.evaluate(() =>
    document.querySelector('#tabs .tab:not(.tab-home) .tab-close')?.click()
  );
  await sleep(300);
}
await page.evaluate(() => document.querySelector('#home-btn')?.click());
await sleep(1000);

/**
 * Contrast of each line of text under `root` against what is behind it: the
 * page is captured once with the text hidden, then sampled inside each line's
 * box. Returns the lines below the threshold, and the lowest ratio.
 */
async function contrast(root, skip = '') {
  const runs = await page.evaluate(
    (root, skip) => {
      const out = [];
      const walker = document.createTreeWalker(
        document.querySelector(root),
        NodeFilter.SHOW_TEXT
      );
      while (walker.nextNode()) {
        const t = walker.currentNode;
        const el = t.parentElement;
        if (!t.textContent.trim() || (skip && el.closest(skip))) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden') continue;
        const range = document.createRange();
        range.selectNodeContents(t);
        for (const r of range.getClientRects()) {
          if (r.width < 2 || r.top < 0 || r.bottom > innerHeight) continue;
          const size = parseFloat(cs.fontSize);
          out.push({
            text: t.textContent.trim().slice(0, 30),
            color: cs.color,
            large:
              size >= 24 || (Number(cs.fontWeight) >= 700 && size >= 18.66),
            r: { x: r.left, y: r.top, w: r.width, h: r.height },
          });
        }
      }
      return out;
    },
    root,
    skip
  );
  await page.addStyleTag({
    content: `${root}, ${root} * { color: transparent !important; text-decoration-color: transparent !important; caret-color: transparent !important; }`,
  });
  await sleep(150);
  const bg = (await page.screenshot()).toString('base64');
  await page.evaluate(() =>
    document.querySelector('style:last-of-type')?.remove()
  );
  return page.evaluate(
    async (b64, runs) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const lum = (rgb) =>
        rgb
          .map((v) =>
            (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
          )
          .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const low = [];
      let lowest = 99;
      for (const run of runs) {
        const [r, gg, b, a = 1] = run.color.match(/[\d.]+/g).map(Number);
        let worst = 99;
        for (let i = 0; i < 5; i++)
          for (let j = 0; j < 3; j++) {
            const x = Math.round(run.r.x + (run.r.w * (i + 0.5)) / 5);
            const y = Math.round(run.r.y + (run.r.h * (j + 0.5)) / 3);
            const d = g.getImageData(x, y, 1, 1).data;
            const fg = [
              r * a + d[0] * (1 - a),
              gg * a + d[1] * (1 - a),
              b * a + d[2] * (1 - a),
            ];
            worst = Math.min(worst, ratio(fg, [d[0], d[1], d[2]]));
          }
        lowest = Math.min(lowest, worst);
        if (worst < (run.large ? 3 : 4.5))
          low.push(`"${run.text}" ${worst.toFixed(2)}:1`);
      }
      return { count: runs.length, low, lowest };
    },
    bg,
    runs
  );
}

for (const theme of ['light', 'dark']) {
  await page.evaluate((theme) => {
    localStorage.setItem('paperwing:theme', theme);
    window.dispatchEvent(new CustomEvent('paperwing:themechange'));
  }, theme);
  await sleep(700);
  console.log(`\n${theme}`);

  /* Home */
  const home = await page.evaluate(() => {
    const css = (el, p) => getComputedStyle(el).getPropertyValue(p).trim();
    const root = document.documentElement;
    const view = document.querySelector('#view-home');
    // the app's own card colours, resolved the same way as the cards'
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:absolute;background:var(--surface);box-shadow:var(--card-shadow)';
    document.body.append(probe);
    const own = {
      bg: css(probe, 'background-color'),
      shadow: css(probe, 'box-shadow'),
    };
    probe.remove();
    const cards = [...document.querySelectorAll('.drop-card, .rec-card')];
    return {
      bg: css(view, 'background-color'),
      token: css(root, '--home-bg'),
      sheen: getComputedStyle(view, '::before').backgroundImage.startsWith(
        'conic-gradient'
      ),
      own,
      cards: cards.map((c) => ({
        shadow: css(c, 'box-shadow'),
        r: (({ x, y, width, height }) => ({ x, y, w: width, h: height }))(
          c.getBoundingClientRect()
        ),
      })),
    };
  });
  const toRgb = (hex) =>
    `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  check(
    home.bg === toRgb(home.token),
    `Home has the edition's background (${home.token})`
  );
  check(home.sheen, "Home has the edition's sheen behind the top");
  check(home.cards.length === 5, `Home shows 5 cards (${home.cards.length})`);
  if (theme === 'dark') {
    check(
      home.cards.every((c) => c.shadow === home.own.shadow),
      "dark: the cards have the app's own card shadow"
    );
    // and the app's own colour, on screen (well inside the rounded corners)
    const png = (await page.screenshot()).toString('base64');
    const colours = await page.evaluate(
      async (b64, rects) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return rects.map((r) => {
          const d = g.getImageData(
            Math.round(r.x + 6),
            Math.round(r.y + r.h / 2),
            1,
            1
          ).data;
          return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
        });
      },
      png,
      home.cards.map((c) => c.r)
    );
    check(
      colours.every((c) => c === home.own.bg),
      `dark: the cards are the app's own card colour (${home.own.bg}; seen ${[...new Set(colours)].join(', ')})`
    );
  }
  // in dark the cards are the app's own, so only the edition's background is checked
  const homeText = await contrast(
    '#view-home',
    theme === 'dark' ? '.drop-card, .rec-card' : ''
  );
  check(
    homeText.count > 10 && !homeText.low.length,
    `Home text contrast >= AA on ${homeText.count} lines (lowest ${homeText.lowest.toFixed(2)}:1)${homeText.low.length ? ': ' + homeText.low.join(', ') : ''}`
  );
  if (shotDir)
    await page.screenshot({ path: join(shotDir, `home-${theme}.png`) });

  /* About */
  await page.click('#help-btn');
  await sleep(300);
  await page.evaluate(() =>
    [...document.querySelectorAll('.menu-item')]
      .find((m) => m.textContent.trim().startsWith('About Paperwing'))
      ?.click()
  );
  await page.waitForSelector('.dlg-about', { timeout: 5000 });
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.about-art img')].every(
          (i) =>
            getComputedStyle(i).display === 'none' ||
            (i.complete && i.naturalWidth > 0)
        ),
      { timeout: 10000 }
    )
    .catch(() => {});
  await sleep(500);
  const about = await page.evaluate(() => {
    const dlg = document.querySelector('.dlg-about');
    const art = dlg.querySelector('.about-art');
    const imgs = [...art.querySelectorAll('img')];
    const shown = imgs.filter((i) => getComputedStyle(i).display !== 'none');
    const panel = dlg.querySelector('.dlg-body.about');
    const cs = getComputedStyle(panel);
    const pseudo = (p) => getComputedStyle(panel, p).content;
    return {
      shown: shown.map((i) => ({
        cls: i.className,
        w: i.naturalWidth,
        h: i.naturalHeight,
        onScreen: i.getBoundingClientRect().height,
      })),
      artHidden:
        art.getAttribute('aria-hidden') === 'true' &&
        imgs.every((i) => i.getAttribute('alt') === ''),
      border: ['Top', 'Right', 'Bottom', 'Left']
        .map((s) => cs[`border${s}Width`])
        .join(' '),
      outline: cs.outlineStyle,
      pseudo: [pseudo('::before'), pseudo('::after')],
      glass: cs.backdropFilter,
      alpha: Number(cs.backgroundColor.match(/[\d.]+/g)[3] ?? 1),
      // (macOS runners, for one, have Reduce transparency on)
      reduced: matchMedia('(prefers-reduced-transparency: reduce)').matches,
      // a 1px ring in the shadow would draw a line too
      ring: /\b0px 0px 0px [1-9]/.test(cs.boxShadow),
      title: dlg.getAttribute('aria-label'),
      text: panel.textContent,
      links: [...panel.querySelectorAll('a')].map((a) => a.textContent),
    };
  });
  const want = theme === 'dark' ? 'about-art-dark' : 'about-art-light';
  check(
    about.shown.length === 1 &&
      about.shown[0].cls === want &&
      about.shown[0].w > 0 &&
      about.shown[0].onScreen > 0,
    `About shows the ${theme} picture, loaded (${about.shown.map((s) => `${s.cls} ${s.w}x${s.h}`).join(', ')})`
  );
  check(about.artHidden, 'the picture is decorative (aria-hidden, alt="")');
  check(
    about.border === '0px 0px 0px 0px' &&
      about.outline === 'none' &&
      about.pseudo.every((c) => c === 'none' || c === 'normal') &&
      !about.ring,
    `the glass panel has no border or outline (border ${about.border}, outline ${about.outline})`
  );
  // with Reduce transparency on, the panel is solid instead
  check(
    about.reduced
      ? about.glass === 'none' && about.alpha >= 0.9
      : about.glass.includes('blur'),
    about.reduced
      ? `reduced transparency: the panel is solid (opacity ${about.alpha})`
      : `the panel is frosted glass (${about.glass})`
  );
  check(
    about.title === 'About Paperwing',
    'the dialog is still named "About Paperwing"'
  );
  check(
    /Version \d/.test(about.text) &&
      /Built on BentoPDF/.test(about.text) &&
      /GNU AGPL-3\.0/.test(about.text),
    'version, the BentoPDF credit and the licence are there'
  );
  check(
    [
      'BentoPDF',
      'paperwingapp.com',
      'Source code',
      'Third-party notices',
    ].every((l) => about.links.includes(l)),
    `all the links are there (${about.links.join(', ')})`
  );
  const aboutText = await contrast('.dlg-about .dlg-body');
  check(
    aboutText.count >= 10 && !aboutText.low.length,
    `About text contrast >= AA on ${aboutText.count} lines (lowest ${aboutText.lowest.toFixed(2)}:1)${aboutText.low.length ? ': ' + aboutText.low.join(', ') : ''}`
  );
  if (shotDir) {
    await page.screenshot({ path: join(shotDir, `about-${theme}.png`) });
    const r = await page.evaluate(() => {
      const b = document.querySelector('.dlg-about').getBoundingClientRect();
      return {
        x: b.x - 32,
        y: b.y - 32,
        width: b.width + 64,
        height: b.height + 64,
      };
    });
    await page.screenshot({
      path: join(shotDir, `about-${theme}-crop.png`),
      clip: r,
    });
  }
  await page.keyboard.press('Escape');
  await sleep(300);
  check(!(await page.$('.dlg-about')), 'Escape closes About');
}

await app.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
