/**
 * Builds the platform app icons from the artwork in build/icon.svg:
 *
 *   build/icon.ico       Windows. Tile icons there fill the whole canvas
 *                        (taskbar, Start, Explorer), so the tile is nearly
 *                        full-bleed; each size is drawn on its own so the
 *                        small ones stay sharp.
 *   build/icon-mac.png   macOS (electron-builder makes the .icns). Apple's
 *                        grid: an 824 px tile on the 1024 px canvas, with
 *                        the standard soft shadow.
 * build/icon.png (Linux, development) is the artwork as drawn, unchanged.
 *
 *   node scripts/gen-icons.mjs        (CHROME_PATH if Chrome isn't found)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const build = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const svg = readFileSync(join(build, 'icon.svg'), 'utf8');

// The tile in icon.svg, and the mark drawn on it
const tile = svg.match(
  /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="(\d+)"[^>]*fill="([^"]+)"/
);
if (!tile) throw new Error('icon.svg: tile <rect> not found');
const [, tx, , tw, , rx, fill] = tile.map((v, i) => (i && i < 6 ? +v : v));
const mark = [...svg.matchAll(/<polygon[^>]*\/>/g)].map((m) => m[0]).join('');

/** The icon on a size×size canvas, the tile inset by `inset` px */
function iconSvg(size, { inset, radius = rx / tw, shadow = false }) {
  const t = size - 2 * inset;
  const k = t / tw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${
      shadow
        ? `<defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="${size * 0.012}" stdDeviation="${size * 0.014}" flood-color="#000" flood-opacity="0.28"/>
          </filter></defs>`
        : ''
    }
    <rect x="${inset}" y="${inset}" width="${t}" height="${t}" rx="${t * radius}"
      fill="${fill}"${shadow ? ' filter="url(#s)"' : ''}/>
    <g transform="translate(${inset} ${inset}) scale(${k}) translate(${-tx} ${-tx})">${mark}</g>
  </svg>`;
}

const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!chrome) throw new Error('Chrome not found: set CHROME_PATH');
const browser = await puppeteer.launch({ executablePath: chrome });
const page = await browser.newPage();

async function png(markup, size) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}</style>${markup}`
  );
  return Buffer.from(await page.screenshot({ omitBackground: true }));
}

// Windows: one PNG per size, packed into an .ico
const WIN_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const images = [];
for (const size of WIN_SIZES) {
  // A hair of margin from 32 px up; none below, where it would blur
  const inset = size >= 32 ? Math.round(size / 64) : 0;
  images.push({
    size,
    data: await png(iconSvg(size, { inset, radius: 0.2 }), size),
  });
}
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ size, data }, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(size >= 256 ? 0 : size, e);
  header.writeUInt8(size >= 256 ? 0 : size, e + 1);
  header.writeUInt16LE(1, e + 4); // colour planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(data.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
writeFileSync(
  join(build, 'icon.ico'),
  Buffer.concat([header, ...images.map((i) => i.data)])
);

// macOS: Apple's icon grid
writeFileSync(
  join(build, 'icon-mac.png'),
  await png(iconSvg(1024, { inset: 100, radius: 0.225, shadow: true }), 1024)
);

await browser.close();
console.log('icon.ico (' + WIN_SIZES.join(', ') + ' px) and icon-mac.png');
