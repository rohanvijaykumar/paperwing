/**
 * Test PDFs for filling in forms:
 *   node bench/make-form-fixture.mjs <out-dir>
 * - Form - blank.pdf: every kind of field (text, multi-line, number, date,
 *   comb, checkboxes, radio buttons, a dropdown, a list, a list to pick
 *   several from, a read-only and a required field), over two pages
 * - Form - filled in.pdf: the same, already filled in (saved values must
 *   show)
 * - Form - with scripts.pdf: a pop-up when it opens, a total worked out by
 *   a script and shown as money (into a read-only field), a quantity that
 *   takes only numbers, and a check refusing negative quantities
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  rgb,
} = require('pdf-lib');

const [outDir] = process.argv.slice(2);
if (!outDir)
  throw new Error('usage: node bench/make-form-fixture.mjs <out-dir>');
mkdirSync(outDir, { recursive: true });

async function makeForm({ filled = false, scripts = false } = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Paperwing form test');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const form = pdf.getForm();

  const page1 = pdf.addPage([612, 792]);
  const page2 = pdf.addPage([612, 792]);
  const label = (page, text, x, y, size = 10) =>
    page.drawText(text, { x, y, size, font, color: rgb(0.2, 0.2, 0.2) });
  const heading = (page, text, y) =>
    page.drawText(text, { x: 50, y, size: 16, font: bold });

  heading(page1, 'Registration form (page 1 of 2)', 740);
  label(
    page1,
    'Fill in every field, save, close and reopen: everything should still be there.',
    50,
    722,
    9
  );

  // Text fields
  const text = (page, name, x, y, w, h = 20, opts = {}) => {
    const f = form.createTextField(name);
    if (opts.multiline) f.enableMultiline();
    if (opts.maxLength) f.setMaxLength(opts.maxLength);
    if (opts.comb) f.enableCombing();
    f.addToPage(page, { x, y, width: w, height: h, font });
    if (opts.readOnly) f.enableReadOnly();
    if (opts.required) f.enableRequired();
    return f;
  };
  label(page1, 'Full name (required)', 50, 690);
  const name = text(page1, 'full_name', 50, 664, 250, 20, { required: true });
  label(page1, 'Email', 320, 690);
  const email = text(page1, 'email', 320, 664, 240);
  label(page1, 'Date of birth (DD/MM/YYYY)', 50, 640);
  const dob = text(page1, 'date_of_birth', 50, 614, 150);
  label(page1, 'Postcode (5 boxes, one character each)', 320, 640);
  const zip = text(page1, 'postcode', 320, 614, 150, 20, {
    maxLength: 5,
    comb: true,
  });
  label(page1, 'Reference number (read-only)', 50, 590);
  const ref = text(page1, 'reference', 50, 564, 150);
  ref.setText('REF-2026-0042');
  ref.enableReadOnly();
  label(
    page1,
    'Name in another script (try Cyrillic, Chinese, Hindi)',
    320,
    590
  );
  const intl = text(page1, 'name_other_script', 320, 564, 240);

  // Checkboxes
  label(page1, 'Interests', 50, 530, 11);
  const boxes = ['Newsletter', 'Product updates', 'Events'].map((t, i) => {
    const c = form.createCheckBox(
      `interest_${t.toLowerCase().replace(/ /g, '_')}`
    );
    c.addToPage(page1, { x: 50, y: 504 - i * 24, width: 14, height: 14 });
    label(page1, t, 72, 507 - i * 24);
    return c;
  });

  // Radio buttons
  label(page1, 'Plan', 320, 530, 11);
  const plan = form.createRadioGroup('plan');
  ['Free', 'Personal', 'Team'].forEach((t, i) => {
    plan.addOptionToPage(t, page1, {
      x: 320,
      y: 504 - i * 24,
      width: 14,
      height: 14,
    });
    label(page1, t, 342, 507 - i * 24);
  });

  // Dropdown and list
  label(page1, 'Country (dropdown)', 50, 420);
  const country = form.createDropdown('country');
  country.addOptions([
    'United Kingdom',
    'United States',
    'India',
    'Germany',
    'Japan',
    'Brazil',
  ]);
  country.addToPage(page1, { x: 50, y: 394, width: 200, height: 20, font });
  label(page1, 'Languages (list, pick one)', 320, 420);
  const langs = form.createOptionList('languages');
  langs.addOptions(['English', 'Hindi', 'German', 'Japanese', 'Portuguese']);
  langs.addToPage(page1, { x: 320, y: 330, width: 200, height: 84, font });

  // Page 2
  heading(page2, 'Details (page 2 of 2)', 740);
  label(page2, 'Comments (several lines)', 50, 700);
  const comments = text(page2, 'comments', 50, 580, 510, 110, {
    multiline: true,
  });
  label(page2, 'Quantity', 50, 550);
  const qty = text(page2, 'quantity', 50, 524, 100);
  label(page2, 'Unit price', 170, 550);
  const price = text(page2, 'unit_price', 170, 524, 100);
  label(page2, scripts ? 'Total (calculated by a script)' : 'Total', 290, 550);
  const total = text(page2, 'total', 290, 524, 120);
  const agree = form.createCheckBox('agree_terms');
  agree.addToPage(page2, { x: 50, y: 480, width: 14, height: 14 });
  label(page2, 'I agree to the terms', 72, 483);
  label(page2, 'Signature (type your name)', 50, 450);
  const sign = text(page2, 'signature_name', 50, 424, 250);
  label(page2, 'Toppings (list, pick several with Ctrl)', 50, 395);
  const toppings = form.createOptionList('toppings');
  toppings.addOptions(['Cheese', 'Olives', 'Peppers', 'Mushrooms', 'Onions']);
  toppings.enableMultiselect();
  toppings.addToPage(page2, { x: 50, y: 305, width: 200, height: 84, font });

  if (filled) {
    name.setText('Alex Morgan');
    toppings.select(['Cheese', 'Peppers']);
    email.setText('alex@example.com');
    dob.setText('14/03/1990');
    zip.setText('40211');
    boxes[0].check();
    boxes[2].check();
    plan.select('Personal');
    country.select('India');
    langs.select('German');
    comments.setText(
      'Please call after 5 pm.\nThe second line of the comment.'
    );
    qty.setText('3');
    price.setText('12.50');
    total.setText('37.50');
    agree.check();
    sign.setText('Alex Morgan');
  }
  void intl;

  if (scripts) {
    // A calculated total, and a pop-up when the document opens
    const calc = pdf.context.obj({
      S: PDFName.of('JavaScript'),
      JS: PDFString.of(
        'event.value = (Number(this.getField("quantity").value) || 0) * (Number(this.getField("unit_price").value) || 0);'
      ),
    });
    // Shown as money ("$37.50"), kept as a number
    const money = pdf.context.obj({
      S: PDFName.of('JavaScript'),
      JS: PDFString.of('AFNumber_Format(2, 0, 0, 0, "$", true);'),
    });
    total.acroField.dict.set(
      PDFName.of('AA'),
      pdf.context.obj({ C: calc, F: money })
    );
    // Worked out, not typed (as on most forms)
    total.enableReadOnly();
    // No negative quantities
    const check = pdf.context.obj({
      S: PDFName.of('JavaScript'),
      JS: PDFString.of(
        'if (Number(event.value) < 0) { app.alert("The quantity cannot be negative."); event.rc = false; }'
      ),
    });
    // Only numbers can be typed (as on most forms), checked as they're typed
    const digits = pdf.context.obj({
      S: PDFName.of('JavaScript'),
      JS: PDFString.of('AFNumber_Keystroke(0, 0, 0, 0, "", true);'),
    });
    qty.acroField.dict.set(
      PDFName.of('AA'),
      pdf.context.obj({ V: check, K: digits })
    );
    const acro = form.acroForm.dict;
    acro.set(PDFName.of('CO'), pdf.context.obj([total.acroField.ref]));
    pdf.catalog.set(
      PDFName.of('OpenAction'),
      pdf.context.obj({
        S: PDFName.of('JavaScript'),
        JS: PDFString.of('app.alert("Welcome! This form uses scripts.");'),
      })
    );
  }
  return pdf.save({ updateFieldAppearances: true });
}

const files = {
  'Form - blank.pdf': await makeForm(),
  'Form - filled in.pdf': await makeForm({ filled: true }),
  'Form - with scripts.pdf': await makeForm({ scripts: true }),
};
for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(join(outDir, name), bytes);
  console.log(`${name}  ${(bytes.length / 1024).toFixed(1)} KB`);
}
