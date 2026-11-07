/**
 * What scanning does after the PDF is made, with the engines the tools
 * use: Recognize text (Tesseract, as Scan & OCR's Select a file does) and
 * Make PDF/A compliant (Ghostscript, as the PDF to PDF/A tool does). Loaded
 * only when they're used.
 */

/** A searchable PDF: the scanned pages with their text under them */
export async function recognizeText(
  pdf: Uint8Array,
  language: string,
  progress: (text: string) => void
): Promise<Uint8Array> {
  // (PDF.js's worker, which OCR reads the pages with)
  await import('../js/utils/setup-pdf-worker.js');
  const { performOcr } = await import('../js/utils/ocr.js');
  const result = await performOcr(pdf, {
    language,
    // Pages drawn at twice their size for Tesseract: scans are already sharp
    resolution: 2,
    binarize: false,
    whitelist: '',
    onProgress: (status, value) =>
      progress(
        /recogni/i.test(status) ? `${Math.round(value * 100)}%` : status
      ),
  });
  return result.pdfBytes;
}

/** The PDF made PDF/A-2b compliant */
export async function makePdfA(
  pdf: Uint8Array,
  progress: (text: string) => void
): Promise<Uint8Array> {
  const { convertToPdfA } = await import('../js/utils/ghostscript-loader.js');
  return convertToPdfA(pdf, 'PDF/A-2b', progress);
}
