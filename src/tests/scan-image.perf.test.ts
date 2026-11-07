// @vitest-environment node
/**
 * Timing for the scan clean-up on a Letter page at 300 dpi. Opt-in (slow):
 * SCAN_PERF=1 npx vitest run src/tests/scan-image.perf.test.ts
 */
import { describe, it } from 'vitest';
import { processPage, type ScanImageSettings } from '../acro/scan-image';
import { encodePage } from '../acro/scan-pdf';
import { addNoise, drawText, rgba, textLayout } from './helpers/scan-synth';

describe.runIf(process.env.SCAN_PERF)('scan clean-up timing', () => {
  const img = rgba(2550, 3300, 300, [238, 236, 228]);
  drawText(img, textLayout(2550, 3300).inkAt, { deg: 1.7, ink: [30, 30, 40] });
  addNoise(img, 6);

  const runs: Array<[string, Partial<ScanImageSettings>]> = [
    ['defaults (auto color, deskew)', {}],
    ['color, deskew', { colorMode: 'color' }],
    [
      'gray, deskew, background medium',
      { colorMode: 'gray', backgroundRemoval: 'medium' },
    ],
    ['bw, deskew, despeckle', { colorMode: 'bw', despeckle: true }],
    [
      'color, everything on',
      {
        colorMode: 'color',
        edgeShadowRemoval: true,
        descreen: true,
        autoCrop: true,
        backgroundRemoval: 'medium',
        textSharpening: 'medium',
        despeckle: true,
        removeBlank: { enabled: true, sensitivity: 50 },
      },
    ],
  ];
  for (const [name, settings] of runs)
    it(
      name,
      async () => {
        await processPage(img, settings); // warm-up
        const t0 = performance.now();
        const page = await processPage(img, settings);
        const t1 = performance.now();
        let enc = '';
        if (page.kind === 'bw') {
          const e = await encodePage(page, {
            compression: 'jpeg',
            quality: 0.7,
          });
          enc = `, G4 ${Math.round(performance.now() - t1)} ms (${(e.bytes.length / 1024).toFixed(0)} KB)`;
        } else if (page.kind === 'gray') {
          const e = await encodePage(page, {
            compression: 'flate',
            quality: 0.7,
          });
          enc = `, Flate ${Math.round(performance.now() - t1)} ms (${(e.bytes.length / 1024).toFixed(0)} KB)`;
        }
        process.stderr.write(
          `${name}: ${Math.round(t1 - t0)} ms -> ${page.kind}${enc}\n`
        );
      },
      60000
    );
});
