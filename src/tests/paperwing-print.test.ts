// The desktop app's print dialog (src/acro/print.ts), with a stand-in for
// the desktop bridge: nothing is printed. The sheets are really laid out
// (print-layout.ts); only the preview's drawing is stood in for.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { showPrintDialog, type PrintBridge } from '../acro/print';
import type { Printer, PrintRequest, PrintResult } from '../acro/desktop';

/** Stand-in for the PDF.js preview. Like PDF.js, it takes over the buffer
 *  it's given (moves it to a worker), leaving that array empty. */
const preview = vi.hoisted(() => ({
  fail: false,
  given: [] as Uint8Array[],
  draw: [] as number[],
  closed: 0,
}));
vi.mock('../acro/print-preview', async () => {
  const { PDFDocument } = await import('pdf-lib');
  return {
    openPreview: async (data: Uint8Array) => {
      const pages = (await PDFDocument.load(data)).getPageCount();
      preview.given.push(data);
      structuredClone(data, { transfer: [data.buffer as ArrayBuffer] });
      if (preview.fail) throw new Error('unreadable');
      return {
        pages,
        draw: async (n: number) => {
          preview.draw.push(n);
        },
        close: () => {
          preview.closed++;
        },
      };
    },
  };
});

/** A document of `n` Letter pages */
async function docOf(n: number) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([612, 792]);
  return doc.save();
}

beforeEach(() => {
  preview.fail = false;
  preview.given = [];
  preview.draw = [];
  preview.closed = 0;
  localStorage.clear();
});
const OFFICE: Printer = {
  name: 'office',
  displayName: 'Office laser',
  isDefault: true,
};
const LABEL: Printer = {
  name: 'label',
  displayName: 'Label printer',
  isDefault: false,
};

function bridge(
  printers: Printer[],
  selected: string | null,
  result: PrintResult = { ok: true }
) {
  return {
    printers: vi.fn(async () => ({ printers, selected })),
    printPages: vi.fn(
      async (_pdf: Uint8Array, _request: PrintRequest) => result
    ),
  } satisfies PrintBridge;
}

const count = () => document.querySelector('.pd-count')?.textContent;
const status = () => document.querySelector('.pd-status')?.textContent;

/** Opens the dialog on a document of `pages` pages and waits for its
 *  preview */
async function open(b: ReturnType<typeof bridge>, pages = 3, current = 1) {
  const notify = vi.fn();
  const src = await docOf(pages);
  const source = vi.fn(async () => src);
  const done = showPrintDialog(
    b,
    { name: 'Report.pdf', current, source },
    notify
  );
  await vi.waitFor(() => expect(count()).toMatch(/^(Sheet 1 of \d+|1 sheet)$/));
  const button = (text: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>('.dlg-actions button'),
    ].find((b) => b.textContent === text)!;
  // (jsdom's selectors trip over "&" in a label: compared directly)
  const field = <T extends HTMLElement>(label: string) =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '.dlg select, .dlg input, .dlg button'
      ),
    ].find((e) => e.getAttribute('aria-label') === label) as T;
  const change = (label: string, value: string | boolean) => {
    const f = field<HTMLInputElement | HTMLSelectElement>(label);
    if (typeof value === 'boolean') (f as HTMLInputElement).checked = value;
    else f.value = value;
    f.dispatchEvent(new Event('change'));
  };
  const handling = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.pd-seg-btn')]
      .find((b) => b.textContent === text)!
      .click();
  /** The sheets last sent to the bridge */
  const sentSheets = async () => {
    const [pdf] = b.printPages.mock.calls.at(-1) as unknown as [Uint8Array];
    return PDFDocument.load(pdf);
  };
  return { done, notify, button, field, change, handling, source, sentSheets };
}

