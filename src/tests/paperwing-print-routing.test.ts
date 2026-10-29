// Printing from tool pages Paperwing hosts: Markdown to PDF's Export PDF
// (src/reskin/export-pdf.ts) and print() in a tool page (src/reskin/reskin.ts).
// The shell is simulated: in jsdom the page is its own parent, so what the
// page posts to its parent is what the shell would receive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_ORIGIN } from '../reskin/origins';

const host = vi.hoisted(() => ({ origin: null as string | null }));
vi.mock('../reskin/origins', async (original) => ({
  ...(await original<typeof import('../reskin/origins')>()),
  shellOrigin: () => host.origin,
}));
vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn() },
}));
vi.mock('../js/i18n/i18n', () => ({ applyTranslations: vi.fn() }));

// (Made with this page's Uint8Array: TextEncoder's comes from another realm,
// and a real message's data is always recreated in the page's.)
const PDF_FROM_DESKTOP = Uint8Array.from(
  new TextEncoder().encode('%PDF-1.7\n%desktop\n%%EOF')
);

let posted: { message: any; origin: string }[];
let nativePrint: ReturnType<typeof vi.fn>;

/** The simulated shell: records what it's sent; asked to make a PDF from a
 *  page, it answers like the desktop app's workspace does */
function simulateShell(answer: Uint8Array | null = PDF_FROM_DESKTOP) {
  vi.spyOn(window, 'postMessage').mockImplementation(((
    message: any,
    origin: string
  ) => {
    posted.push({ message, origin });
    if (message?.type === 'acro:html-to-pdf')
      setTimeout(() =>
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'acro:html-to-pdf', id: message.id, data: answer },
            origin: SHELL_ORIGIN,
            source: window,
          })
        )
      );
  }) as typeof window.postMessage);
}

const sent = (type: string) =>
  posted.filter((p) => p.message?.type === type).map((p) => p.message);

beforeEach(() => {
  vi.resetModules();
  posted = [];
  nativePrint = vi.fn();
  window.print = nativePrint as unknown as typeof window.print;
});

afterEach(() => {
  vi.restoreAllMocks();
  host.origin = null;
});

async function openEditor() {
  const { MarkdownEditor } = await import('../js/utils/markdown-editor');
  const container = document.createElement('div');
  document.body.append(container);
  new MarkdownEditor(container, { initialContent: '# Quarterly notes\n\nHi' });
  return {
    exportButton: document.getElementById('mdExport') as HTMLButtonElement,
    textarea: document.getElementById('mdTextarea') as HTMLTextAreaElement,
  };
}

async function pdfHeader(blob: Blob) {
  const text = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob.slice(0, 5));
  });
  return text;
}

describe('Markdown to PDF inside Paperwing (desktop app)', () => {
  beforeEach(() => {
    host.origin = SHELL_ORIGIN;
    simulateShell();
  });

  it('Export PDF makes a PDF and hands it to the workspace, without print()', async () => {
    const { exportButton } = await openEditor();
    exportButton.click();
    await vi.waitFor(() => expect(sent('acro:download')).toHaveLength(1));
    expect(nativePrint).not.toHaveBeenCalled();

    // The print-styled page went to the shell to be laid out
    const [request] = sent('acro:html-to-pdf');
    expect(request.html).toMatch(/^<!DOCTYPE html>/);
    expect(request.html).toContain('Quarterly notes</h1>');
    expect(request.html).toContain('@page');
    expect(posted.every((p) => p.origin === SHELL_ORIGIN)).toBe(true);

    const [download] = sent('acro:download');
    expect(download.name).toBe('Markdown.pdf');
    expect(download.blob).toBeInstanceOf(Blob);
    expect(download.blob.type).toBe('application/pdf');
    expect(await pdfHeader(download.blob)).toBe('%PDF-');
  });

  it('Ctrl+S / Cmd+S export the same way', async () => {
    const { textarea } = await openEditor();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      const before = sent('acro:download').length;
      const e = new KeyboardEvent('keydown', {
        key: 's',
        bubbles: true,
        cancelable: true,
        ...mod,
      });
      textarea.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
      await vi.waitFor(() =>
        expect(sent('acro:download')).toHaveLength(before + 1)
      );
    }
    expect(nativePrint).not.toHaveBeenCalled();
    expect(sent('acro:print-document')).toHaveLength(0);
  });

  it('a second press while one export is running is ignored', async () => {
    const { exportButton } = await openEditor();
    exportButton.click();
    exportButton.click();
    await vi.waitFor(() => expect(sent('acro:download')).toHaveLength(1));
    expect(sent('acro:html-to-pdf')).toHaveLength(1);
  });
});

describe('Markdown to PDF on its own page', () => {
  it('Export PDF still prints the page (Save as PDF in the print dialog)', async () => {
    host.origin = null;
    simulateShell();
    const { exportButton } = await openEditor();
    exportButton.click();
    expect(nativePrint).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(0);
  });
});

describe('print() in a tool page Paperwing hosts', () => {
  it('asks the workspace to print its document instead', async () => {
    host.origin = window.location.origin;
    simulateShell();
    await import('../reskin/reskin');
    expect(window.print).not.toBe(nativePrint);
    window.print();
    expect(nativePrint).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      message: { type: 'acro:print-document' },
      origin: window.location.origin,
    });
  });

  it('a standalone tool page keeps the browser print()', async () => {
    host.origin = null;
    simulateShell();
    await import('../reskin/reskin');
    window.print();
    expect(nativePrint).toHaveBeenCalledTimes(1);
    expect(sent('acro:print-document')).toHaveLength(0);
  });
});
