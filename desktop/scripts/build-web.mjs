/**
 * Builds the web app (repository root) into ../dist for the desktop shell.
 *
 * Runs Vite directly instead of `npm run build` because upstream's build
 * script uses POSIX-only syntax and also generates SEO/sitemap assets the
 * desktop app doesn't need.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineInfo } from './engine-info.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = resolve(root, 'dist');

if (!existsSync(resolve(root, 'node_modules'))) {
  console.error('Install dependencies in the repository root first: npm ci');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });

// The PDF engines some tools load at run time (PyMuPDF, Ghostscript,
// coherentpdf, Tesseract) ship with the app instead of coming from a CDN, so
// the tools work offline (OCR in languages other than English downloads
// them once). They're copied into dist/engines/ after the build;
// the tools find them through these (src/js/utils/wasm-provider.ts).
const ENGINES = {
  pymupdf: {
    url: '/engines/pymupdf/',
    copy: [
      ['@bentopdf/pymupdf-wasm/dist', 'dist'],
      ['@bentopdf/pymupdf-wasm/assets', 'assets'],
    ],
  },
  gs: { url: '/engines/gs/', copy: [['@bentopdf/gs-wasm/assets', '.']] },
  cpdf: {
    url: '/engines/cpdf/',
    copy: [
      [
        'coherentpdf/dist/coherentpdf.browser.min.js',
        'coherentpdf.browser.min.js',
      ],
    ],
  },
  // OCR: the worker, the LSTM builds of the core (the tools only use
  // LSTM) and English. Other languages download once, on first use.
  tesseract: {
    url: '/engines/tesseract/',
    copy: [
      ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
      ...[
        'tesseract-core-lstm',
        'tesseract-core-simd-lstm',
        'tesseract-core-relaxedsimd-lstm',
      ].flatMap((core) =>
        ['.wasm', '.wasm.js'].map((ext) => [
          `tesseract.js-core/${core}${ext}`,
          `core/${core}${ext}`,
        ])
      ),
      [
        '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
        'lang/eng.traineddata.gz',
      ],
    ],
  },
};

const env = {
  ...process.env,
  VITE_WASM_PYMUPDF_URL: ENGINES.pymupdf.url,
  VITE_WASM_GS_URL: ENGINES.gs.url,
  VITE_WASM_CPDF_URL: ENGINES.cpdf.url,
  VITE_TESSERACT_WORKER_URL: `${ENGINES.tesseract.url}worker.min.js`,
  VITE_TESSERACT_CORE_URL: `${ENGINES.tesseract.url}core`,
  VITE_TESSERACT_LANG_URL: `${ENGINES.tesseract.url}lang`,
  VITE_TESSERACT_BUNDLED_LANGUAGES: 'eng',
  // The font for OCR's text layer on Latin text
  VITE_OCR_BUNDLED_FONTS: 'Noto Sans',
  VITE_OCR_BUNDLED_FONT_BASE_URL: '/engines/ocr-fonts',
  // Timestamp and certificate servers are reached through the desktop
  // app's relay (main.cjs). Absolute, so requests already relayed are
  // recognised as such.
  VITE_CORS_PROXY_URL: 'app://tools/__relay',
  SIMPLE_MODE: 'true',
  VITE_BRAND_NAME: 'Paperwing',
  DISABLE_GITHUB_STARS: 'true',
  NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=6144']
    .filter(Boolean)
    .join(' '),
};

const vite = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
const result = spawnSync(process.execPath, [vite, 'build'], {
  cwd: root,
  env,
  stdio: 'inherit',
});

if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(resolve(dist, 'app.html'))) {
  console.error('Build finished but dist/app.html is missing.');
  process.exit(1);
}
// The build also writes .br/.gz copies of most files for web servers. The
// desktop app serves files itself, so drop the copies (but keep real .gz
// sources such as LibreOffice's, which have no uncompressed sibling).
let removed = 0;
let saved = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (
      /\.(br|gz)$/.test(name) &&
      existsSync(p.replace(/\.(br|gz)$/, ''))
    ) {
      saved += statSync(p).size;
      rmSync(p);
      removed++;
    }
  }
};
walk(dist);
console.log(
  `Removed ${removed} pre-compressed copies (${(saved / 1048576).toFixed(1)} MB)`
);

// The bundled engines
for (const { url, copy } of Object.values(ENGINES)) {
  for (const [from, to] of copy) {
    const src = resolve(root, 'node_modules', from);
    if (!existsSync(src)) {
      console.error(
        `Engine missing: ${from}. Run npm ci in the repository root.`
      );
      process.exit(1);
    }
    cpSync(src, resolve(dist, '.' + url, to), { recursive: true });
  }
}
// OCR's text-layer font for Latin text: the Noto Sans the viewer ships
cpSync(
  resolve(root, 'src/acro/fonts/NotoSans-Regular.ttf'),
  resolve(dist, 'engines/ocr-fonts/NotoSans-Regular.ttf')
);
console.log(
  'Bundled the PyMuPDF, Ghostscript, coherentpdf and Tesseract (English) engines'
);

// Manifest of engine files downloaded on first use (see main.cjs)
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(
  resolve(here, '..', 'engines.json'),
  JSON.stringify(engineInfo(), null, 2)
);

console.log('\nWeb app built into dist/');
