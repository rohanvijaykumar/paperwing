/**
 * Filling in a form in the real desktop app, as a person would: clicking
 * fields on the page and typing (in any script), Tab to the next field,
 * ticking a checkbox, choosing a radio button and options. Then checks what
 * the document holds (saved as a copy and read back), that the tab counts
 * as changed, that Ctrl+Z takes the last change back, that read-only fields
 * can't be typed in, and that the Form fields panel shows the same values.
 *
 *   node bench/check-forms.mjs
 *
 * Pass/fail; screenshots go to $BENCH_TMP/forms-*.png.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launch, sleep } from './harness.mjs';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');

const out = process.env.BENCH_TMP || tmpdir();
const dir = mkdtempSync(join(out, 'pw-forms-'));
execFileSync(process.execPath, [
  new URL('./make-form-fixture.mjs', import.meta.url).pathname.replace(
    /^\/(\w:)/,
    '$1'
  ),
  dir,
]);
const FORM = join(dir, 'Form - blank.pdf');

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

const app = await launch();
const { page } = app;
await page.setViewport({ width: 1440, height: 900 });
page.on('dialog', (d) => d.dismiss().catch(() => {}));

// Open the form
await page.evaluate((b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(
    new File([bytes], 'Form - blank.pdf', { type: 'application/pdf' })
  );
  window.dispatchEvent(
    new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
  );
}, readFileSync(FORM).toString('base64'));

/** Runs in the page: the viewer's shadow root */
const fields = () =>
  page.evaluate(() => {
    const root = document.querySelector('embedpdf-container')?.shadowRoot;
    return root
      ? [...root.querySelectorAll('.pwf-layer .pwf-field')].map((c) => ({
          label: c.getAttribute('aria-label'),
          cls: c.className,
        }))
      : [];
  });
const shown = await page
  .waitForFunction(
    () =>
      (document
        .querySelector('embedpdf-container')
        ?.shadowRoot?.querySelectorAll('.pwf-layer .pwf-field').length ?? 0) >
      10,
    { timeout: 30000 }
  )
  .then(() => true)
  .catch(() => false);
check(shown, 'the fields on page 1 are ready to fill in');
const list = await fields();
check(
  !list.some((f) => f.label === 'reference'),
  "a read-only field can't be typed in (it gets no control)"
);

