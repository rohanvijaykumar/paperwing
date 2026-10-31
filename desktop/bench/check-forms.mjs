/**
 * Filling in a form in the real desktop app, as a person would, with the
 * mouse and keyboard only: clicking fields on the page and typing (in any
 * script), Tab to the next field (onto the next page), ticking a checkbox,
 * choosing a radio button, picking from a dropdown and a list, and the same
 * in the Form fields panel. Checks that the page and the panel always show
 * the same, that nothing is drawn again while filling in (no flicker), that
 * what's filled in is in the document (saved as a copy and read back), that
 * the tab counts as changed and Ctrl+Z takes the last change back. Then a
 * form with scripts: its message, a total worked out (into a read-only
 * field), a value refused, and scripts turned off.
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
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './harness.mjs';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');

const out = process.env.BENCH_TMP || tmpdir();
const dir = mkdtempSync(join(out, 'pw-forms-'));
execFileSync(process.execPath, [
  fileURLToPath(new URL('./make-form-fixture.mjs', import.meta.url)),
  dir,
]);

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

const app = await launch();
const { page } = app;
await page.setViewport({ width: 1440, height: 900 });
let nativeDialogs = 0;
page.on('dialog', (d) => {
  nativeDialogs++;
  d.dismiss().catch(() => {});
});

const open = (name) =>
  page.evaluate(
    (b64, name) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
      window.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
        })
      );
    },
    readFileSync(join(dir, name)).toString('base64'),
    name
  );

/** In the page: window.__field(name, nth), the field (pdf.js's control)
 *  named `name` */
const installField = () => {
  window.__field = (name, nth) =>
    [
      ...document
        .querySelector('embedpdf-container')
        .shadowRoot.querySelectorAll('.pwf-layer [data-element-id]'),
    ].filter((x) => x.getAttribute('name') === name)[nth ?? 0];
};
await page.evaluateOnNewDocument(installField);
await page.evaluate(installField);

/** The middle of a field on screen (scrolled into view) */
const centre = (name, nth = 0) =>
  page.evaluate(
    async (name, nth) => {
      const c = window.__field(name, nth);
      if (!c) return null;
      c.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 300));
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    name,
    nth
  );
const click = async (name, nth = 0) => {
  const at = await centre(name, nth);
  if (!at) throw new Error(`no field ${name}`);
  await page.mouse.click(at.x, at.y);
  await sleep(150);
};
/** What a field on the page shows */
const onPage = (name, nth = 0) =>
  page.evaluate(
    (name, nth) => {
      const c = window.__field(name, nth);
      if (!c) return null;
      if (c.type === 'checkbox' || c.type === 'radio') return c.checked;
      if (c instanceof HTMLSelectElement)
        return c.selectedIndex < 0 ? null : c.options[c.selectedIndex].text;
      return c.value;
    },
    name,
    nth
  );
const press = async (key, mods = []) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of mods.reverse()) await page.keyboard.up(m);
};

/** Counts the page drawings replaced from now on (flicker) */
const watchDrawing = () =>
  page.evaluate(() => {
    const root = document.querySelector('embedpdf-container').shadowRoot;
    window.__redraws = 0;
    window.__drawWatch?.disconnect();
    window.__drawWatch = new MutationObserver((records) => {
      for (const r of records) {
        if (r.target.closest?.('.pwf-layer')) continue;
        // A page's drawing replaced (not a tile drawn as it scrolls in)
        if (
          r.type === 'attributes' &&
          r.target instanceof HTMLImageElement &&
          r.oldValue
        )
          ((window.__redrawn ??= []).push(r.target.style.cssText.slice(0, 60)),
            window.__redraws++);
      }
    });
    window.__drawWatch.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src'],
      attributeOldValue: true,
    });
  });
const redraws = () => page.evaluate(() => window.__redraws);

