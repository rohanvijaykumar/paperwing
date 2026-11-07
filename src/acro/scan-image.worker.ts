/**
 * The scan clean-up worker: processPage, encoding and detectDocument off
 * the main thread. Messages are described in scan-image-client.ts.
 */
import {
  detectDocument,
  processPage,
  type OrientationResult,
  type ProcessedPage,
  type ScanImage,
} from './scan-image';
import { decodeScanFile, encodePage, summary, type ScanFile } from './scan-pdf';
import type { ScanWorkerReply, ScanWorkerRequest } from './scan-image-client';

type Post = (message: ScanWorkerReply, transfer: Transferable[]) => void;

function isFile(input: ScanImage | ScanFile): input is ScanFile {
  return 'bytes' in input;
}

function transferables(value: unknown): Transferable[] {
  const page = value as Partial<ProcessedPage> & {
    encoded?: { bytes: Uint8Array };
  };
  const out: ArrayBufferLike[] = [];
  if (page?.encoded) out.push(page.encoded.bytes.buffer);
  if (page && 'image' in page && page.image) out.push(page.image.data.buffer);
  if (page && 'bitmap' in page && page.bitmap)
    out.push(page.bitmap.data.buffer);
  return out.filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);
}

/** The message handler, apart from `self` so tests can run it in-process */
export function createHandler(post: Post) {
  const asks = new Map<number, (r: OrientationResult | null) => void>();
  let nextAsk = 1;
  const askOrientation = (image: ScanImage) =>
    new Promise<OrientationResult | null>((resolve) => {
      const ask = nextAsk++;
      asks.set(ask, resolve);
      // a copy: the page's pixels are still being worked on here
      post(
        { type: 'orient', ask, image: { ...image, data: image.data.slice() } },
        []
      );
    });

  return async (msg: ScanWorkerRequest) => {
    if (msg.type === 'orientation') {
      // (only an answer to a question this worker asked)
      const answer = Number.isInteger(msg.ask) ? asks.get(msg.ask) : undefined;
      if (typeof answer !== 'function') return;
      asks.delete(msg.ask);
      answer(msg.result);
      return;
    }
    try {
      let value: unknown;
      const deps =
        'orient' in msg && msg.orient
          ? { detectOrientation: askOrientation }
          : {};
      if (msg.type === 'process') {
        value = await processPage(msg.image, msg.settings, deps);
      } else {
        const image = isFile(msg.input)
          ? await decodeScanFile(msg.input)
          : msg.input;
        if (msg.type === 'detect') value = detectDocument(image);
        else {
          const page = await processPage(image, msg.settings, deps);
          value = summary(page, await encodePage(page, msg.encode));
        }
      }
      post({ id: msg.id, type: 'result', value }, transferables(value));
    } catch (err) {
      post(
        {
          id: msg.id,
          type: 'error',
          message: (err as Error)?.message ?? String(err),
        },
        []
      );
    }
  };
}

declare const WorkerGlobalScope: { new (): unknown } | undefined;
if (
  typeof WorkerGlobalScope !== 'undefined' &&
  self instanceof WorkerGlobalScope
) {
  const scope = self as unknown as {
    postMessage(m: unknown, t: Transferable[]): void;
    onmessage: ((e: MessageEvent<ScanWorkerRequest>) => void) | null;
  };
  const handle = createHandler((m, t) => scope.postMessage(m, t));
  const own = (self as unknown as { location: { origin: string } }).location.origin;
  scope.onmessage = (e) => {
    // A dedicated worker only hears the page that started it (whose
    // messages carry no origin); anything else is ignored
    if (e.origin && e.origin !== own) return;
    void handle(e.data);
  };
}
