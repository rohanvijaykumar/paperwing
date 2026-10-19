import Tesseract from 'tesseract.js';
import {
  assertTesseractLanguagesAvailable,
  TESSERACT_AVAILABLE_LANGUAGES_ENV_KEY,
} from './tesseract-language-availability.js';

const TESSERACT_ENV_KEYS = [
  'VITE_TESSERACT_WORKER_URL',
  'VITE_TESSERACT_CORE_URL',
  'VITE_TESSERACT_LANG_URL',
] as const;

const TESSERACT_RUNTIME_ENV_KEYS = [
  ...TESSERACT_ENV_KEYS,
  TESSERACT_AVAILABLE_LANGUAGES_ENV_KEY,
  'VITE_TESSERACT_BUNDLED_LANGUAGES',
] as const;

type TesseractRuntimeEnvKey = (typeof TESSERACT_RUNTIME_ENV_KEYS)[number];

export type TesseractAssetEnv = Partial<
  Pick<ImportMetaEnv, TesseractRuntimeEnvKey>
>;

export interface TesseractAssetConfig {
  workerPath?: string;
  corePath?: string;
  langPath?: string;
}

export type TesseractLoggerMessage = Tesseract.LoggerMessage;
export type TesseractWorkerOptions = Partial<Tesseract.WorkerOptions>;
export type TesseractWorker = Tesseract.Worker;

function getDefaultTesseractAssetEnv(): TesseractAssetEnv {
  return import.meta.env;
}

// Paperwing: a path ("/engines/tesseract/core") is made absolute: the
// worker, which loads the core and the languages, may run from a blob URL
// that a path doesn't resolve against
function absolute(url: string): string {
  return url.startsWith('/') && typeof location !== 'undefined'
    ? location.origin + url
    : url;
}

function normalizeDirectoryUrl(url?: string): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  return absolute(trimmed.replace(/\/+$/, ''));
}

function normalizeFileUrl(url?: string): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  return absolute(trimmed.replace(/\/+$/, ''));
}

export function resolveTesseractAssetConfig(
  env: TesseractAssetEnv = getDefaultTesseractAssetEnv()
): TesseractAssetConfig {
  return {
    workerPath: normalizeFileUrl(env.VITE_TESSERACT_WORKER_URL),
    corePath: normalizeDirectoryUrl(env.VITE_TESSERACT_CORE_URL),
    langPath: normalizeDirectoryUrl(env.VITE_TESSERACT_LANG_URL),
  };
}

export function hasConfiguredTesseractOverrides(
  config: TesseractAssetConfig = resolveTesseractAssetConfig()
): boolean {
  return Boolean(config.workerPath || config.corePath || config.langPath);
}

export function hasCompleteTesseractOverrides(
  config: TesseractAssetConfig = resolveTesseractAssetConfig()
): boolean {
  return Boolean(config.workerPath && config.corePath && config.langPath);
}

export function getIncompleteTesseractOverrideKeys(
  config: TesseractAssetConfig = resolveTesseractAssetConfig()
): Array<(typeof TESSERACT_ENV_KEYS)[number]> {
  if (!hasConfiguredTesseractOverrides(config)) {
    return [];
  }

  return TESSERACT_ENV_KEYS.filter((key) => {
    switch (key) {
      case 'VITE_TESSERACT_WORKER_URL':
        return !config.workerPath;
      case 'VITE_TESSERACT_CORE_URL':
        return !config.corePath;
      case 'VITE_TESSERACT_LANG_URL':
        return !config.langPath;
    }
  });
}

export function buildTesseractWorkerOptions(
  logger?: TesseractWorkerOptions['logger'],
  env: TesseractAssetEnv = getDefaultTesseractAssetEnv(),
  language?: string
): TesseractWorkerOptions {
  const config = resolveTesseractAssetConfig(env);

  if (!hasConfiguredTesseractOverrides(config)) {
    return logger ? { logger } : {};
  }

  if (!hasCompleteTesseractOverrides(config)) {
    const missing = getIncompleteTesseractOverrideKeys(config).join(', ');
    throw new Error(
      `Self-hosted OCR assets are partially configured. Set ${missing} together with the other Tesseract asset URLs.`
    );
  }

  // Paperwing: when only some languages are self-hosted
  // (VITE_TESSERACT_BUNDLED_LANGUAGES), a run that needs another one loads
  // all its languages from Tesseract's default CDN instead
  const bundled = env.VITE_TESSERACT_BUNDLED_LANGUAGES?.split(/[\s,+]+/)
    .map((code) => code.trim())
    .filter(Boolean);
  const useLangPath =
    !bundled?.length ||
    !language ||
    language
      .split('+')
      .map((code) => code.trim())
      .filter(Boolean)
      .every((code) => bundled.includes(code));

  return {
    ...(logger ? { logger } : {}),
    workerPath: config.workerPath,
    corePath: config.corePath,
    ...(useLangPath ? { langPath: config.langPath } : {}),
    gzip: true,
  };
}

export async function createConfiguredTesseractWorker(
  language: string,
  oem: Tesseract.OEM,
  logger?: TesseractWorkerOptions['logger'],
  env: TesseractAssetEnv = getDefaultTesseractAssetEnv()
): Promise<TesseractWorker> {
  assertTesseractLanguagesAvailable(language, env);

  return Tesseract.createWorker(
    language,
    oem,
    buildTesseractWorkerOptions(logger, env, language)
  );
}