/** What the document holds now: saved as a copy and read with pdf-lib */
const holds = async () => {
  const b64 = await page.evaluate(async () => {
    const v = window.__acro.viewer;
    const u = new Uint8Array(await v.exportBytes(v.current));
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000)
      s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const doc = await PDFDocument.load(Buffer.from(b64, 'base64'));
  const form = doc.getForm();
  const get = (fn) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  return {
    form,
    name: get(() => form.getTextField('full_name').getText()),
    email: get(() => form.getTextField('email').getText()),
    dob: get(() => form.getTextField('date_of_birth').getText()),
    events: get(() => form.getCheckBox('interest_events').isChecked()),
    newsletter: get(() => form.getCheckBox('interest_newsletter').isChecked()),
    updates: get(() =>
      form.getCheckBox('interest_product_updates').isChecked()
    ),
    plan: get(() => form.getRadioGroup('plan').getSelected()),
    country: get(() => form.getDropdown('country').getSelected()[0]),
    languages: get(() => form.getOptionList('languages').getSelected()[0]),
    reference: get(() => form.getTextField('reference').getText()),
  };
};

// ---- A form without scripts --------------------------------------------
await open('Form - blank.pdf');
const shown = await page
  .waitForFunction(
    () =>
      (document
        .querySelector('embedpdf-container')
        ?.shadowRoot?.querySelectorAll('.pwf-layer [data-element-id]').length ??
        0) > 10,
    { timeout: 30000 }
  )
  .then(() => true)
  .catch(() => false);
check(shown, 'the fields on page 1 are ready to fill in');
await sleep(1500);

const look = await page.evaluate(() => {
  const f = window.__field;
  const radio = f('plan', 0);
  const ref = f('reference');
  const option = f('country')?.options[1];
  const root = document.querySelector('embedpdf-container').shadowRoot;
  const pageImg =
    root.querySelector('.pwf-layer')?.parentElement?.firstElementChild;
  return {
    radioRound: radio && getComputedStyle(radio).borderRadius === '50%',
    refLocked: !!ref && (ref.disabled || ref.hidden),
    refDrawn: !!ref?.closest('section')?.querySelector('canvas[width]'),
    optionColor: option && getComputedStyle(option).color,
    pageImg: pageImg?.tagName,
  };
});
check(look.radioRound, 'radio buttons are round');
check(look.refLocked, "a read-only field can't be typed in");
check(look.refDrawn, "a read-only field shows the document's drawing of it");
check(
  look.optionColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(look.optionColor),
  `a dropdown's options show their text (${look.optionColor})`
);

await watchDrawing();
// Type into a field on the page, then Tab to the next and type there
await click('full_name');
await page.keyboard.type('Привет 世界 Ada');
await press('Tab');
await page.keyboard.type('ada@example.com');
await press('Tab');
await sleep(300);
check(
  (await onPage('full_name')) === 'Привет 世界 Ada' &&
    (await onPage('email')) === 'ada@example.com',
  'typing and Tab fill in the fields on the page'
);
await page.screenshot({
  path: join(out, 'forms-typed.png'),
  captureBeyondViewport: false,
});

// Tick, choose, pick (with the mouse; the dropdown with the keyboard,
// as its list is the system's)
await click('interest_events');
await click('plan', 2); // Team
const scroller = () =>
  page.evaluate(() => {
    const root = document.querySelector('embedpdf-container').shadowRoot;
    const s = [...root.querySelectorAll('div')].find(
      (d) =>
        d.scrollHeight > d.clientHeight + 50 &&
        /auto|scroll/.test(getComputedStyle(d).overflowY)
    );
    return s?.scrollTop ?? -1;
  });
await page.evaluate(() => window.__field('country').focus());
await page.keyboard.type('Jap');
await sleep(300);
check((await onPage('country')) === 'Japan', 'a dropdown option is picked');
// A list: click its option
const optionAt = await page.evaluate(async () => {
  const list = window.__field('languages');
  list.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 300));
  const o = [...list.options].find((x) => x.text === 'Hindi');
  const r = o.getBoundingClientRect();
  return { x: r.x + Math.min(30, r.width / 2), y: r.y + r.height / 2 };
});
const before = await scroller();
await page.mouse.click(optionAt.x, optionAt.y);
await sleep(400);
const after = await scroller();
check(
  (await onPage('languages')) === 'Hindi',
  'a list option is picked by clicking it'
);
check(
  before === after,
  `picking from a list doesn't scroll the page (${before} -> ${after})`
);
check(
  (await redraws()) === 0,
  `nothing is drawn again while filling in (${await redraws()} redraws ${await page.evaluate(() => JSON.stringify(window.__redrawn ?? []))})`
);