/** The middle of a field's control, on screen */
const centre = (label, nth = 0) =>
  page.evaluate(
    (label, nth) => {
      const root = document.querySelector('embedpdf-container').shadowRoot;
      const c = [...root.querySelectorAll('.pwf-layer .pwf-field')].filter(
        (x) => x.getAttribute('aria-label') === label
      )[nth];
      if (!c) return null;
      c.scrollIntoView({ block: 'center' });
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    label,
    nth
  );
const click = async (label, nth = 0) => {
  const at = await centre(label, nth);
  if (!at) throw new Error(`no field ${label}`);
  await sleep(150);
  const again = await centre(label, nth);
  await page.mouse.click(again.x, again.y);
};

// Type into a field on the page, then Tab to the next and type there
await click('full_name');
await sleep(200);
await page.keyboard.type('Привет 世界 Rohan');
await page.keyboard.press('Tab');
await sleep(200);
await page.keyboard.type('rohan@example.com');
await page.keyboard.press('Tab'); // commits the email
await sleep(400);
await page.screenshot({
  path: join(out, 'forms-typed.png'),
  captureBeyondViewport: false,
});

// Tick, choose, pick
await click('interest_events');
await sleep(300);
await click('plan', 2); // Team
await sleep(300);
const choose = (label, value) =>
  page.evaluate(
    (label, value) => {
      const root = document.querySelector('embedpdf-container').shadowRoot;
      const sel = [...root.querySelectorAll('.pwf-layer select')].find(
        (x) => x.getAttribute('aria-label') === label
      );
      if (!sel) return false;
      sel.value = value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    label,
    value
  );
check(await choose('country', 'Japan'), 'the dropdown has its options');
await sleep(400);
check(await choose('languages', 'Hindi'), 'the list has its options');
await sleep(1200);

/** What the document holds now: saved as a copy and read with pdf-lib */
const holds = async () => {
  const b64 = await page.evaluate(async () => {
    const reg = await document.querySelector('embedpdf-container').registry;
    const id = reg
      .getPlugin('document-manager')
      .provides()
      .getActiveDocumentId();
    const buf = await reg
      .getPlugin('export')
      .provides()
      .forDocument(id)
      .saveAsCopy()
      .toPromise();
    let s = '';
    const u = new Uint8Array(buf);
    for (let i = 0; i < u.length; i += 0x8000)
      s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const doc = await PDFDocument.load(Buffer.from(b64, 'base64'));
  const form = doc.getForm();
  return {
    name: form.getTextField('full_name').getText(),
    email: form.getTextField('email').getText(),
    events: form.getCheckBox('interest_events').isChecked(),
    newsletter: form.getCheckBox('interest_newsletter').isChecked(),
    plan: form.getRadioGroup('plan').getSelected(),
    country: form.getDropdown('country').getSelected()[0],
    languages: form.getOptionList('languages').getSelected()[0],
    reference: form.getTextField('reference').getText(),
  };
};
const v = await holds();
check(v.name === 'Привет 世界 Rohan', `text in any script goes in (${v.name})`);
check(
  v.email === 'rohan@example.com',
  `Tab went to the next field (${v.email})`
);
check(
  v.events === true && v.newsletter === false,
  'a checkbox ticks (only that one)'
);
check(v.plan === 'Team', `a radio button is chosen (${v.plan})`);
check(v.country === 'Japan', `a dropdown option is chosen (${v.country})`);
check(v.languages === 'Hindi', `a list option is chosen (${v.languages})`);
check(v.reference === 'REF-2026-0042', 'the read-only field is as it was');

const dirty = await page.evaluate(
  () => !!document.querySelector('#tabs .tab.is-active.is-dirty')
);
check(dirty, 'the document counts as changed (unsaved)');

// Ctrl+Z with the focus on the document: the last change goes back (the
// list from German to Hindi)
check(await choose('languages', 'German'), 'a list option is chosen again');
await sleep(1200);
await page.mouse.click(700, 120);
await page.keyboard.down('Control');
await page.keyboard.press('z');
await page.keyboard.up('Control');
await sleep(1500);
const undone = await holds();
check(
  undone.languages === 'Hindi' && undone.country === 'Japan',
  `Ctrl+Z takes back the last change only (${undone.languages})`
);

// The panel shows the same values, and filling in there shows on the page
await page.evaluate(() =>
  document.querySelector('.rr-btn[aria-label="Form fields"]')?.click()
);
await sleep(800);
const panel = await page.evaluate(() => {
  const name = document.querySelector('#form-panel [data-field="full_name"]');
  const team = document.querySelector(
    '#form-panel [data-field="plan"][data-index="2"]'
  );
  return { name: name?.value, team: team?.checked };
});
check(
  panel.name === 'Привет 世界 Rohan' && panel.team === true,
  'the Form fields panel shows the values'
);
await page.evaluate(() => {
  const dob = document.querySelector(
    '#form-panel [data-field="date_of_birth"]'
  );
  dob.value = '30/10/2026';
  dob.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(1200);
check((await holds()).name && (await holds()).email, 'values stay put');
const dob = await page.evaluate(async () => {
  const reg = await document.querySelector('embedpdf-container').registry;
  const dm = reg.getPlugin('document-manager').provides();
  const doc = dm.getActiveDocument();
  const annos = await reg
    .getEngine()
    .getPageAnnotations(doc, doc.pages[0])
    .toPromise();
  return annos.find((a) => a.field?.name === 'date_of_birth')?.field.value;
});
check(dob === '30/10/2026', `filling in the panel fills in the page (${dob})`);
await page.screenshot({
  path: join(out, 'forms-panel.png'),
  captureBeyondViewport: false,
});

// Tab from the last field on page 1 goes on to page 2's first
await page.evaluate(() => {
  const root = document.querySelector('embedpdf-container').shadowRoot;
  [...root.querySelectorAll('.pwf-layer select')]
    .find((x) => x.getAttribute('aria-label') === 'languages')
    ?.focus();
});
await page.keyboard.press('Tab');
const onTo = await page
  .waitForFunction(
    () =>
      document
        .querySelector('embedpdf-container')
        .shadowRoot.activeElement?.getAttribute('aria-label') === 'comments',
    { timeout: 8000 }
  )
  .then(() => true)
  .catch(() => false);
check(onTo, "Tab goes on to the next page's fields");

/** A field's control's box on screen */
const box = (label) =>
  page.evaluate((label) => {
    const root = document.querySelector('embedpdf-container').shadowRoot;
    const c = [...root.querySelectorAll('.pwf-layer .pwf-field')].find(
      (x) => x.getAttribute('aria-label') === label
    );
    c?.scrollIntoView({ block: 'center' });
    const r = c?.getBoundingClientRect();
    return r && { w: r.width, h: r.height };
  }, label);

// Turning the pages: the fields turn with them
const flat = await box('full_name');
await page.evaluate(() =>
  document.querySelector('.rr-btn[aria-label="Rotate view"]')?.click()
);
await sleep(1500);
const turned = await box('full_name');
check(
  flat && turned && flat.w > flat.h && turned.h > turned.w,
  `fields turn with the page (${JSON.stringify(flat)} -> ${JSON.stringify(turned)})`
);
await page.screenshot({
  path: join(out, 'forms-rotated.png'),
  captureBeyondViewport: false,
});
for (let i = 0; i < 3; i++) {
  await page.evaluate(() =>
    document.querySelector('.rr-btn[aria-label="Rotate view"]')?.click()
  );
  await sleep(500);
}

// While an annotation tool is in use, the fields are left alone
await page.evaluate(() => {
  const v = window.__acro.viewer;
  v.setTool(v.current, 'freeText');
});
await sleep(600);
const off = await page.evaluate(() =>
  [
    ...document
      .querySelector('embedpdf-container')
      .shadowRoot.querySelectorAll('.pwf-layer'),
  ].every((l) => l.classList.contains('is-off'))
);
check(off, 'fields are inactive while an annotation tool is in use');
await page.evaluate(() => {
  const v = window.__acro.viewer;
  v.setTool(v.current, null);
});
await sleep(600);
const on = await page.evaluate(() =>
  [
    ...document
      .querySelector('embedpdf-container')
      .shadowRoot.querySelectorAll('.pwf-layer'),
  ].some((l) => !l.classList.contains('is-off'))
);
check(on, 'and active again when selecting');

// ---- A form with scripts ----------------------------------------------
await page.evaluate(
  (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(
      new File([bytes], 'Form - with scripts.pdf', { type: 'application/pdf' })
    );
    window.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      })
    );
  },
  readFileSync(join(dir, 'Form - with scripts.pdf')).toString('base64')
);

/** The message dialog's text, once one shows (and closes it) */
const message = async (timeout = 15000) => {
  const text = await page
    .waitForFunction(
      () =>
        document.querySelector('.dlg[role="alertdialog"] .dlg-body p')
          ?.textContent,
      { timeout }
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  await page.evaluate(() =>
    document.querySelector('.dlg[role="alertdialog"] .accent-btn')?.click()
  );
  await sleep(300);
  return text;
};
check(
  (await message()) === 'Welcome! This form uses scripts.',
  "its script's message when it opens shows as the app's dialog"
);
check(
  !(await page.$('#script-bar')),
  'no notice that scripts are not running: they run'
);

await click('quantity');
await sleep(200);
await page.keyboard.type('3');
await page.keyboard.press('Tab');
await sleep(200);
await page.keyboard.type('12.50');
await page.keyboard.press('Tab');
await sleep(1500);
const fieldValue = (name) =>
  page.evaluate(async (name) => {
    const reg = await document.querySelector('embedpdf-container').registry;
    const doc = reg
      .getPlugin('document-manager')
      .provides()
      .getActiveDocument();
    for (const p of doc.pages) {
      const annos = await reg
        .getEngine()
        .getPageAnnotations(doc, p)
        .toPromise();
      const w = annos.find((a) => a.field?.name === name);
      if (w) return w.field.value;
    }
    return null;
  }, name);
check(
  (await fieldValue('total')) === '$37.50',
  `a script works out the total and formats it (${await fieldValue('total')})`
);
const savedTotal = await (async () => {
  const b64 = await page.evaluate(async () => {
    const v = window.__acro.viewer;
    const u = new Uint8Array(await v.exportBytes(v.current));
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000)
      s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const doc = await PDFDocument.load(Buffer.from(b64, 'base64'));
  return doc.getForm().getTextField('total').getText();
})();
check(
  savedTotal === '37.5',
  `saved, the total keeps its number (${savedTotal})`
);

// A check refusing a value
await click('quantity');
await sleep(200);
await page.keyboard.down('Control');
await page.keyboard.press('a');
await page.keyboard.up('Control');
await page.keyboard.type('-2');
await page.keyboard.press('Tab');
check(
  (await message()) === 'The quantity cannot be negative.',
  "a script's check refuses a value, saying why"
);
await sleep(800);
check(
  (await fieldValue('quantity')) !== '-2',
  `the refused value isn't kept (${await fieldValue('quantity')})`
);

// Scripts turned off: the notice says so
await page.evaluate(() => {
  document.querySelector('#menu-btn')?.click();
});
await sleep(300);
await page.evaluate(() =>
  [...document.querySelectorAll('.menu-item')]
    .find((m) => m.textContent.trim().startsWith('Preferences'))
    ?.click()
);
await sleep(500);
const turnedOff = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.pref-row')].find((r) =>
    r.textContent.includes('Run form scripts')
  );
  const box = row?.querySelector('input[type="checkbox"]');
  if (!box) return false;
  if (box.checked) box.click();
  return !box.checked;
});
await page.keyboard.press('Escape');
await sleep(2500);
const notice = await page.evaluate(
  () => document.querySelector('#script-bar')?.textContent ?? ''
);
check(
  turnedOff && /turned off/.test(notice),
  `with scripts off, a notice says so (${notice.slice(0, 60)})`
);

await app.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
