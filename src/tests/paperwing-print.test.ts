// The desktop app's print dialog (src/acro/print.ts), with a stand-in for
// the desktop bridge: nothing is printed
import { describe, expect, it, vi } from 'vitest';
import { showPrintDialog, type PrintBridge } from '../acro/print';
import type { Printer, PrintResult } from '../acro/desktop';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
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
