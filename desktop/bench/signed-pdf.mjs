/**
 * Checks a signed PDF on its own, for the signing benches: what each
 * signature field holds (page, rectangle, reason, location, lock), the
 * signature appearance as an image read back with OCR, and independent
 * validators (pyHanko, OpenSSL) when they're installed.
 *
 *   PW_PYTHON: the Python with pyHanko (python); PYTHONPATH is passed on
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream } = require(
  join(root, 'node_modules/pdf-lib')
);
const { PNG } = require(join(root, 'node_modules/pngjs'));

const decodeText = (v) => {
  if (!v) return undefined;
  try {
    return v.decodeText();
  } catch {
    return String(v);
  }
};

/** Each signature field: its page (0-based), rectangle, what /V says, the
 *  lock, and the appearance as a PNG (composited on white) */
export async function signatureFields(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages().map((p) => p.ref.toString());
  const out = [];
  for (const field of doc.getForm().getFields()) {
    const dict = field.acroField.dict;
    if (dict.lookup(PDFName.of('FT'))?.toString() !== '/Sig') continue;
    const v = dict.lookup(PDFName.of('V'));
    const widget = field.acroField.getWidgets()[0];
    const rect = widget.getRectangle();
    const pageRef = widget.dict.get(PDFName.of('P'))?.toString();
    const lock = dict.lookup(PDFName.of('Lock'));
    const refs = v?.lookup?.(PDFName.of('Reference'));
    const transforms = [];
    if (refs instanceof PDFArray)
      for (const r of refs.asArray()) {
        const ref = doc.context.lookup(r);
        const params = ref?.lookup(PDFName.of('TransformParams'));
        transforms.push({
          method: ref?.lookup(PDFName.of('TransformMethod'))?.toString(),
          p: params?.lookup(PDFName.of('P'))?.asNumber?.(),
          action: params?.lookup(PDFName.of('Action'))?.toString(),
        });
      }
    out.push({
      name: field.getName(),
      page: pages.indexOf(pageRef),
      rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
      signed: v instanceof PDFDict,
      type: v?.lookup?.(PDFName.of('Type'))?.toString(),
      subFilter: v?.lookup?.(PDFName.of('SubFilter'))?.toString(),
      reason: decodeText(v?.lookup?.(PDFName.of('Reason'))),
      location: decodeText(v?.lookup?.(PDFName.of('Location'))),
      time: decodeText(v?.lookup?.(PDFName.of('M'))),
      lock:
        lock instanceof PDFDict
          ? {
              action: lock.lookup(PDFName.of('Action'))?.toString(),
              p: lock.lookup(PDFName.of('P'))?.asNumber?.(),
            }
          : null,
      transforms,
      image: appearanceImage(doc, widget.dict),
    });
  }
  return out;
}

/** The image the appearance draws (Paperwing draws a PNG), as a PNG */
function appearanceImage(doc, widget) {
  const ap = widget.lookup(PDFName.of('AP'))?.lookup(PDFName.of('N'));
  const xobjects = ap?.dict
    ?.lookup(PDFName.of('Resources'))
    ?.lookup(PDFName.of('XObject'));
  if (!(xobjects instanceof PDFDict)) return null;
  for (const key of xobjects.keys()) {
    const img = xobjects.lookup(key);
    if (
      !(img instanceof PDFRawStream) ||
      img.dict.lookup(PDFName.of('Subtype'))?.toString() !== '/Image'
    )
      continue;
    const num = (k) => img.dict.lookup(PDFName.of(k))?.asNumber();
    const width = num('Width');
    const height = num('Height');
    const gray =
      img.dict.lookup(PDFName.of('ColorSpace'))?.toString() === '/DeviceGray';
    const pixels = inflateSync(Buffer.from(img.getContents()));
    const smask = img.dict.lookup(PDFName.of('SMask'));
    const alpha =
      smask instanceof PDFRawStream
        ? inflateSync(Buffer.from(smask.getContents()))
        : null;
    const png = new PNG({ width, height });
    const n = gray ? 1 : 3;
    for (let i = 0; i < width * height; i++) {
      const a = alpha ? alpha[i] / 255 : 1;
      for (let c = 0; c < 3; c++) {
        const v = pixels[i * n + (gray ? 0 : c)];
        png.data[i * 4 + c] = Math.round(v * a + 255 * (1 - a));
      }
      png.data[i * 4 + 3] = 255;
    }
    return PNG.sync.write(png);
  }
  return null;
}

/** OCR (tesseract.js with its English data from npm, offline) */
export async function ocr(pngs) {
  const { createWorker } = require(join(root, 'node_modules/tesseract.js'));
  const eng = require(join(root, 'node_modules/@tesseract.js-data/eng'));
  const worker = await createWorker('eng', 1, {
    langPath: eng.langPath,
    gzip: true,
    cacheMethod: 'none',
  });
  const out = [];
  try {
    for (const png of pngs)
      out.push(png ? (await worker.recognize(png)).data.text : '');
  } finally {
    await worker.terminate();
  }
  return out;
}

/** OCR text, for comparing: letters and digits only, lower case */
export const squash = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** pyHanko's view of every signature (desktop/tests/inspect-signed.py), or
 *  null if Python with pyHanko isn't there */
export function pyhanko(file, trust = []) {
  const python = process.env.PW_PYTHON || 'python';
  const args = [join(root, 'desktop/tests/inspect-signed.py'), file];
  for (const t of trust) args.push('--trust', t);
  const res = spawnSync(python, args, { encoding: 'utf8' });
  if (res.status !== 0) {
    if (/No module named|not found|ENOENT/i.test(res.stderr ?? '') || res.error)
      return null;
    throw new Error(`pyHanko failed: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

/** OpenSSL's verdict on each signature's CMS over its bytes, or null if
 *  OpenSSL isn't there */
export function openssl(file) {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const res = spawnSync(
    process.execPath,
    [join(root, 'desktop/tests/openssl-verify.mjs'), file],
    { encoding: 'utf8' }
  );
  const m = /(\d+) signature\(s\) checked with OpenSSL, (\d+) failed/.exec(
    res.stdout
  );
  return m ? { checked: Number(m[1]), failed: Number(m[2]) } : null;
}

/** Where a box drawn as fractions of the (unrotated) page lands, in PDF
 *  user space, for a page with this CropBox */
export function expectedRect(box, crop) {
  const [cx, cy, cw, ch] = crop;
  return [
    cx + box.x * cw,
    cy + ch - (box.y + box.height) * ch,
    cx + (box.x + box.width) * cw,
    cy + ch - box.y * ch,
  ];
}

export async function cropBox(bytes, pageIndex) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const c = doc.getPage(pageIndex).getCropBox();
  return [c.x, c.y, c.width, c.height];
}

export const rectOff = (a, b) =>
  Math.max(...a.map((v, i) => Math.abs(v - b[i])));
