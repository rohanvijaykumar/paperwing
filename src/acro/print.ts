/**
 * The desktop app's print dialog: where the document the viewer's print
 * dialog prepared goes (a printer, or a PDF file) and how. The printing
 * itself happens in the desktop shell (desktop/print.cjs), the same way on
 * Windows, macOS and Linux.
 */
import type {
  DesktopBridge,
  Printer,
  PrintRequest,
  PrintResult,
} from './desktop';

export type PrintBridge = Required<
  Pick<DesktopBridge, 'printers' | 'printPages'>
>;

export type PrintOutcome = 'printed' | 'saved' | 'cancelled';

const MAX_COPIES = 99;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

function select(label: string, options: [string, string][]) {
  const s = el('select', { class: 'pref-select', 'aria-label': label });
  for (const [value, text] of options) s.append(el('option', { value }, text));
  return s;
}

const row = (label: string, control: HTMLElement) =>
  el(
    'label',
    { class: 'pref-row' },
    el('span', {}, el('b', {}, label)),
    control
  );

/** Shows the dialog; resolves once the document was printed or saved, or
 *  the dialog was closed */
export async function showPrintDialog(
  bridge: PrintBridge,
  pdf: Uint8Array,
  name: string,
  notify: (message: string) => void
): Promise<PrintOutcome> {
  const { printers, selected } = await bridge.printers().catch(() => ({
    printers: [] as Printer[],
    selected: null as string | null,
  }));

  return new Promise((resolve) => {
    const printer = select(
      'Printer',
      printers.map((p) => [p.name, p.displayName])
    );
    if (selected) printer.value = selected;
    const copies = el('input', {
      class: 'pref-select',
      type: 'number',
      min: '1',
      max: String(MAX_COPIES),
      value: '1',
      'aria-label': 'Copies',
    });
    const color = select('Color', [
      ['color', 'Color'],
      ['mono', 'Black and white'],
    ]);
    const duplex = select('Two-sided', [
      ['simplex', 'Off'],
      ['longEdge', 'Flip on long edge'],
      ['shortEdge', 'Flip on short edge'],
    ]);
    const status = el('p', { class: 'muted pd-status', role: 'status' });
    const btn = (cls: string, text: string, onClick: () => void) => {
      const b = el('button', { type: 'button', class: cls }, text);
      b.addEventListener('click', onClick);
      return b;
    };
    const cancelBtn = btn('quiet-btn', 'Cancel', () => finish('cancelled'));
    const pdfBtn = btn('pill-btn', 'Save as PDF…', () => void save());
    const printBtn = btn('accent-btn', 'Print', () => void print());
    const controls = [printer, copies, color, duplex, pdfBtn, printBtn];
    const busy = (on: boolean) => {
      controls.forEach((c) => (c.disabled = on));
      if (!on) printBtn.disabled = !printers.length;
    };

    const backdrop = el(
      'div',
      { class: 'dlg-backdrop' },
      el(
        'div',
        { class: 'dlg dlg-print', role: 'dialog', 'aria-label': 'Print' },
        el('div', { class: 'dlg-head' }, el('h2', {}, 'Print')),
        el(
          'div',
          { class: 'dlg-body prefs' },
          printers.length
            ? row('Printer', printer)
            : el(
                'p',
                { class: 'pd-none' },
                'No printers found. You can save the document as a PDF instead.'
              ),
          row('Copies', copies),
          row('Color', color),
          row('Two-sided', duplex),
          status,
          el('div', { class: 'dlg-actions' }, cancelBtn, pdfBtn, printBtn)
        )
      )
    );
    busy(false);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (!cancelBtn.disabled) finish('cancelled');
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    (printers.length ? printBtn : pdfBtn).focus();

    function finish(outcome: PrintOutcome) {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(outcome);
    }

    async function send(request: PrintRequest): Promise<PrintResult> {
      busy(true);
      cancelBtn.disabled = true;
      try {
        return await bridge.printPages(pdf, request);
      } catch (err) {
        return { ok: false, message: String((err as Error)?.message ?? err) };
      } finally {
        busy(false);
        cancelBtn.disabled = false;
      }
    }

    async function print() {
      const n = Number(copies.value);
      if (!Number.isInteger(n) || n < 1 || n > MAX_COPIES) {
        status.textContent = `Copies must be a whole number from 1 to ${MAX_COPIES}.`;
        copies.focus();
        return;
      }
      const chosen = printers.find((p) => p.name === printer.value);
      if (!chosen) return;
      status.textContent = 'Printing…';
      const result = await send({
        destination: 'printer',
        printer: chosen.name,
        copies: n,
        color: color.value === 'color',
        duplex: duplex.value as 'simplex' | 'longEdge' | 'shortEdge',
      });
      if (result.ok) {
        notify(`Sent ${name} to ${chosen.displayName}`);
        finish('printed');
      } else {
        status.textContent = `Couldn't print: ${result.message ?? 'printing failed'}`;
      }
    }

    async function save() {
      status.textContent = '';
      const result = await send({ destination: 'pdf', name });
      if (result.ok) {
        notify(`Saved ${name} as a PDF`);
        finish('saved');
      } else if (!result.cancelled) {
        status.textContent = `Couldn't save: ${result.message ?? 'saving failed'}`;
      }
    }
  });
}
