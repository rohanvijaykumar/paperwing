/**
 * Use a certificate as a user would, checking every result, not just that
 * something happened (pass/fail). Each signed file is read back on its own:
 * the field's page and rectangle against the box that was drawn, the
 * reason, location and lock in the signature, the appearance read with OCR
 * (each option of Create appearance), pyHanko and OpenSSL on every
 * signature (when installed), and Validate signatures' verdict in the app.
 *
 *  appearances  four signatures with four appearances and IDs, the last
 *               locking the document (refused afterwards), validated
 *  changes      a byte changed, text added later, a comment added and saved
 *               (Paperwing asks first), signing a changed signed document
 *  ids          ID files: wrong password, no private key, certificate and
 *               key in separate files, a login-only ID; Create a new
 *               Digital ID (RSA and ECDSA) read back by OpenSSL
 *  pages        rotated pages, page 3 of 4, a scanned PDF, a form, a tiny
 *               and a page-sized box, a click
 *  ocsp         a CA-issued ID checked with an OCSP responder on this
 *               computer: good (its reply in the DSS) and revoked (refused)
 *  tsa          (PW_QA_TSA=1, needs the internet) a timestamp from the first
 *               timestamp server, and Add a timestamp
 *
 *   PW_TEST_CERTS=certs.json [PW_QA_ONLY=appearances,ids] node bench/check-cert-results.mjs
 *
 * PW_SCREENS: screenshots; PW_PYTHON: Python with pyHanko.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './harness.mjs';
import {
  cropBox,
  expectedRect,
  ocr,
  openssl,
  pyhanko,
  rectOff,
  signatureFields,
  squash,
} from './signed-pdf.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { PDFDocument, StandardFonts, degrees, PDFName, PDFRef } = require(
  join(root, 'node_modules/pdf-lib')
);
const { PNG } = require(join(root, 'node_modules/pngjs'));

const TMP = process.env.BENCH_TMP || 'D:/tmp/paperwing-bench';
const OUT = join(TMP, 'cert-results');
const DOCS = join(OUT, 'docs');
const SCREENS = process.env.PW_SCREENS;
const ONLY = (process.env.PW_QA_ONLY || 'appearances,changes,ids,pages,ocsp')
  .split(',')
  .concat(process.env.PW_QA_TSA === '1' ? ['tsa'] : []);
const spec = JSON.parse(
  readFileSync(process.env.PW_TEST_CERTS, 'utf8').replace(/^\uFEFF/, '')
);
const usable = spec.filter((c) => c.expect === 'usable');
const byLabel = (l) => spec.find((c) => c.label === l);
const id = (...labels) =>
  labels.map(byLabel).find(Boolean) ?? usable[0] ?? null;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(DOCS, { recursive: true });
if (SCREENS) mkdirSync(SCREENS, { recursive: true });

let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  return ok;
};
const note = (what) => console.log(`     ${what}`);
const until = async (fn, timeout = 20000) => {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) {
    v = await fn().catch(() => null);
    if (v) return v;
    await sleep(200);
  }
  return v;
};

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

async function agreement(file, pages = 2) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) {
    const p = doc.addPage([612, 792]);
    p.drawText('Service Agreement', { x: 72, y: 720, size: 22, font });
    p.drawText('The supplier delivers; the customer pays within 30 days.', {
      x: 72,
      y: 680,
      size: 11,
      font,
    });
    p.drawText('Signatures', { x: 72, y: 560, size: 14, font });
    p.drawText(`Page ${n} of ${pages}`, { x: 280, y: 40, size: 9, font });
  }
  writeFileSync(file, await doc.save());
  return file;
}

async function rotated(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [i, rot] of [0, 90, 180, 270].entries()) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Page ${i + 1}: turned ${rot}`, {
      x: 60,
      y: 720,
      size: 24,
      font,
    });
    p.setRotation(degrees(rot));
  }
  writeFileSync(file, await doc.save());
  return file;
}

function logo(file) {
  const png = new PNG({ width: 200, height: 200 });
  for (let y = 0; y < 200; y++)
    for (let x = 0; x < 200; x++) {
      const i = (y * 200 + x) * 4;
      const ring = Math.abs(Math.hypot(x - 100, y - 100) - 60) < 14;
      png.data.set(ring ? [20, 80, 220, 255] : [0, 0, 0, 0], i);
    }
  writeFileSync(file, PNG.sync.write(png));
  return file;
}

/** An incremental update with new versions of objects (another app editing
 *  a signed document), with a proper xref section */