describe('print dialog', () => {
  it('preselects the printer the desktop shell chose', async () => {
    const b = bridge([LABEL, OFFICE], 'office');
    const { field, button } = await open(b);
    expect(field<HTMLSelectElement>('Printer').value).toBe('office');
    expect(
      [...field<HTMLSelectElement>('Printer').options].map((o) => o.text)
    ).toEqual(['Label printer', 'Office laser']);
    button('Cancel').click();
  });

  it('prints the laid-out sheets with the chosen options, at the paper size', async () => {
    const b = bridge([LABEL, OFFICE], 'office');
    const { done, notify, button, field, change, sentSheets } = await open(b);
    field<HTMLSelectElement>('Printer').value = 'label';
    field<HTMLInputElement>('Copies').value = '2';
    change('Color', 'mono');
    field<HTMLSelectElement>('Two-sided').value = 'shortEdge';
    change('Paper size', 'a4');
    await vi.waitFor(() => expect(button('Print').disabled).toBe(false));
    button('Print').click();
    expect(await done).toBe('printed');
    expect(b.printPages.mock.calls.at(-1)?.[1]).toEqual({
      destination: 'printer',
      printer: 'label',
      copies: 2,
      color: false,
      duplex: 'shortEdge',
      paper: { width: 595.28, height: 841.89 },
      landscape: false,
    });
    const sheets = await sentSheets();
    expect(sheets.getPageCount()).toBe(3);
    expect(Math.round(sheets.getPage(0).getSize().width)).toBe(595);
    expect(notify).toHaveBeenCalledWith('Sent Report.pdf to Label printer');
    expect(document.querySelector('.dlg-backdrop')).toBeNull();
  });

  it('cancel closes it without printing', async () => {
    const b = bridge([OFFICE], 'office');
    const { done, button } = await open(b);
    button('Cancel').click();
    expect(await done).toBe('cancelled');
    expect(b.printPages).not.toHaveBeenCalled();
    expect(preview.closed).toBe(1);
  });

  it('Escape cancels too', async () => {
    const b = bridge([OFFICE], 'office');
    const { done } = await open(b);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await done).toBe('cancelled');
  });

  it('Save as PDF saves the laid-out sheets, it does not print', async () => {
    const b = bridge([OFFICE], 'office');
    const { done, button, handling, sentSheets } = await open(b, 4);
    handling('Multiple');
    await vi.waitFor(() => expect(count()).toBe('Sheet 1 of 2'));
    button('Save as PDF…').click();
    expect(await done).toBe('saved');
    expect(b.printPages.mock.calls.at(-1)?.[1]).toEqual({
      destination: 'pdf',
      name: 'Report.pdf',
    });
    expect((await sentSheets()).getPageCount()).toBe(2);
  });

  it('no printers: says so, and only saving as PDF is offered', async () => {
    const b = bridge([], null);
    const { button } = await open(b);
    expect(document.querySelector('.pd-none')?.textContent).toMatch(
      /No printers found/
    );
    expect(button('Print').disabled).toBe(true);
    expect(button('Save as PDF…').disabled).toBe(false);
    button('Cancel').click();
  });

  it('refuses an invalid number of copies', async () => {
    const b = bridge([OFFICE], 'office');
    const { button, field } = await open(b);
    field<HTMLInputElement>('Copies').value = '0';
    button('Print').click();
    expect(status()).toMatch(/Copies must be a whole number/);
    expect(b.printPages).not.toHaveBeenCalled();
    button('Cancel').click();
  });

  it('a printer that went away: the reason shows and the dialog stays', async () => {
    const b = bridge([OFFICE], 'office', {
      ok: false,
      error: 'printer-missing',
      message: 'office is no longer available',
    });
    const { button } = await open(b);
    button('Print').click();
    await vi.waitFor(() =>
      expect(status()).toBe("Couldn't print: office is no longer available")
    );
    expect(document.querySelector('.dlg-backdrop')).not.toBeNull();
    button('Cancel').click();
  });
});

describe('pages to print', () => {
  it('current page, a range, odd or even, reversed', async () => {
    const b = bridge([OFFICE], 'office');
    const { field, change, button } = await open(b, 6, 4);
    change('Current page (4)', true);
    await vi.waitFor(() => expect(count()).toBe('1 sheet'));
    const range = field<HTMLInputElement>('Pages to print');
    range.value = '2-5';
    range.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(count()).toBe('Sheet 1 of 4'));
    change('Odd or even pages', 'even');
    await vi.waitFor(() => expect(count()).toBe('Sheet 1 of 2'));
    change('Reverse pages', true);
    await vi.waitFor(() => expect(button('Print').disabled).toBe(false));
    button('Cancel').click();
  });

  it('a range it cannot read says why, and nothing prints', async () => {
    const b = bridge([OFFICE], 'office');
    const { field, button } = await open(b, 3);
    const range = field<HTMLInputElement>('Pages to print');
    range.value = '2-9';
    range.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(status()).toBe('Pages go from 1 to 3'));
    expect(button('Print').disabled).toBe(true);
    button('Cancel').click();
  });
});

