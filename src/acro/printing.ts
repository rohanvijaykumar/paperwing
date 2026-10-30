import { desktop } from './desktop';

/** The PDF iframe print route requires a browser PDF plug-in that Electron
 * does not provide. Send prepared pages through Electron's native printing
 * API instead. The prepared PDF already includes page ranges/annotations. */
export function installDesktopPrinting(registry: any) {
  if (desktop?.platform !== 'win32' || !desktop.printPages) return;
  const plugin = registry.getPlugin('print');
  // This bundled viewer has no custom print-handler option. Route the
  // ready event here: its built-in iframe consumer otherwise reports success
  // before the native job finishes. It can mount after registry readiness.
  if (typeof plugin?.printReady$?.emit !== 'function')
    throw new Error(
      'The desktop printing adapter does not support this viewer version.'
    );
  plugin.printReady$.emit = async ({ buffer, task }: any) => {
    try {
      task.progress({
        stage: 'rendering',
        message: 'Preparing pages for Windows...',
      });
      const pages = await renderPrintPages(buffer, (page, total) =>
        task.progress({
          stage: 'rendering',
          message: `Preparing page ${page} of ${total}...`,
        })
      );
      task.progress({ stage: 'printing', message: 'Opening print preview...' });
      const result = await desktop!.printPages!(pages);
      if (!result.success && !/cancel/i.test(result.reason || ''))
        throw new Error(
          result.reason || 'Windows could not print this document.'
        );
      task.resolve(buffer);
    } catch (error) {
      task.fail({ code: 'PrintFailed', message: String(error) });
    }
  };
}

export async function renderPrintPages(
  buffer: ArrayBuffer,
  progress?: (page: number, total: number) => void
) {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
  GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).href;
  const pdf = await getDocument({
    data: new Uint8Array(buffer).slice(),
    isEvalSupported: false,
  }).promise;
  const pages: { image: string; width: number; height: number }[] = [];
  let bytes = 0;
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      progress?.(i, pdf.numPages);
      const page = await pdf.getPage(i);
      const points = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 300 / 72 });
      if (viewport.width * viewport.height > 50000000)
        throw new Error('Page is too large to print.');
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({
          canvas,
          canvasContext: canvas.getContext('2d')!,
          viewport,
          background: 'white',
        }).promise;
        const image = canvas.toDataURL('image/png');
        bytes += image.length;
        if (bytes > 256 * 1024 * 1024)
          throw new Error(
            'Print job is too large. Please print a smaller page range.'
          );
        pages.push({ image, width: points.width, height: points.height });
      } finally {
        canvas.width = canvas.height = 0;
        page.cleanup();
      }
    }
    return pages;
  } finally {
    await pdf.destroy();
  }
}
