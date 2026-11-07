/**
 * Promise-based client for the scan clean-up worker (scan-image.worker.ts):
 * the scan dialog and Enhance scanned pages call this, and the pixels are
 * processed off the main thread. The orientation check (Tesseract OSD from
 * the OCR engine) stays on this side: the worker asks for it when it needs
 * it, and the answer goes back.
 */
import type {
  OrientationDetector,
  OrientationResult,
  ProcessedPage,
  Rect,
  ScanImage,
  ScanImageSettings,
} from './scan-image';
import type { EncodeOptions, PreparedScan, ScanFile } from './scan-pdf';

export type ScanWorkerRequest =
  | {
      id: number;
      type: 'process';
      image: ScanImage;
      settings: Partial<ScanImageSettings>;
      orient: boolean;
    }
  | {
      id: number;
      type: 'prepare';
      input: ScanImage | ScanFile;
      settings: Partial<ScanImageSettings>;
      encode: EncodeOptions;
      orient: boolean;
    }
  | { id: number; type: 'detect'; input: ScanImage | ScanFile }
  | { type: 'orientation'; ask: number; result: OrientationResult | null };

export type ScanWorkerReply =
  | { id: number; type: 'result'; value: unknown }
  | { id: number; type: 'error'; message: string }
  | { type: 'orient'; ask: number; image: ScanImage };

/** What the client needs of a Worker (a fake one in tests) */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: ScanWorkerReply }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

export interface ScanImageClientOptions {
  detectOrientation?: OrientationDetector;
  createWorker?: () => WorkerLike;
}

export interface CallOptions {
  /** hand the pixel buffer to the worker instead of copying it (faster;
   *  the caller's array is unusable afterwards) */
  transfer?: boolean;
}

export interface ScanImageClient {
  processPage(
    image: ScanImage,
    settings: Partial<ScanImageSettings>,
    options?: CallOptions
  ): Promise<ProcessedPage>;
  /** process and encode for the PDF; a scanner file is decoded in the
   *  worker too */
  preparePage(
    input: ScanImage | ScanFile,
    settings: Partial<ScanImageSettings>,
    encode: EncodeOptions,
    options?: CallOptions
  ): Promise<PreparedScan>;
  detectDocument(
    input: ScanImage | ScanFile,
    options?: CallOptions
  ): Promise<Rect>;
  /** stops the worker; calls still waiting fail */
  dispose(): void;
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

function defaultWorker(): WorkerLike {
  return new Worker(new URL('./scan-image.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

function bufferOf(input: ScanImage | ScanFile): ArrayBufferLike {
  return 'bytes' in input ? input.bytes.buffer : input.data.buffer;
}

export function createScanImageClient(
  options: ScanImageClientOptions = {}
): ScanImageClient {
  const make = options.createWorker ?? defaultWorker;
  let worker: WorkerLike | null = null;
  let nextId = 1;
  const jobs = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  const fail = (w: WorkerLike, error: Error) => {
    w.terminate();
    if (worker === w) worker = null;
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
  };

  const get = (): WorkerLike => {
    if (worker) return worker;
    const w = make();
    w.onmessage = ({ data }) => {
      if (data.type === 'orient') {
        void answerOrientation(w, data.ask, data.image);
        return;
      }
      const job = jobs.get(data.id);
      if (!job) return;
      jobs.delete(data.id);
      if (data.type === 'error') job.reject(new Error(data.message));
      else job.resolve(data.value);
    };
    w.onerror = (event) =>
      fail(w, new Error(event?.message || 'The scan worker stopped'));
    worker = w;
    return w;
  };

  async function answerOrientation(
    w: WorkerLike,
    ask: number,
    image: ScanImage
  ) {
    let result: OrientationResult | null = null;
    try {
      result = (await options.detectOrientation?.(image)) ?? null;
    } catch {
      // can't tell: the page keeps its orientation
    }
    w.postMessage({
      type: 'orientation',
      ask,
      result,
    } satisfies ScanWorkerRequest);
  }

  function call<T>(
    message: WithoutId<Extract<ScanWorkerRequest, { id: number }>>,
    input: ScanImage | ScanFile,
    opts: CallOptions | undefined
  ): Promise<T> {
    const w = get();
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      jobs.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const buffer = bufferOf(input);
      w.postMessage(
        { ...message, id },
        opts?.transfer && buffer instanceof ArrayBuffer ? [buffer] : []
      );
    });
  }

  const orient = !!options.detectOrientation;
  return {
    processPage: (image, settings, opts) =>
      call({ type: 'process', image, settings, orient }, image, opts),
    preparePage: (input, settings, encode, opts) =>
      call({ type: 'prepare', input, settings, encode, orient }, input, opts),
    detectDocument: (input, opts) =>
      call({ type: 'detect', input }, input, opts),
    dispose() {
      if (worker) fail(worker, new Error('The scan worker was stopped'));
    },
  };
}
