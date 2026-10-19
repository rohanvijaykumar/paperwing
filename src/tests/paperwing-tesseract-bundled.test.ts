import { describe, expect, it, vi } from 'vitest';

vi.mock('tesseract.js', () => ({ default: { createWorker: vi.fn() } }));

import { buildTesseractWorkerOptions } from '../js/utils/tesseract-runtime';

// Paperwing bundles the OCR engine and English only
const env = {
  VITE_TESSERACT_WORKER_URL: 'https://app.test/engines/tesseract/worker.min.js',
  VITE_TESSERACT_CORE_URL: 'https://app.test/engines/tesseract/core',
  VITE_TESSERACT_LANG_URL: 'https://app.test/engines/tesseract/lang',
  VITE_TESSERACT_BUNDLED_LANGUAGES: 'eng',
};

describe('OCR with some languages bundled', () => {
  it('uses the bundled data when every language is bundled', () => {
    expect(buildTesseractWorkerOptions(undefined, env, 'eng')).toMatchObject({
      workerPath: env.VITE_TESSERACT_WORKER_URL,
      corePath: env.VITE_TESSERACT_CORE_URL,
      langPath: env.VITE_TESSERACT_LANG_URL,
    });
  });

  it('loads every language from the default source when one is not bundled', () => {
    const options = buildTesseractWorkerOptions(undefined, env, 'eng+fra');
    expect(options.workerPath).toBe(env.VITE_TESSERACT_WORKER_URL);
    expect(options.corePath).toBe(env.VITE_TESSERACT_CORE_URL);
    expect(options).not.toHaveProperty('langPath');
  });

  it('keeps the self-hosted language path when nothing says what is bundled', () => {
    const { VITE_TESSERACT_BUNDLED_LANGUAGES: _, ...all } = env;
    expect(buildTesseractWorkerOptions(undefined, all, 'fra').langPath).toBe(
      env.VITE_TESSERACT_LANG_URL
    );
  });
});

describe('OCR text-layer fonts with some families bundled', () => {
  it('takes bundled families from the app and the rest from their source', async () => {
    const { resolveFontUrl } = await import('../js/utils/font-loader');
    const fontEnv = {
      VITE_OCR_BUNDLED_FONTS: 'Noto Sans',
      VITE_OCR_BUNDLED_FONT_BASE_URL: '/engines/ocr-fonts/',
    };
    expect(resolveFontUrl('Noto Sans', fontEnv)).toBe(
      '/engines/ocr-fonts/NotoSans-Regular.ttf'
    );
    expect(resolveFontUrl('Noto Sans Hebrew', fontEnv)).toMatch(/^https:/);
  });
});