async function appendUpdate(pdf, objects) {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const text = pdf.toString('latin1');
  const prev = Number([...text.matchAll(/startxref\s+(\d+)/g)].pop()[1]);
  let out = '\n';
  const offsets = [];
  for (const { ref, body } of objects) {
    offsets.push([ref.objectNumber, pdf.length + out.length]);
    out += `${ref.objectNumber} 0 obj\n${body}\nendobj\n`;
  }
  const xrefAt = pdf.length + out.length;
  out += 'xref\n0 1\n0000000000 65535 f \n';
  for (const [num, at] of offsets)
    out += `${num} 1\n${String(at).padStart(10, '0')} 00000 n \n`;
  const size = Math.max(
    doc.context.largestObjectNumber + 1,
    ...objects.map((o) => o.ref.objectNumber + 1)
  );
  out += `trailer\n<< /Size ${size} /Root ${doc.context.trailerInfo.Root} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.concat([pdf, Buffer.from(out, 'latin1')]);
}

/* ------------------------------------------------------------------ */
/* The app, as a user                                                  */
/* ------------------------------------------------------------------ */

async function open(files, env = {}) {
  const app = await launch({
    args: files,
    env: { PAPERWING_TEST_SAVE_DIR: OUT, ...env },
  });
  const { page } = app;
  page.on('pageerror', (e) => note(`[page] ${String(e).slice(0, 300)}`));
  const u = { app, page };
  u.text = (sel) =>
    page.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel);
  u.visible = (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      return !!el && el.getBoundingClientRect().width > 0;
    }, sel);
  u.shot = async (name, selector) => {
    if (!SCREENS) return;
    await sleep(300);
    const el = selector ? await page.$(selector) : null;
    await (el ?? page).screenshot({ path: join(SCREENS, `${name}.png`) });
  };
  u.clickText = async (selector, label) => {
    for (const el of await page.$$(selector))
      if ((await el.evaluate((e) => e.textContent.trim())).startsWith(label)) {
        await el.click();
        return true;
      }
    return false;
  };
  /** A button anywhere, the viewer's shadow DOM too, by its label */
  u.press = (label) =>
    page.evaluate((l) => {
      const host = [...document.querySelectorAll('#viewer-host *')].find(
        (e) => e.shadowRoot
      );
      return !![
        ...document.querySelectorAll('button'),
        ...(host?.shadowRoot?.querySelectorAll('button') ?? []),
      ]
        .find(
          (b) =>
            (b.getAttribute('aria-label') || b.title) === l &&
            b.getBoundingClientRect().width > 0
        )
        ?.click();
    }, label);
  u.ready = async () => {
    await until(
      () =>
        page.evaluate(
          () =>
            document.querySelector('#view-doc.is-active') &&
            !document.querySelector('#doc-stage.is-loading')
        ),
      30000
    );
    await sleep(1200);
  };
  u.activate = async (name) => {
    await page.evaluate(
      (n) =>
        [...document.querySelectorAll('[role=tab]')]
          .find((t) => t.textContent.includes(n))
          ?.click(),
      name
    );
    await sleep(800);
    await u.ready();
  };
  u.toastSince = async (before, re, timeout = 20000) =>
    until(async () => {
      const t = await u.text('#toasts');
      return t !== before && re.test(t) ? t.replace(before, '') : null;
    }, timeout);
  u.bar = async () => {
    if (await u.visible('#cert-bar')) return;
    await u.clickText('.lp:not([hidden]) .lp-tool', 'Use a certificate');
    await until(() => u.visible('#cert-bar'));
  };
  /** Page `index`'s drawing layer, scrolled so fraction fy is mid-window */
  u.layer = async (index, fy) => {
    const rect = () =>
      page.evaluate((i) => {
        const host = [...document.querySelectorAll('#viewer-host *')].find(
          (e) => e.shadowRoot
        );
        const l = host?.shadowRoot?.querySelector(
          `.pwsig-layer[data-page="${i}"]`
        );
        if (!l) return null;
        const r = l.getBoundingClientRect();
        return r.width > 0
          ? { x: r.left, y: r.top, w: r.width, h: r.height }
          : null;
      }, index);
    // (the viewer only draws pages near the one shown: go there)
    for (let n = 0; n < 12 && !(await rect()); n++) {
      await u.press('Next page');
      await sleep(600);
    }
    if (!(await rect())) throw new Error(`page ${index + 1} takes no box`);
    await page.evaluate(
      (i, fy) => {
        const host = [...document.querySelectorAll('#viewer-host *')].find(
          (e) => e.shadowRoot
        );
        const l = host.shadowRoot.querySelector(
          `.pwsig-layer[data-page="${i}"]`
        );
        let sc = l.parentElement;
        while (sc && sc.scrollHeight <= sc.clientHeight + 2)
          sc = sc.parentElement;
        if (!sc) return;
        const r = l.getBoundingClientRect();
        sc.scrollTop += r.top + r.height * fy - innerHeight / 2;
      },
      index,
      fy
    );
    await sleep(500);
    return rect();
  };
  u.startSign = async () => {
    // (a click just as the bar is drawn again, when the document's form
    // has been read, can miss: click again)
    for (let n = 0; n < 4; n++) {
      await page.click('#cb-sign');
      if (
        await until(
          async () => /Drag a box/.test(await u.text('#cert-bar')),
          4000
        )
      )
        return true;
    }
    throw new Error('Digitally sign didn’t start');
  };

  /** Drags a box (fractions of the unrotated page's layer); returns it */
  u.drag = async (index, [fx0, fy0, fx1, fy1]) => {
    const r = await u.layer(index, (fy0 + fy1) / 2);
    const [x0, y0, x1, y1] = [
      r.x + r.w * fx0,
      r.y + r.h * fy0,
      r.x + r.w * fx1,
      r.y + r.h * fy1,
    ];
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 6 });
    await page.mouse.move(x1, y1, { steps: 6 });
    await page.mouse.up();
    return { x: fx0, y: fy0, width: fx1 - fx0, height: fy1 - fy0 };
  };
  u.list = async () => {
    if (!(await until(() => u.visible('#cid-dialog'))))
      throw new Error(
        `Sign with a Digital ID didn’t open (bar: ${await u.text('#cert-bar')})`
      );
    await until(
      async () => !/Looking for/.test(await u.text('#cid-dialog .cid-list')),
      30000
    );
  };
  u.pick = async (name) => {
    const found = await page.evaluate((n) => {
      const row = [...document.querySelectorAll('#cid-dialog .cid-row')].find(
        (r) => r.querySelector('.cid-name b')?.textContent === n
      );
      row?.scrollIntoView({ block: 'nearest' });
      row?.click();
      return !!row;
    }, name);
    if (!found) throw new Error(`no ID named ${name}`);
  };
  u.addFile = async (paths, password) => {
    await page.click('#cid-configure');
    await until(() => u.visible('#cfg-dialog'));
    const choosing = page.waitForFileChooser({ timeout: 10000 });
    await page.click('#cfg-continue');
    await (await choosing).accept(paths);
    await until(() => u.visible('#idfile-dialog'));
    await page.type('#idfile-password', password);
    await page.click('#idfile-add');
    await until(
      async () =>
        !(await u.visible('#idfile-dialog')) ||
        !/Opening/.test(await u.text('#idfile-dialog .cs-status')),
      20000
    );
    await sleep(300);
    return (await u.visible('#idfile-dialog'))
      ? u.text('#idfile-dialog .cs-status')
      : null;
  };
  u.signAs = async ({ appearance, reason, location, lock, tsa } = {}) => {
    await page.click('#cid-continue');
    await until(() => u.visible('#sas-dialog'));
    if (appearance) {
      await page.click('#sas-create');
      await until(() => u.visible('#app-dialog'));
      await page.type('#app-title', appearance.title);
      if (appearance.image) {
        const choosing = page.waitForFileChooser({ timeout: 10000 });
        await u.clickText('#app-dialog button', 'Choose image');
        await (await choosing).accept([appearance.image]);
        await until(() =>
          page.$eval('#app-dialog input[value=image]', (e) => e.checked)
        );
      } else {
        await page.click(
          `#app-dialog input[name=app-graphic][value=${appearance.graphic}]`
        );
      }
      for (const [k, v] of Object.entries(appearance.show))
        if (
          (await page.$eval(
            `#app-dialog input[data-show="${k}"]`,
            (e) => e.checked
          )) !== v
        )
          await page.click(`#app-dialog input[data-show="${k}"]`);
      await u.shot(`appearance-${appearance.title}`, '#app-dialog');
      await page.click('#app-save');
      await until(async () => !(await u.visible('#app-dialog')));
    } else {
      const v = await page.$$eval(
        '#sas-appearance option',
        (o) => o.find((x) => x.textContent === 'Standard text')?.value
      );
      await page.select('#sas-appearance', v);
    }
    for (const [sel, value] of [
      ['#sas-reason', reason],
      ['#sas-location', location],
    ]) {
      await page.$eval(sel, (e) => (e.value = ''));
      if (value) await page.type(sel, value);
    }
    if ((await page.$eval('#sas-lock', (e) => e.checked)) !== !!lock)
      await page.click('#sas-lock');
    const tsaValue = tsa
      ? await page.$$eval('#sas-tsa option', (o) => o[1]?.value)
      : '';
    await page.select('#sas-tsa', tsaValue);
  };
  /** Sign; resolves with the toast once saved, or the dialog's message */
  u.sign = async (timeout = 90000) => {
    const before = await u.text('#toasts');
    const seen = [];
    const watch = setInterval(async () => {
      const t = await u.text('#sas-dialog .cs-status').catch(() => '');
      if (t && seen[seen.length - 1] !== t) seen.push(t);
    }, 60);
    await page.click('#sas-sign');
    const res = await until(async () => {
      const t = await u.text('#toasts');
      if (t !== before && /Signed and saved/.test(t))
        return { saved: t.replace(before, '') };
      const busy = await page.evaluate(
        () => document.querySelector('#sas-sign')?.disabled
      );
      const st = await u.text('#sas-dialog .cs-status');
      if (!busy && st && !/Signing…|Waiting for|Choose where/.test(st))
        return { message: st };
      return null;
    }, timeout);
    clearInterval(watch);
    return { ...res, statuses: seen };
  };
  /** Validate signatures on the open document: each card's title and
   *  status line, and the summary */
  u.validate = async (
    shotName,
    { systemTrust = false, trustFile = null } = {}
  ) => {
    await u.bar();
    await u.clickText('#cert-bar button', 'Validate signatures');
    const frame = await until(async () =>
      page
        .frames()
        .find(
          (f) => f.url().includes('validate-signature-pdf') && !f.isDetached()
        )
    );
    const read = () =>
      frame.evaluate(() => {
        const box = document.querySelector('#results-container');
        if (
          !box ||
          !/Signature 1|No Signatures|Document timestamp/.test(box.innerText)
        )
          return null;
        return {
          summary: box.firstElementChild?.innerText ?? '',
          cards: [...box.querySelectorAll(':scope > div')]
            .filter((c) => c.querySelector('h3'))
            .map((c) => ({
              title: c.querySelector('h3')?.textContent ?? '',
              status: c.querySelector('h3 + p')?.textContent ?? '',
              badges: [...c.querySelectorAll('span.rounded')].map((s) =>
                s.textContent.trim()
              ),
              explanation: c.querySelector('.sig-explanation')?.innerText ?? '',
            })),
        };
      });
    const results = await until(read, 30000);
    if (trustFile) {
      // Custom certificate: the organisation's root, chosen as trusted
      await (await frame.$('#cert-input')).uploadFile(trustFile);
      await sleep(3000);
      results.withTrustFile = await read();
      if (shotName) {
        await frame.evaluate(() =>
          document.querySelector('#results-section')?.scrollIntoView()
        );
        await u.shot(`${shotName}-trusted`);
      }
    }
    if (systemTrust) {
      // Trust root certificates in the Windows store / Keychain
      await frame.evaluate(() =>
        document
          .querySelector('#custom-cert-section input[type=checkbox]')
          ?.click()
      );
      await sleep(4000);
      results.withSystemTrust = await read();
      await frame.evaluate(() =>
        document
          .querySelector('#custom-cert-section input[type=checkbox]')
          ?.click()
      );
    }
    if (shotName && SCREENS) {
      await frame.evaluate(() =>
        document.querySelector('#results-section')?.scrollIntoView()
      );
      await u.shot(shotName);
    }
    await u.press('Back to tools');
    await sleep(500);
    return results;
  };
  return u;
}