await sleep(800);
const v = await holds();
check(
  v.name === 'Привет 世界 Ada',
  `text in any script is in the document (${v.name})`
);
check(v.email === 'ada@example.com', `so is the next field's (${v.email})`);
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

// Ctrl+Z with the focus on the document: the last change goes back
const german = await page.evaluate(async () => {
  const list = window.__field('languages');
  const o = [...list.options].find((x) => x.text === 'German');
  const r = o.getBoundingClientRect();
  return { x: r.x + Math.min(30, r.width / 2), y: r.y + r.height / 2 };
});
await page.mouse.click(german.x, german.y);
await sleep(300);
await page.mouse.click(700, 120);
await press('z', ['Control']);
await sleep(1200);
check(
  (await onPage('languages')) === 'Hindi' &&
    (await onPage('country')) === 'Japan',
  `Ctrl+Z takes back the last change only (${await onPage('languages')})`
);
// Typing is one change: Ctrl+Z takes back all that was typed
await click('date_of_birth');
await page.keyboard.type('01/02/2003');
await page.mouse.click(700, 120);
await press('z', ['Control']);
await sleep(600);
check(
  (await onPage('date_of_birth')) === '',
  `Ctrl+Z takes back what was typed, at once (${await onPage('date_of_birth')})`
);

// The panel shows the same values, always; filling in there shows on the page
await page.evaluate(() =>
  document.querySelector('.rr-btn[aria-label="Form fields"]')?.click()
);
await sleep(800);
const compare = () =>
  page.evaluate(() => {
    const f = window.__field;
    const panel = (name, i) => {
      const c = [
        ...document.querySelectorAll(`#form-panel [data-field="${name}"]`),
      ];
      const x =
        i === undefined ? c[0] : c.find((e) => e.dataset.index === String(i));
      if (!x) return null;
      if (x.type === 'checkbox' || x.type === 'radio') return x.checked;
      if (x instanceof HTMLSelectElement)
        return x.selectedIndex <= 0 ? null : x.options[x.selectedIndex].text;
      return x.value;
    };
    const page = (name, nth) => {
      const c = f(name, nth);
      if (!c) return null;
      if (c.type === 'checkbox' || c.type === 'radio') return c.checked;
      if (c instanceof HTMLSelectElement)
        return c.selectedIndex < 0 ? null : c.options[c.selectedIndex].text;
      return c.value;
    };
    const diffs = [];
    for (const n of [
      'full_name',
      'email',
      'date_of_birth',
      'name_other_script',
      'interest_newsletter',
      'interest_product_updates',
      'interest_events',
      'country',
      'languages',
    ])
      if (panel(n) !== page(n) && !(panel(n) === '' && page(n) === null))
        diffs.push(`${n}: ${panel(n)} vs ${page(n)}`);
    for (const i of [0, 1, 2])
      if (panel('plan', i) !== page('plan', i))
        diffs.push(`plan ${i}: ${panel('plan', i)} vs ${page('plan', i)}`);
    return diffs;
  });
let diffs = await compare();
check(
  !diffs.length,
  `the panel shows what the page shows (${diffs.join('; ')})`
);
// In the panel: tick, choose, type (with the mouse and keyboard)
const panelClick = async (sel) => {
  const at = await page.evaluate((sel) => {
    const e = document.querySelector(sel);
    e?.scrollIntoView({ block: 'center' });
    const r = e?.getBoundingClientRect();
    return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel);
  if (!at) throw new Error(`no ${sel}`);
  await page.mouse.click(at.x, at.y);
  await sleep(250);
};
await panelClick('#form-panel [data-field="interest_product_updates"]');
await panelClick('#form-panel [data-field="plan"][data-index="0"]');
await panelClick('#form-panel [data-field="date_of_birth"]');
await page.keyboard.type('30/10/2026');
await press('Tab');
await sleep(500);
diffs = await compare();
check(
  !diffs.length,
  `filling in the panel shows on the page (${diffs.join('; ')})`
);
// And on the page: the panel follows
await click('interest_product_updates');
await click('plan', 1);
await sleep(300);
diffs = await compare();
check(
  !diffs.length,
  `filling in the page shows in the panel (${diffs.join('; ')})`
);
await sleep(800);
const w = await holds();
check(
  w.dob === '30/10/2026' && w.updates === false && w.plan === 'Personal',
  `and both are in the document (${w.dob}, ${w.updates}, ${w.plan})`
);
await page.screenshot({
  path: join(out, 'forms-panel.png'),
  captureBeyondViewport: false,
});

// Tab from the last field on page 1 goes on to page 2's first
await page.evaluate(() => window.__field('languages').focus());
await press('Tab');
const onTo = await page
  .waitForFunction(
    () =>
      document
        .querySelector('embedpdf-container')
        .shadowRoot.activeElement?.getAttribute('name') === 'comments',
    { timeout: 8000 }
  )
  .then(() => true)
  .catch(() => false);
check(onTo, "Tab goes on to the next page's fields");

// A list to pick several from: Ctrl+click two options
const optionOf = (list, text) =>
  page.evaluate(
    async (list, text) => {
      const l = window.__field(list);
      l.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 300));
      const o = [...l.options].find((x) => x.text === text);
      const r = o.getBoundingClientRect();
      return { x: r.x + Math.min(30, r.width / 2), y: r.y + r.height / 2 };
    },
    list,
    text
  );
