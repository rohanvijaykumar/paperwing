// The desktop app's print dialog (src/acro/print.ts), with a stand-in for
// the desktop bridge: nothing is printed
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showPrintDialog, type PrintBridge } from '../acro/print';
import type { Printer, PrintResult } from '../acro/desktop';

const PDF_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d];
const PDF = new Uint8Array(PDF_BYTES);

/** Stand-in for the PDF.js preview. Like PDF.js, it takes over the buffer
 *  it's given (moves it to a worker), leaving that array empty. */
const preview = vi.hoisted(() => ({
  pages: 3,
  fail: false,
  given: [] as Uint8Array[],
  draw: [] as number[],
  closed: 0,
}));
vi.mock('../acro/print-preview', () => ({
  openPreview: async (data: Uint8Array) => {
    preview.given.push(data);
    structuredClone(data, { transfer: [data.buffer as ArrayBuffer] });
    if (preview.fail) throw new Error('unreadable');
    return {
      pages: preview.pages,
      draw: async (n: number) => {
        preview.draw.push(n);
      },
      close: () => {
        preview.closed++;
      },
    };
  },
}));

beforeEach(() => {
  preview.pages = 3;
  preview.fail = false;
  preview.given = [];
  preview.draw = [];
  preview.closed = 0;
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
    printPages: vi.fn(async () => result),
  } satisfies PrintBridge;
}

/** Opens the dialog and waits for it to show */
async function open(b: PrintBridge) {
  const notify = vi.fn();
  const done = showPrintDialog(b, PDF, 'Report.pdf', notify);
  await vi.waitFor(() => {
    if (!document.querySelector('.dlg[aria-label="Print"]')) throw new Error();
  });
  const button = (text: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>('.dlg-actions button'),
    ].find((b) => b.textContent === text)!;
  const field = <T extends HTMLElement>(label: string) =>
    document.querySelector<T>(`[aria-label="${label}"]`)!;
  return { done, notify, button, field };
}

describe('print dialog', () => {
  it('preselects the printer the desktop shell chose', async () => {
    const b = bridge([LABEL, OFFICE], 'label');
    const { field, button } = await open(b);
    const printer = field<HTMLSelectElement>('Printer');
    expect([...printer.options].map((o) => o.textContent)).toEqual([
      'Label printer',
      'Office laser',
    ]);
    expect(printer.value).toBe('label');
    button('Cancel').click();
  });

  it('prints to the chosen printer with the chosen options', async () => {
    const b = bridge([LABEL, OFFICE], 'office');
    const { done, notify, button, field } = await open(b);
    field<HTMLSelectElement>('Printer').value = 'label';
    field<HTMLInputElement>('Copies').value = '2';
    field<HTMLSelectElement>('Color').value = 'mono';
    field<HTMLSelectElement>('Two-sided').value = 'shortEdge';
    button('Print').click();
    expect(await done).toBe('printed');
    expect(b.printPages).toHaveBeenCalledWith(PDF, {
      destination: 'printer',
      printer: 'label',
      copies: 2,
      color: false,
      duplex: 'shortEdge',
    });
    expect(notify).toHaveBeenCalledWith('Sent Report.pdf to Label printer');
    expect(document.querySelector('.dlg-backdrop')).toBeNull();
  });

  it('cancel closes it without printing', async () => {
    const b = bridge([OFFICE], 'office');
    const { done, button } = await open(b);
    button('Cancel').click();
    expect(await done).toBe('cancelled');
    expect(b.printPages).not.toHaveBeenCalled();
    expect(document.querySelector('.dlg-backdrop')).toBeNull();
  });

  it('Escape cancels too', async () => {
    const b = bridge([OFFICE], 'office');
    const { done } = await open(b);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await done).toBe('cancelled');
    expect(b.printPages).not.toHaveBeenCalled();
  });

  it('Save as PDF saves the document, it does not print', async () => {
    const b = bridge([OFFICE], 'office', { ok: true });
    const { done, button, notify } = await open(b);
    button('Save as PDF…').click();
    expect(await done).toBe('saved');
    expect(b.printPages).toHaveBeenCalledTimes(1);
    expect(b.printPages).toHaveBeenCalledWith(PDF, {
      destination: 'pdf',
      name: 'Report.pdf',
    });
    expect(notify).toHaveBeenCalledWith('Saved Report.pdf as a PDF');
  });

  it('closing the save dialog keeps the print dialog open', async () => {
    const b = bridge([OFFICE], 'office', { ok: false, cancelled: true });
    const { button } = await open(b);
    button('Save as PDF…').click();
    await vi.waitFor(() => expect(b.printPages).toHaveBeenCalled());
    await vi.waitFor(() => expect(button('Print').disabled).toBe(false));
    expect(document.querySelector('.dlg[aria-label="Print"]')).not.toBeNull();
    button('Cancel').click();
  });

  it('no printers: says so, and only saving as PDF is offered', async () => {
    const b = bridge([], null);
    const { button, done } = await open(b);
    expect(document.querySelector('.pd-none')?.textContent).toMatch(
      /No printers found/
    );
    expect(document.querySelector('[aria-label="Printer"]')).toBeNull();
    expect(button('Print').disabled).toBe(true);
    expect(button('Save as PDF…').disabled).toBe(false);
    button('Cancel').click();
    expect(await done).toBe('cancelled');
  });

  it('refuses an invalid number of copies', async () => {
    const b = bridge([OFFICE], 'office');
    const { button, field } = await open(b);
    for (const bad of ['0', '1.5', '100', '']) {
      field<HTMLInputElement>('Copies').value = bad;
      button('Print').click();
      expect(document.querySelector('.pd-status')?.textContent).toMatch(
        /Copies must be/
      );
    }
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
      expect(document.querySelector('.pd-status')?.textContent).toBe(
        "Couldn't print: office is no longer available"
      )
    );
    expect(button('Print').disabled).toBe(false);
    button('Cancel').click();
  });
});