/* ------------------------------------------------------------------ */
/* Checking a signed file                                              */
/* ------------------------------------------------------------------ */

/**
 * The last signature in `file` against what was asked: the box drawn on
 * `page`, reason, location, lock; the appearance's text (OCR) has every
 * `says` and none of `never`; pyHanko and OpenSSL find every signature
 * intact and valid, earlier ones covering their version
 */
async function verify(file, want) {
  const label = want.label;
  if (!check(existsSync(file), `${label}: the signed file is on disk`)) return;
  const bytes = readFileSync(file);
  const fields = (await signatureFields(bytes)).filter((f) => f.signed);
  const f = fields[fields.length - 1];
  check(
    fields.length === want.count,
    `${label}: ${want.count} signature(s) in the file`,
    `${fields.length}`
  );
  if (want.box) {
    const rect = expectedRect(want.box, await cropBox(bytes, want.page));
    const off = rectOff(f.rect, rect);
    check(
      f.page === want.page && off < 2,
      `${label}: the signature is on page ${want.page + 1}, where the box was drawn`,
      `page ${f.page + 1}, off by ${off.toFixed(2)} pt`
    );
  }
  check(
    f.reason === want.reason && f.location === want.location,
    `${label}: reason and location in the signature`,
    `${JSON.stringify(f.reason)}, ${JSON.stringify(f.location)}`
  );
  check(
    want.lock
      ? f.lock?.p === 1 &&
          f.transforms.some((t) => t.method === '/FieldMDP' && t.p === 1)
      : !f.lock,
    `${label}: ${want.lock ? 'locked (FieldMDP, no changes allowed)' : 'not locked'}`
  );
  if (want.says || want.never) {
    const [text] = await ocr([f.image]);
    const flat = squash(text);
    const missing = (want.says ?? []).filter((s) => !flat.includes(squash(s)));
    const extra = (want.never ?? []).filter((s) => flat.includes(squash(s)));
    check(
      !missing.length && !extra.length,
      `${label}: the appearance shows what was chosen`,
      missing.length || extra.length
        ? `missing ${JSON.stringify(missing)}, unwanted ${JSON.stringify(extra)}; read: ${text.replace(/\s+/g, ' ')}`
        : text.replace(/\s+/g, ' ').slice(0, 120)
    );
  }
  const py = pyhanko(file);
  if (py) {
    const sigs = py.signatures.filter((s) => s.type !== '/DocTimeStamp');
    const bad = sigs.filter(
      (s, i) =>
        !s.intact ||
        !s.valid ||
        (i === sigs.length - 1
          ? // (or its version, with long-term validation data added after it)
            s.coverage !== 'ENTIRE_FILE' &&
            !(
              s.coverage === 'ENTIRE_REVISION' &&
              s.modification === 'LTA_UPDATES'
            )
          : s.coverage !== 'ENTIRE_REVISION' || s.modification === 'OTHER')
    );
    check(
      !bad.length && sigs.length === want.count,
      `${label}: pyHanko: every signature intact and valid, the last covering the whole file`,
      bad
        .map(
          (s) => `${s.field} ${s.coverage} ${s.modification} ${s.error ?? ''}`
        )
        .join('; ')
    );
  } else note('(pyHanko not installed: skipped)');
  const os = openssl(file);
  if (os)
    check(
      os.failed === 0 && os.checked === want.count,
      `${label}: OpenSSL verifies every signature`,
      `${os.checked} checked, ${os.failed} failed`
    );
  return { fields, py, bytes };
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

const sections = {};

sections.appearances = async () => {
  const doc = await agreement(join(DOCS, 'Agreement.pdf'));
  const image = logo(join(DOCS, 'logo.png'));
  const u = await open([doc]);
  try {
    await u.ready();
    await u.bar();
    const plan = [
      {
        who: id('rsa'),
        box: [0.12, 0.34, 0.48, 0.43],
        reason: 'I am the author of this document',
        location: 'Praha',
        says: [
          'Digitally signed by',
          'Reason:',
          'am the author',
          'Location: Praha',
          'Date:',
        ],
      },
      {
        who: id('p256', 'rsa'),
        box: [0.52, 0.34, 0.9, 0.43],
        appearance: {
          title: 'No labels with DN',
          graphic: 'name',
          show: {
            name: true,
            date: true,
            reason: true,
            location: true,
            dn: true,
            labels: false,
          },
        },
        reason: 'Reviewed',
        location: 'Brno',
        says: ['Reviewed', 'Brno', 'CN='],
        never: ['Reason:', 'Location:', 'Digitally signed'],
      },
      {
        who: id('p384', 'rsa'),
        box: [0.12, 0.5, 0.48, 0.59],
        appearance: {
          title: 'Logo',
          image,
          show: {
            name: true,
            date: true,
            reason: false,
            location: false,
            dn: false,
            labels: true,
          },
        },
        reason: 'Approved',
        location: 'Ostrava',
        says: ['Digitally signed by', 'Date:'],
        never: ['Approved', 'Ostrava'],
      },
      {
        who: id('csp', 'p521', 'rsa'),
        box: [0.52, 0.5, 0.9, 0.59],
        appearance: {
          title: 'Text only',
          graphic: 'none',
          show: {
            name: true,
            date: false,
            reason: true,
            location: false,
            dn: false,
            labels: true,
          },
        },
        reason: 'Final approval',
        location: 'Plzen',
        lock: true,
        says: ['Digitally signed by', 'Reason: Final approval'],
        never: ['Plzen', 'Date:'],
      },
    ];
    let name = 'Agreement';
    for (const [i, p] of plan.entries()) {
      await u.startSign();
      const box = await u.drag(0, p.box);
      await u.list();
      await u.pick(p.who.name);
      await u.signAs(p);
      if (i === 0) {
        await u.shot('sign-as', '#sas-dialog');
        // Save As cancelled: not signed, and it says so; Sign again saves
        writeFileSync(join(OUT, '.cancel-next-save'), '');
        const cancelled = await u.sign();
        check(
          /wasn.t saved, so it isn.t signed/.test(cancelled.message ?? '') &&
            !existsSync(join(OUT, 'Agreement (signed).pdf')),
          'Save As cancelled: nothing saved, and it says it isn’t signed',
          cancelled.message
        );
      }
      const res = await u.sign();
      name += ' (signed)';
      check(
        !!res.saved,
        `appearance ${i + 1}: signed and saved`,
        res.saved ?? res.message
      );
      if (i === 0)
        check(
          res.statuses.includes('Waiting for your PIN or confirmation…'),
          'an installed ID: “Waiting for your PIN or confirmation…” while Windows or macOS signs'
        );
      await sleep(1500);
      await verify(join(OUT, `${name}.pdf`), {
        label: `appearance ${i + 1}`,
        count: i + 1,
        page: 0,
        box,
        reason: p.reason,
        location: p.location,
        lock: p.lock,
        says: [p.who.name.split(' ').pop(), ...p.says],
        never: p.never,
      });
    }
    await u.shot('four-signatures', '#doc-stage');
    const before = await u.text('#toasts');
    await u.page.click('#cb-sign');
    check(
      !!(await u.toastSince(before, /can.t be signed again/)),
      'locked: it can’t be signed again, and says so'
    );
    const v = await u.validate('validate-four');
    check(
      /4 signatures found/.test(v.summary),
      'Validate signatures finds the four',
      v.summary.replace(/\s+/g, ' ')
    );
    check(
      v.cards.length === 4 &&
        v.cards.every(
          (c) =>
            /Self-Signed: Signer Identity Not Verified/.test(c.status) &&
            /self-signed/.test(c.explanation)
        ),
      'each: intact, self-signed (identity not verified), explained',
      v.cards.map((c) => c.status).join(' | ')
    );
    check(
      v.cards
        .slice(0, 3)
        .every((c) => c.badges.includes('Covers its version')) &&
        v.cards[3].badges.includes('Full Coverage'),
      'the first three cover their version (signed again later), the last the whole file'
    );
  } finally {
    await u.app.close();
  }
};

sections.changes = async () => {
  // A signed document, then changed in three ways
  const doc = await agreement(join(DOCS, 'Lease.pdf'), 1);
  let u = await open([doc]);
  const signed = join(OUT, 'Lease (signed).pdf');
  try {
    await u.ready();
    await u.bar();
    await u.startSign();
    await u.drag(0, [0.15, 0.4, 0.55, 0.5]);
    await u.list();
    await u.pick(id('rsa').name);
    await u.signAs({ reason: 'Agreed' });
    check(!!(await u.sign()).saved, 'changes: the lease is signed');
  } finally {
    await u.app.close();
  }
  const bytes = readFileSync(signed);
  const at = bytes.indexOf('/MediaBox') + 12;
  const byte = Buffer.from(bytes);
  byte[at] = byte[at] === 0x35 ? 0x36 : 0x35;
  const tampered = join(DOCS, 'Lease (one byte changed).pdf');
  writeFileSync(tampered, byte);
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  const pg = d.getPage(0);
  const content = PDFRef.of(d.context.largestObjectNumber + 1);
  const pageDict = pg.node.clone(d.context);
  pageDict.set(
    PDFName.of('Contents'),
    d.context.obj([pg.node.get(PDFName.of('Contents')), content])
  );
  const draw = 'BT /F1 20 Tf 72 300 Td (Rent: 1 EUR) Tj ET';
  const later = join(DOCS, 'Lease (text added later).pdf');
  writeFileSync(
    later,
    await appendUpdate(bytes, [
      {
        ref: content,
        body: `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
      },
      { ref: pg.ref, body: pageDict.toString() },
    ])
  );
  for (const [file, intact, what] of [
    [tampered, false, 'one byte changed'],
    [later, true, 'text added later'],
  ]) {
    const py = pyhanko(file);
    if (py)
      check(
        py.signatures[0].intact === intact &&
          (intact ? py.signatures[0].modification === 'OTHER' : true),
        `${what}: pyHanko agrees it was ${intact ? 'changed after signing' : 'tampered with'}`,
        JSON.stringify(py.signatures[0])
      );
  }
  const copyOfSigned = join(DOCS, 'Lease (signed).pdf');
  copyFileSync(signed, copyOfSigned);
  u = await open([tampered, later, copyOfSigned]);
  try {
    await u.ready();
    await u.activate('one byte changed');
    let v = await u.validate('validate-byte-changed');
    check(
      v.cards[0]?.status ===
        'Invalid: the document was changed after it was signed' &&
        /no longer matches/.test(v.cards[0].explanation),
      'one byte changed: invalid, “the document was changed after it was signed”',
      v.cards[0]?.status
    );
    await u.activate('text added later');
    v = await u.validate('validate-text-added');
    check(
      v.cards[0]?.status === 'Changed after signing' &&
        /page 1 was changed/.test(v.cards[0].explanation),
      'text added later: “Changed after signing”, saying page 1 was changed',
      `${v.cards[0]?.status}: ${v.cards[0]?.explanation}`
    );

    // Editing the signed document in Paperwing: signing it, or saving it,
    // asks first (its signatures would no longer be valid)
    await u.activate('Lease (signed)');
    const original = readFileSync(copyOfSigned);
    await u.press('Add a comment');
    await sleep(500);
    const r = await u.page.evaluate(() => {
      const host = [...document.querySelectorAll('#viewer-host *')].find(
        (e) => e.shadowRoot
      );
      const pg = [...host.shadowRoot.querySelectorAll('div')].find(
        (x) =>
          x.style.position === 'relative' &&
          /px$/.test(x.style.width) &&
          x.firstElementChild instanceof HTMLImageElement
      );
      const b = pg.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width };
    });
    await u.page.mouse.click(r.x + r.w * 0.8, r.y + 200);
    await sleep(600);
    await u.page.keyboard.type('Please check the rent');
    await u.page.keyboard.press('Escape');
    await sleep(600);
    const dialogText = () =>
      u.page.evaluate(
        () => document.querySelector('.dlg-backdrop')?.innerText ?? ''
      );
    await u.bar();
    await u.page.click('#cb-sign');
    const askSign = await until(async () => {
      const t = await dialogText();
      return /Sign a changed document/.test(t) ? t : null;
    }, 10000);
    check(
      !!askSign,
      'signing a changed signed document asks first',
      askSign?.replace(/\s+/g, ' ')
    );
    await u.shot('sign-changed-asks');
    if (askSign) await u.clickText('.dlg-backdrop button', 'Cancel');
    await sleep(400);
    check(
      !/Drag a box/.test(await u.text('#cert-bar')),
      'Cancel: it doesn’t start signing'
    );
    await u.page.keyboard.down(
      process.platform === 'darwin' ? 'Meta' : 'Control'
    );
    await u.page.keyboard.press('s');
    await u.page.keyboard.up(
      process.platform === 'darwin' ? 'Meta' : 'Control'
    );
    const ask = await until(async () => {
      const t = await dialogText();
      return /Save changes to a signed document/.test(t) ? t : null;
    }, 10000);
    check(
      !!ask,
      'saving a changed signed document asks first, saying its signatures will no longer be valid',
      ask?.replace(/\s+/g, ' ')
    );
    await u.shot('save-signed-asks');
    if (ask) {
      await u.clickText('.dlg-backdrop button', 'Save as a copy');
      await sleep(2000);
      check(
        readFileSync(copyOfSigned).equals(original),
        'Save as a copy: the signed original is unchanged'
      );
      const copy = join(OUT, 'Lease (signed).pdf');
      check(
        existsSync(copy) && !readFileSync(copy).equals(original),
        'and the copy with the comment is saved'
      );
      // What the copy's signature looks like now: no longer valid
      v = await u.validate('validate-saved-copy');
      check(
        /Invalid|Changed after signing/.test(v.cards[0]?.status ?? ''),
        'the saved copy: its signature shows as no longer valid, as the warning said',
        v.cards[0]?.status
      );
    }
  } finally {
    await u.app.close();
  }
};

sections.ids = async () => {
  const pki = join(OUT, 'pki');
  mkdirSync(pki, { recursive: true });
  const haveOpenssl = !!makePki(pki);
  const doc = await agreement(join(DOCS, 'Order.pdf'), 1);
  const u = await open([doc]);
  try {
    await u.ready();
    await u.bar();
    await u.startSign();
    await u.drag(0, [0.15, 0.4, 0.55, 0.5]);
    await u.list();
    if (haveOpenssl) {
      const cases = [
        [
          ['good.pfx'],
          'wrong',
          /password is incorrect/,
          'a wrong password says so',
        ],
        [
          ['nokey.pfx'],
          'qa-pass',
          /no private key/,
          'a file without a private key says so',
        ],
        [
          ['good.crt'],
          '',
          /choose both files together/,
          'a certificate without its key file says how to add it',
        ],
        [
          ['login.pfx'],
          'qa-pass',
          /can.t sign.*logging in/,
          'a login-only ID says it can’t sign, and why',
        ],
        [
          ['enc-key.pem', 'good.crt'],
          'nope',
          /password is incorrect/,
          'an encrypted key with a wrong password says so',
        ],
      ];
      for (const [files, pw, re, what] of cases) {
        const msg = await u.addFile(
          files.map((f) => join(pki, f)),
          pw
        );
        check(!!msg && re.test(msg), what, msg ?? 'added');
        if (msg) await u.page.keyboard.press('Escape');
        await sleep(300);
      }
      const ok = await u.addFile(
        [join(pki, 'good.crt'), join(pki, 'good.key')],
        ''
      );
      check(
        ok === null,
        'a certificate and its key chosen together: added',
        ok ?? ''
      );
      const row = await u.page.evaluate(
        () =>
          document
            .querySelector('#cid-dialog input[name=cid]:checked')
            ?.closest('.cid-row')?.innerText
      );
      check(
        /QA Good Signer/.test(row ?? '') && /File/.test(row ?? ''),
        'and selected, as a File ID',
        row?.replace(/\s+/g, ' ')
      );
    } else note('(OpenSSL not installed: ID file errors skipped)');

    // Create a new Digital ID, RSA and ECDSA: saved as .pfx, read back
    for (const [key, name, pw] of [
      ['rsa', 'Jana Nováková', 'secret-rsa'],
      ['ec', 'Alex Tester', 'secret-ec'],
    ]) {
      await u.page.click('#cid-configure');
      await until(() => u.visible('#cfg-dialog'));
      await u.page.click('#cfg-dialog input[value="create"]');
      await u.page.click('#cfg-continue');
      await until(() => u.visible('#newid-dialog'));
      await u.page.type('#newid-name', name);
      await u.page.type('#newid-email', 'qa@example.com');
      await u.page.type('#newid-org', 'Příklad s.r.o.');
      await u.page.type('#newid-unit', 'Legal');
      await u.page.type('#newid-country', 'cz');
      await u.page.select('#newid-key', key);
      await u.page.type('#newid-password', pw);
      await u.page.type('#newid-password2', pw);
      await u.page.click('#newid-save');
      await until(async () => !(await u.visible('#newid-dialog')), 30000);
      const pfx = join(OUT, `${name}.pfx`);
      check(existsSync(pfx), `new ${key} ID: saved as ${name}.pfx`);
      await u.page.click('#cid-details');
      await until(() => u.visible('#cert-details-dialog'));
      const details = await u.page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('#cert-details-dialog tr')].map(
            (tr) => [
              tr.querySelector('th').textContent,
              tr.querySelector('td').textContent,
            ]
          )
        )
      );
      await u.clickText('#cert-details-dialog button', 'Close');
      check(
        details.Subject ===
          `CN=${name}, OU=Legal, O=Příklad s.r.o., E=qa@example.com, C=CZ` &&
          details.Key === (key === 'rsa' ? 'RSA 2048-bit' : 'ECDSA P-256'),
        `new ${key} ID: its details are what was entered`,
        `${details.Subject}; ${details.Key}`
      );
      if (haveOpenssl) {
        const subject = run('openssl', [
          'pkcs12',
          '-in',
          pfx,
          '-passin',
          `pass:${pw}`,
          '-nokeys',
          '-clcerts',
        ]);
        const fp =
          subject &&
          run(
            'openssl',
            ['x509', '-noout', '-fingerprint', '-sha256'],
            subject
          );
        check(
          !!fp &&
            fp
              .replace(/[:\s]/g, '')
              .toUpperCase()
              .endsWith(details['SHA-256 fingerprint']),
          `new ${key} ID: OpenSSL opens the .pfx with its password; same certificate`
        );
        check(
          run('openssl', [
            'pkcs12',
            '-in',
            pfx,
            '-passin',
            'pass:wrong',
            '-nokeys',
          ]) === null,
          `new ${key} ID: and refuses a wrong password`
        );
      }
    }
  } finally {
    await u.app.close();
  }
};

sections.pages = async () => {
  const rot = await rotated(join(DOCS, 'Turned pages.pdf'));
  const scan = join(DOCS, 'Scanned.pdf');
  spawnSync(process.execPath, [join(here, 'make-scan-fixture.mjs'), scan, '1']);
  spawnSync(process.execPath, [join(here, 'make-form-fixture.mjs'), DOCS]);
  const form = join(DOCS, 'Form - filled in.pdf');
  const cases = [
    {
      file: rot,
      label: 'page 3 of 4, turned 180°',
      page: 2,
      box: [0.2, 0.3, 0.6, 0.4],
    },
    {
      file: rot,
      label: 'page 2 of 4, turned 90°',
      page: 1,
      box: [0.3, 0.2, 0.45, 0.6],
    },
    { file: scan, label: 'a scanned page', page: 0, box: [0.5, 0.8, 0.9, 0.9] },
    {
      file: form,
      label: 'a filled-in form',
      page: 0,
      box: [0.55, 0.85, 0.95, 0.95],
      form: true,
    },
    { file: rot, label: 'a tiny box', page: 0, box: [0.5, 0.5, 0.52, 0.515] },
    {
      file: rot,
      label: 'a box as wide as the page',
      page: 0,
      box: [0.01, 0.42, 0.99, 0.58],
    },
    {
      file: rot,
      label: 'a click (a box of the usual size)',
      page: 0,
      click: [0.5, 0.6],
    },
  ];
  for (const c of cases) {
    const copy = join(DOCS, `${c.label.replace(/[^\w ]+/g, '')}.pdf`);
    copyFileSync(c.file, copy);
    const u = await open([copy]);
    try {
      await u.ready();
      await u.bar();
      await u.startSign();
      let box;
      if (c.click) {
        const r = await u.layer(c.page, c.click[1]);
        await u.page.mouse.click(
          r.x + r.w * c.click[0],
          r.y + r.h * c.click[1]
        );
        const wFrac = 0.3;
        const hFrac = (wFrac * r.w) / 3.2 / r.h;
        box = {
          x: c.click[0] - wFrac / 2,
          y: c.click[1] - hFrac / 2,
          width: wFrac,
          height: hFrac,
        };
      } else box = await u.drag(c.page, c.box);
      await u.list();
      await u.pick(id('p256', 'rsa').name);
      await u.signAs({ reason: 'Checked' });
      const res = await u.sign();
      check(!!res.saved, `${c.label}: signed`, res.saved ?? res.message);
      await sleep(1200);
      await u.shot(`page-${c.label.replace(/[^\w]+/g, '-')}`, '#doc-stage');
      const signedFile = join(
        OUT,
        `${c.label.replace(/[^\w ]+/g, '')} (signed).pdf`
      );
      // (the layer turns with the page: on a page turned 180° the box
      // drawn on screen is the other way round in the page's own terms;
      // 90° is checked by check-cert-placement)
      const own =
        c.page === 2
          ? {
              x: 1 - box.x - box.width,
              y: 1 - box.y - box.height,
              width: box.width,
              height: box.height,
            }
          : c.page === 1
            ? null
            : box;
      const r = await verify(signedFile, {
        label: c.label,
        count: 1,
        page: c.page,
        box: own,
        reason: 'Checked',
        says:
          c.box && (c.box[2] - c.box[0]) * 612 < 30
            ? undefined
            : ['Digitally signed by'],
      });
      if (c.form && r) {
        const before = await PDFDocument.load(readFileSync(copy));
        const after = await PDFDocument.load(r.bytes);
        const values = (d) =>
          d
            .getForm()
            .getFields()
            .filter((f) => f.constructor.name === 'PDFTextField')
            .map((f) => [f.getName(), f.getText()]);
        check(
          JSON.stringify(values(before)) === JSON.stringify(values(after)),
          'a filled-in form: its values are kept'
        );
      }
    } finally {
      await u.app.close();
    }
  }
};

sections.ocsp = async () => {
  const pki = join(OUT, 'pki');
  mkdirSync(pki, { recursive: true });
  if (!makePki(pki)) return note('(OpenSSL not installed: OCSP skipped)');
  const responder = await ocspResponder(pki);
  const doc = await agreement(join(DOCS, 'Invoice.pdf'), 1);
  const u = await open([doc], { PAPERWING_TEST_RELAY_LOCAL: '1' });
  try {
    await u.ready();
    await u.bar();
    for (const [pfx, revoked] of [
      ['good.pfx', false],
      ['revoked.pfx', true],
    ]) {
      await u.startSign();
      await u.drag(
        0,
        revoked ? [0.15, 0.6, 0.55, 0.7] : [0.15, 0.4, 0.55, 0.5]
      );
      await u.list();
      check(
        (await u.addFile([join(pki, pfx)], 'qa-pass')) === null,
        `${pfx}: added`
      );
      await u.signAs({ reason: 'Invoice approved' });
      const res = await u.sign();
      if (revoked) {
        check(
          !res.saved && /revoked/i.test(res.message ?? ''),
          'a revoked certificate: refused, in plain words',
          res.message ?? res.saved
        );
        await u.shot('revoked', '#sas-dialog');
        await u.page.keyboard.press('Escape');
        await sleep(300);
        await u.page.keyboard.press('Escape');
      } else {
        check(
          !!res.saved,
          'a CA-issued ID whose certificate is good: signed',
          res.saved ?? res.message
        );
        await sleep(1500);
        const r = await verify(join(OUT, 'Invoice (signed).pdf'), {
          label: 'good certificate',
          count: 1,
          reason: 'Invoice approved',
        });
        const v = await u.validate('validate-ca-issued', {
          trustFile: join(pki, 'ca.pem'),
        });
        check(
          v.cards[0]?.status ===
            'Signature Intact: Signer Identity Not Verified' &&
            /issued by Paperwing QA Root CA/.test(v.cards[0].explanation),
          'Validate signatures, nothing trusted: intact, issuer not trusted, and how to trust it',
          v.cards[0]?.status
        );
        check(
          v.withTrustFile?.cards[0]?.status === 'Valid Signature',
          'with the CA’s certificate chosen as trusted: Valid Signature',
          v.withTrustFile?.cards[0]?.status
        );
        const py = pyhanko(join(OUT, 'Invoice (signed).pdf'), [
          join(pki, 'ca.pem'),
        ]);
        if (py)
          check(
            py.dss?.OCSPs >= 1 && py.signatures[0].trusted,
            'long-term validation: the OCSP reply is in the DSS, and the signer chains to the CA',
            JSON.stringify(py.dss)
          );
        void r;
      }
    }
    check(
      responder.asked.length >= 2,
      'the OCSP responder was asked for both',
      responder.asked.join(', ')
    );
  } finally {
    await u.app.close();
    responder.close();
  }
};

sections.tsa = async () => {
  const doc = await agreement(join(DOCS, 'Notice.pdf'), 1);
  const u = await open([doc]);
  try {
    await u.ready();
    await u.bar();
    await u.startSign();
    await u.drag(0, [0.15, 0.4, 0.55, 0.5]);
    await u.list();
    await u.pick(id('rsa').name);
    await u.signAs({ reason: 'Sent', tsa: true });
    const started = Date.now();
    const res = await u.sign();
    check(
      !!res.saved,
      'with a timestamp from the first timestamp server: signed',
      res.saved ?? res.message
    );
    await sleep(1500);
    const file = join(OUT, 'Notice (signed).pdf');
    const py = pyhanko(file);
    if (py) {
      const ts = py.signatures[0].timestamp;
      const off = ts
        ? Math.abs(Date.parse(ts.time) - started) / 1000
        : Infinity;
      check(
        !!ts && ts.intact && ts.valid && off < 300,
        'pyHanko: the timestamp token is embedded and valid, its time within minutes of signing',
        ts ? `${ts.authority}, ${ts.time}` : 'none'
      );
    }
    let v = await u.validate('validate-timestamped');
    check(
      /Timestamped by .+ on /.test(v.cards[0]?.explanation ?? ''),
      'Validate signatures shows the timestamp',
      v.cards[0]?.explanation
    );
    // Add a timestamp (a document timestamp), on the signed document
    await u.bar();
    await u.clickText('#cert-bar button', 'Add a timestamp');
    const frame = await until(async () =>
      u.page
        .frames()
        .find((f) => f.url().includes('timestamp-pdf') && !f.isDetached())
    );
    await until(
      () =>
        frame.evaluate(
          () =>
            !document
              .querySelector('#tsa-section')
              ?.classList.contains('hidden')
        ),
      30000
    );
    const before = await u.text('#toasts');
    await frame.evaluate(() =>
      document
        .querySelector('#process-btn, #timestamp-btn, button.btn-gradient')
        ?.click()
    );
    const saved = await u.toastSince(before, /\.pdf/, 60000);
    note(`Add a timestamp: ${saved}`);
    await sleep(2000);
    v = await u.validate('validate-doc-timestamp');
    check(
      v.cards.some(
        (c) =>
          /Document timestamp/.test(c.title) &&
          /Timestamp intact|Valid timestamp/.test(c.status)
      ) &&
        /Signer Identity Not Verified|Self-Signed/.test(
          v.cards[0]?.status ?? ''
        ),
      'Add a timestamp (not saved yet): Validate signatures lists the document timestamp, intact, and the signature still valid',
      v.cards.map((c) => `${c.title}: ${c.status}`).join(' | ')
    );
    // Trusting the system's root certificates: the timestamp authority
    // (DigiCert) leads to one; the self-signed signer still doesn't
    const trusted = (
      await u.validate('validate-system-trust', { systemTrust: true })
    ).withSystemTrust;
    check(
      trusted?.cards.some(
        (c) =>
          /Document timestamp/.test(c.title) && c.status === 'Valid timestamp'
      ) && /Self-Signed/.test(trusted.cards[0]?.status ?? ''),
      'Trust root certificates in the system store: the timestamp authority is trusted, the self-signed signer still isn’t',
      trusted?.cards.map((c) => `${c.title}: ${c.status}`).join(' | ')
    );
    // Saved: byte for byte as the tool made it
    const name = /Opened (.+\.pdf) in a new tab/.exec(saved ?? '')?.[1];
    const before2 = await u.text('#toasts');
    await u.page.keyboard.down(
      process.platform === 'darwin' ? 'Meta' : 'Control'
    );
    await u.page.keyboard.press('s');
    await u.page.keyboard.up(
      process.platform === 'darwin' ? 'Meta' : 'Control'
    );
    await u.toastSince(before2, /Saved/);
    const stamped = name && join(OUT, name);
    const py2 = stamped && existsSync(stamped) && pyhanko(stamped);
    if (py2) {
      const ts = py2.signatures.find((s) => s.type === '/DocTimeStamp');
      const sig = py2.signatures.find((s) => s.type !== '/DocTimeStamp');
      check(
        !!ts &&
          ts.intact &&
          ts.valid &&
          ts.coverage === 'ENTIRE_FILE' &&
          sig?.intact &&
          sig?.valid,
        'saved: pyHanko finds the document timestamp intact and valid over the whole file, and the signature intact',
        JSON.stringify(
          py2.signatures.map((s) => [
            s.type,
            s.intact,
            s.valid,
            s.coverage,
            s.time ?? '',
          ])
        )
      );
    } else
      check(
        !!stamped && existsSync(stamped),
        'saved: the timestamped document is on disk',
        stamped
      );
  } finally {
    await u.app.close();
  }
};

/* ------------------------------------------------------------------ */
/* Test PKI (OpenSSL) and an OCSP responder on this computer           */
/* ------------------------------------------------------------------ */

function run(cmd, args, input) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return res.status === 0 ? res.stdout : null;
}

/** A CA, IDs it issued (good and revoked, with an OCSP address on this
 *  computer), a login-only ID, and files in the shapes people have */
function makePki(dir) {
  if (existsSync(join(dir, 'good.pfx'))) return true;
  if (run('openssl', ['version']) === null) return false;
  const cnf = join(dir, 'ca.cnf');
  writeFileSync(
    cnf,
    [
      '[req]',
      'distinguished_name=dn',
      'prompt=no',
      '[dn]',
      'CN=Paperwing QA Root CA',
      'O=Paperwing QA',
      '[ca]',
      'basicConstraints=critical,CA:TRUE',
      'keyUsage=critical,keyCertSign,cRLSign',
      '[leaf]',
      'basicConstraints=CA:FALSE',
      'keyUsage=critical,digitalSignature,nonRepudiation',
      'extendedKeyUsage=emailProtection',
      'authorityInfoAccess=OCSP;URI:http://127.0.0.1:18890/',
      '[login]',
      'basicConstraints=CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=clientAuth',
    ].join('\n')
  );
  const f = (n) => join(dir, n);
  run('openssl', [
    'req',
    '-x509',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    f('ca.key'),
    '-out',
    f('ca.pem'),
    '-days',
    '30',
    '-config',
    cnf,
    '-extensions',
    'ca',
  ]);
  for (const [n, cn, ext] of [
    ['good', 'QA Good Signer', 'leaf'],
    ['revoked', 'QA Revoked Signer', 'leaf'],
    ['login', 'QA Login Only', 'login'],
  ]) {
    run('openssl', [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      f(`${n}.key`),
      '-out',
      f(`${n}.csr`),
      '-subj',
      `/CN=${cn}/O=Paperwing QA`,
    ]);
    run('openssl', [
      'x509',
      '-req',
      '-in',
      f(`${n}.csr`),
      '-CA',
      f('ca.pem'),
      '-CAkey',
      f('ca.key'),
      '-CAcreateserial',
      '-out',
      f(`${n}.crt`),
      '-days',
      '30',
      '-extfile',
      cnf,
      '-extensions',
      ext,
    ]);
    run('openssl', [
      'pkcs12',
      '-export',
      '-inkey',
      f(`${n}.key`),
      '-in',
      f(`${n}.crt`),
      '-certfile',
      f('ca.pem'),
      '-out',
      f(`${n}.pfx`),
      '-passout',
      'pass:qa-pass',
      '-name',
      cn,
    ]);
  }
  run('openssl', [
    'pkcs12',
    '-export',
    '-nokeys',
    '-in',
    f('good.crt'),
    '-out',
    f('nokey.pfx'),
    '-passout',
    'pass:qa-pass',
  ]);
  run('openssl', [
    'pkcs8',
    '-topk8',
    '-in',
    f('good.key'),
    '-out',
    f('enc-key.pem'),
    '-passout',
    'pass:qa-pass',
    '-v2',
    'aes-256-cbc',
  ]);
  const serial = run('openssl', [
    'x509',
    '-in',
    f('revoked.crt'),
    '-noout',
    '-serial',
  ]);
  writeFileSync(f('revoked.serial'), serial.trim().split('=')[1]);
  return existsSync(f('good.pfx'));
}

/** Answers OCSP requests for the test CA on 127.0.0.1:18890: the revoked
 *  ID's serial is revoked, the rest good */
async function ocspResponder(dir) {
  const pkijs = require(join(root, 'node_modules/pkijs'));
  const asn1js = require(join(root, 'node_modules/asn1js'));
  const der = (file) =>
    Uint8Array.from(
      Buffer.from(
        readFileSync(file, 'utf8')
          .replace(/-----[^-]+-----/g, '')
          .replace(/\s+/g, ''),
        'base64'
      )
    );
  const ca = pkijs.Certificate.fromBER(der(join(dir, 'ca.pem')));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der(join(dir, 'ca.key')),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const revoked = readFileSync(join(dir, 'revoked.serial'), 'utf8')
    .trim()
    .toUpperCase();
  const asked = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const ocspReq = pkijs.OCSPRequest.fromBER(
        new Uint8Array(Buffer.concat(chunks))
      );
      const certID = ocspReq.tbsRequest.requestList[0].reqCert;
      const serial = Buffer.from(certID.serialNumber.valueBlock.valueHexView)
        .toString('hex')
        .toUpperCase()
        .replace(/^(00)+/, '');
      const isRevoked = serial === revoked.replace(/^(00)+/, '');
      asked.push(isRevoked ? 'revoked' : 'good');
      const basic = new pkijs.BasicOCSPResponse();
      basic.tbsResponseData.responderID = ca.subject;
      basic.tbsResponseData.producedAt = new Date();
      basic.tbsResponseData.responses.push(
        new pkijs.SingleResponse({
          certID,
          certStatus: isRevoked
            ? new asn1js.Constructed({
                idBlock: { tagClass: 3, tagNumber: 1 },
                value: [
                  new asn1js.GeneralizedTime({
                    valueDate: new Date(Date.now() - 3600e3),
                  }),
                ],
              })
            : new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 } }),
          thisUpdate: new Date(),
        })
      );
      basic.certs = [ca];
      await basic.sign(key, 'SHA-256');
      const resp = new pkijs.OCSPResponse({
        responseStatus: new asn1js.Enumerated({ value: 0 }),
        responseBytes: new pkijs.ResponseBytes({
          responseType: '1.3.6.1.5.5.7.48.1.1',
          response: new asn1js.OctetString({
            valueHex: basic.toSchema().toBER(false),
          }),
        }),
      });
      res.writeHead(200, { 'Content-Type': 'application/ocsp-response' });
      res.end(Buffer.from(resp.toSchema().toBER(false)));
    } catch {
      res.writeHead(400);
      res.end();
    }
  });
  await new Promise((r) => server.listen(18890, '127.0.0.1', r));
  return { asked, close: () => server.close() };
}

/* ------------------------------------------------------------------ */

for (const name of ONLY) {
  const section = sections[name];
  if (!section) continue;
  console.log(`== ${name}`);
  try {
    await section();
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e?.stack ?? e}`);
  }
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