const olives = await optionOf('toppings', 'Olives');
await page.mouse.click(olives.x, olives.y);
const onions = await optionOf('toppings', 'Onions');
await page.keyboard.down('Control');
await page.mouse.click(onions.x, onions.y);
await page.keyboard.up('Control');
await sleep(800);
const toppings = (await holds()).form.getOptionList('toppings').getSelected();
check(
  toppings.length === 2 &&
    toppings.includes('Olives') &&
    toppings.includes('Onions'),
  `several options picked from a list are all in the document (${toppings.join(', ')})`
);

/** A field's box on screen */
const box = (name) =>
  page.evaluate((name) => {
    const c = window.__field(name);
    c?.scrollIntoView({ block: 'center' });
    const r = c?.getBoundingClientRect();
    return r && { w: r.width, h: r.height };
  }, name);

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
const layersOff = () =>
  page.evaluate(() =>
    [
      ...document
        .querySelector('embedpdf-container')
        .shadowRoot.querySelectorAll('.pwf-layer'),
    ].map((l) => l.classList.contains('is-off'))
  );
check(
  (await layersOff()).every(Boolean),
  'fields are inactive while an annotation tool is in use'
);
await page.evaluate(() => {
  const v = window.__acro.viewer;
  v.setTool(v.current, null);
});
await sleep(600);
check(
  (await layersOff()).some((x) => !x),
  'and active again when selecting'
);

// Hand: the fields stay on the page and fill in, as in Acrobat (the viewer
// changes the pages' styles in Hand mode; the fields mustn't depend on them)
const setMode = (mode) =>
  page.evaluate((mode) => {
    const v = window.__acro.viewer;
    v.setMode(v.current, mode);
  }, mode);
await setMode('hand');
await sleep(800);
let modeLayers = await layersOff();
check(
  modeLayers.length > 0 && modeLayers.some((x) => !x),
  `with Hand, the fields stay on the page and take clicks (${modeLayers.length} page(s))`
);
await click('email');
await press('a', ['Control']);
await page.keyboard.type('hand@example.com');
await sleep(300);
check(
  (await onPage('email')) === 'hand@example.com',
  `a field fills in with Hand (${await onPage('email')})`
);
await setMode('marquee');
await sleep(800);
modeLayers = await layersOff();
check(
  modeLayers.length > 0 && modeLayers.every(Boolean),
  `while zooming to a rectangle, the fields stay shown but leave the clicks (${modeLayers.length} page(s))`
);
await setMode('select');
await sleep(600);

// ---- A form with scripts ----------------------------------------------
await open('Form - with scripts.pdf');

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
await sleep(800);
check(!(await page.$('.dlg[role="alertdialog"]')), 'the message shows once');
check(
  !(await page.$('#script-bar')),
  'no notice that scripts are not running: they run'
);