describe('print preview', () => {
  const count = () => document.querySelector('.pd-count')?.textContent;
  const nav = (label: string) =>
    document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

  it('shows the pages of the prepared document beside the printer', async () => {
    const b = bridge([OFFICE], 'office');
    const { button } = await open(b);
    expect(document.querySelector('.pd-preview canvas')).not.toBeNull();
    expect(
      document.querySelector('.pd-settings [aria-label="Printer"]')
    ).not.toBeNull();
    await vi.waitFor(() => expect(count()).toBe('Page 1 of 3'));
    // The document the dialog was given (a copy of it)
    expect(preview.given).toHaveLength(1);
    expect(preview.draw).toEqual([1]);
    expect(nav('Previous page').hidden).toBe(false);
    expect(nav('Previous page').disabled).toBe(true);
    nav('Next page').click();
    nav('Next page').click();
    expect(count()).toBe('Page 3 of 3');
    expect(nav('Next page').disabled).toBe(true);
    nav('Previous page').click();
    expect(count()).toBe('Page 2 of 3');
    expect(preview.draw).toEqual([1, 2, 3, 2]);
    button('Cancel').click();
    expect(preview.closed).toBe(1);
  });

  it('black and white shows the preview in grey, color in color', async () => {
    const { button, field } = await open(bridge([OFFICE], 'office'));
    const sheet = document.querySelector('.pd-sheet')!;
    const color = field<HTMLSelectElement>('Color');
    expect(sheet.classList.contains('is-mono')).toBe(false);
    color.value = 'mono';
    color.dispatchEvent(new Event('change'));
    expect(sheet.classList.contains('is-mono')).toBe(true);
    color.value = 'color';
    color.dispatchEvent(new Event('change'));
    expect(sheet.classList.contains('is-mono')).toBe(false);
    button('Cancel').click();
  });

  it('a one-page document: no page buttons', async () => {
    preview.pages = 1;
    const { button } = await open(bridge([OFFICE], 'office'));
    await vi.waitFor(() => expect(count()).toBe('1 page'));
    expect(nav('Previous page').hidden).toBe(true);
    expect(nav('Next page').hidden).toBe(true);
    button('Cancel').click();
  });

  it('drawing the preview does not change what is printed', async () => {
    const pdf = new Uint8Array(PDF_BYTES);
    const b = bridge([OFFICE], 'office');
    const done = showPrintDialog(b, pdf, 'Report.pdf', vi.fn());
    await vi.waitFor(() => expect(count()).toBe('Page 1 of 3'));
    // The preview took over its copy; the dialog's document is untouched
    expect(preview.given[0] === pdf).toBe(false);
    expect(preview.given[0].byteLength).toBe(0);
    expect([...pdf]).toEqual(PDF_BYTES);
    document
      .querySelector<HTMLButtonElement>('.dlg-actions .accent-btn')!
      .click();
    expect(await done).toBe('printed');
    const [sent] = b.printPages.mock.calls[0] as unknown as [Uint8Array];
    expect(sent).toBe(pdf);
    expect([...sent]).toEqual(PDF_BYTES);
  });

  it('Save as PDF saves the original bytes too', async () => {
    const pdf = new Uint8Array(PDF_BYTES);
    const b = bridge([OFFICE], 'office');
    const done = showPrintDialog(b, pdf, 'Report.pdf', vi.fn());
    await vi.waitFor(() => expect(count()).toBe('Page 1 of 3'));
    document
      .querySelector<HTMLButtonElement>('.dlg-actions .pill-btn')!
      .click();
    expect(await done).toBe('saved');
    const [sent] = b.printPages.mock.calls[0] as unknown as [Uint8Array];
    expect([...sent]).toEqual(PDF_BYTES);
  });

  it("a document PDF.js can't read still prints", async () => {
    preview.fail = true;
    const b = bridge([OFFICE], 'office');
    const { button, done } = await open(b);
    await vi.waitFor(() =>
      expect(count()).toBe('No preview for this document')
    );
    expect(nav('Next page').hidden).toBe(true);
    button('Print').click();
    expect(await done).toBe('printed');
    expect(b.printPages).toHaveBeenCalledWith(PDF, expect.anything());
    expect([...PDF]).toEqual(PDF_BYTES);
  });
});