describe('page sizing & handling', () => {
  it('custom scale shows its percentage', async () => {
    const b = bridge([OFFICE], 'office');
    const { field, change, button } = await open(b);
    const scaleRow = field('Scale (percent)').closest('label')!;
    expect(scaleRow.hidden).toBe(true);
    change('Size', 'custom');
    expect(scaleRow.hidden).toBe(false);
    button('Cancel').click();
  });

  it('several pages to a sheet', async () => {
    const b = bridge([OFFICE], 'office');
    const { change, handling, button, sentSheets } = await open(b, 9);
    handling('Multiple');
    change('Pages per sheet', '4');
    await vi.waitFor(() => expect(count()).toBe('Sheet 1 of 3'));
    button('Print').click();
    expect((await sentSheets()).getPageCount()).toBe(3);
  });

  it('a booklet prints on both sides, flipped on the short edge, on landscape sheets', async () => {
    const b = bridge([OFFICE], 'office');
    const { handling, field, button } = await open(b, 8);
    handling('Booklet');
    expect(field<HTMLSelectElement>('Two-sided').value).toBe('shortEdge');
    await vi.waitFor(() => expect(count()).toBe('Sheet 1 of 4'));
    button('Print').click();
    await vi.waitFor(() => expect(b.printPages).toHaveBeenCalled());
    expect(b.printPages.mock.calls[0][1]).toMatchObject({
      duplex: 'shortEdge',
      landscape: true,
    });
  });
});

describe('comments & forms', () => {
  it('"Document" prints without comments', async () => {
    const b = bridge([OFFICE], 'office');
    const { change, source, button } = await open(b);
    expect(source).toHaveBeenCalledWith(true);
    change('Comments & forms', 'document');
    await vi.waitFor(() => expect(source).toHaveBeenCalledWith(false));
    button('Cancel').click();
  });
});

describe('remembered between prints', () => {
  it('paper, sizing and color come back; the pages chosen do not', async () => {
    const b = bridge([OFFICE], 'office');
    const first = await open(b, 6);
    first.change('Paper size', 'a5');
    first.change('Color', 'mono');
    first.handling('Multiple');
    first.change('Current page (1)', true);
    await vi.waitFor(() => expect(first.button('Print').disabled).toBe(false));
    first.button('Print').click();
    await first.done;

    const second = await open(b, 6);
    expect(second.field<HTMLSelectElement>('Paper size').value).toBe('a5');
    expect(second.field<HTMLSelectElement>('Color').value).toBe('mono');
    expect(document.querySelector('.pd-seg-btn.is-on')?.textContent).toBe(
      'Multiple'
    );
    expect(second.field<HTMLInputElement>('All').checked).toBe(true);
    second.button('Cancel').click();
  });
});

describe('print preview', () => {
  const nav = (label: string) =>
    document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

  it('shows the sheets that will print', async () => {
    const b = bridge([OFFICE], 'office');
    const { button } = await open(b);
    expect(document.querySelector('.pd-preview canvas')).not.toBeNull();
    expect(count()).toBe('Sheet 1 of 3');
    expect(nav('Previous sheet').disabled).toBe(true);
    nav('Next sheet').click();
    nav('Next sheet').click();
    expect(count()).toBe('Sheet 3 of 3');
    expect(nav('Next sheet').disabled).toBe(true);
    button('Cancel').click();
  });

  it('black and white shows the preview in grey, color in color', async () => {
    const { button, change } = await open(bridge([OFFICE], 'office'));
    const sheet = document.querySelector('.pd-sheet')!;
    expect(sheet.classList.contains('is-mono')).toBe(false);
    change('Color', 'mono');
    expect(sheet.classList.contains('is-mono')).toBe(true);
    change('Color', 'color');
    expect(sheet.classList.contains('is-mono')).toBe(false);
    button('Cancel').click();
  });

  it('drawing the preview does not change what is printed', async () => {
    const b = bridge([OFFICE], 'office');
    const { button } = await open(b);
    button('Print').click();
    await vi.waitFor(() => expect(b.printPages).toHaveBeenCalled());
    const [sent] = b.printPages.mock.calls[0] as unknown as [Uint8Array];
    // The preview took over its copy; the printer's sheets are whole
    expect(preview.given.at(-1)!.byteLength).toBe(0);
    expect(sent.byteLength).toBeGreaterThan(0);
    expect((await PDFDocument.load(sent)).getPageCount()).toBe(3);
  });

  it('without a preview, it still prints', async () => {
    preview.fail = true;
    const b = bridge([OFFICE], 'office');
    const notify = vi.fn();
    const src = await docOf(2);
    const done = showPrintDialog(
      b,
      { name: 'Report.pdf', current: 1, source: async () => src },
      notify
    );
    await vi.waitFor(() =>
      expect(count()).toBe('No preview for this document')
    );
    document
      .querySelector<HTMLButtonElement>('.dlg-actions .accent-btn')!
      .click();
    expect(await done).toBe('printed');
  });
});