const fieldValue = async (name) => {
  const doc = (await holds()).form;
  try {
    return doc.getTextField(name).getText();
  } catch {
    return undefined;
  }
};
await click('quantity');
await page.keyboard.type('3');
await press('Tab');
await page.keyboard.type('12.50');
await press('Tab');
await sleep(500);
check(
  (await onPage('total')) === '$37.50',
  `a script works out the total and formats it (${await onPage('total')})`
);
check(
  (await fieldValue('total')) === '37.5',
  `saved, the read-only total keeps its number (${await fieldValue('total')})`
);
// Typed, then clicking the page (not another field): the total follows
await click('unit_price');
await press('a', ['Control']);
await page.keyboard.type('10');
const away = await centre('agree_terms');
await page.mouse.click(away.x + 300, away.y + 40);
await sleep(500);
check(
  (await onPage('total')) === '$30.00',
  `clicking away from a field commits it to the scripts (${await onPage('total')})`
);
// The panel goes through the scripts too
await page.evaluate(() =>
  document.querySelector('.rr-btn[aria-label="Form fields"]')?.click()
);
await sleep(600);
await panelClick('#form-panel [data-field="quantity"]');
await press('a', ['Control']);
await page.keyboard.type('5');
await press('Tab');
await sleep(500);
check(
  (await onPage('total')) === '$50.00' && (await onPage('quantity')) === '5',
  `filling in the panel runs the scripts (${await onPage('quantity')}, ${await onPage('total')})`
);

// A field that takes only numbers: letters are refused as they're typed,
// and what's typed is the person's change (Ctrl+Z takes it back)
await click('quantity');
await press('a', ['Control']);
await page.keyboard.type('4x');
await page.mouse.click(away.x + 300, away.y + 40);
await sleep(500);
check(
  (await onPage('quantity')) === '4' && (await onPage('total')) === '$40.00',
  `a numbers-only field refuses letters (${await onPage('quantity')}, ${await onPage('total')})`
);
await press('z', ['Control']);
await sleep(800);
check(
  (await onPage('quantity')) === '5' && (await onPage('total')) === '$50.00',
  `Ctrl+Z takes back what was typed in a field its scripts check (${await onPage('quantity')}, ${await onPage('total')})`
);

// A check refusing a value
await click('quantity');
await press('a', ['Control']);
await page.keyboard.type('-2');
await press('Tab');
check(
  (await message()) === 'The quantity cannot be negative.',
  "a script's check refuses a value, saying why"
);
await sleep(500);
check(
  (await onPage('quantity')) !== '-2',
  `the refused value isn't kept (${await onPage('quantity')})`
);
check(
  nativeDialogs === 0,
  `no browser dialogs, only the app's (${nativeDialogs})`
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
await press('Escape');
await sleep(2500);
const notice = await page.evaluate(
  () => document.querySelector('#script-bar')?.textContent ?? ''
);
check(
  turnedOff && /turned off/.test(notice),
  `with scripts off, a notice says so (${notice.slice(0, 60)})`
);
// and the fields still fill in
await click('quantity');
await press('a', ['Control']);
await page.keyboard.type('7');
await press('Tab');
await sleep(300);
check(
  (await onPage('quantity')) === '7',
  'with scripts off, the fields still fill in'
);
// (on again, for the next run)
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
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.pref-row')].find((r) =>
    r.textContent.includes('Run form scripts')
  );
  const box = row?.querySelector('input[type="checkbox"]');
  if (box && !box.checked) box.click();
});

// Home's preview of a form shows its fields. The file has nothing but a
// dark field; opened from disk, as only files on disk go in Recent.
await app.openFile(
  fileURLToPath(
    new URL('../../src/tests/fixtures/form-only.pdf', import.meta.url)
  )
);
await sleep(3000);
await page.evaluate(() => document.getElementById('home-btn').click());
let inked = -1;
for (let i = 0; i < 40 && inked < 0; i++) {
  await sleep(500);
  inked = await page.evaluate(async () => {
    const row = [...document.querySelectorAll('#view-home *')].find(
      (el) =>
        el.textContent.includes('form-only.pdf') &&
        el.querySelectorAll('img').length === 1
    );
    const img = row?.querySelector('img');
    if (!img?.complete || !img.naturalWidth) return -1;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let j = 0; j < px.length; j += 4)
      if (px[j] + px[j + 1] + px[j + 2] < 600) dark++;
    return dark / (px.length / 4);
  });
}
check(
  inked > 0.1,
  `Home's preview of a form shows its fields (${(inked * 100).toFixed(1)}% inked)`
);

await app.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
