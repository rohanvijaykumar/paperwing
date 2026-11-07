// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createScanImageClient,
  type ScanWorkerReply,
  type ScanWorkerRequest,
  type WorkerLike,
} from '../acro/scan-image-client';
import { createHandler } from '../acro/scan-image.worker';
import { gray, rect } from './helpers/scan-synth';

/** A Worker that runs the real handler in this thread, with messages
 *  structured-cloned both ways like the real thing */
function fakeWorker() {
  const sent: ScanWorkerRequest[] = [];
  const w: WorkerLike & { terminated: boolean } = {
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(message) {
      const msg = structuredClone(message) as ScanWorkerRequest;
      sent.push(msg);
      setTimeout(() => void handle(msg), 0);
    },
    terminate() {
      w.terminated = true;
    },
  };
  const handle = createHandler((reply: ScanWorkerReply) => {
    if (!w.terminated) w.onmessage?.({ data: structuredClone(reply) });
  });
  return { w, sent };
}

function marked() {
  const img = gray(300, 400, 100, 245);
  rect(img, 10, 10, 30, 20, 20);
  return img;
}

describe('scan clean-up worker client', () => {
  it('processes a page in the worker', async () => {
    const { w } = fakeWorker();
    const client = createScanImageClient({ createWorker: () => w });
    const page = await client.processPage(marked(), {
      colorMode: 'bw',
      rotate: 90,
    });
    expect(page.kind).toBe('bw');
    expect([page.width, page.height]).toEqual([400, 300]);
    expect(page.kind === 'bw' && page.bitmap.data).toBeInstanceOf(Uint8Array);
  });

  it('prepares a page for the PDF and finds the document', async () => {
    const { w } = fakeWorker();
    const client = createScanImageClient({ createWorker: () => w });
    const prepared = await client.preparePage(
      marked(),
      { colorMode: 'gray' },
      { compression: 'flate', quality: 1 }
    );
    expect(prepared.kind).toBe('gray');
    expect(prepared.encoded.kind).toBe('flate');
    const box = await client.detectDocument(gray(200, 200, 50, 20));
    expect(box).toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });

  it('asks this side for the orientation and uses the answer', async () => {
    const { w } = fakeWorker();
    const detectOrientation = vi.fn(async () => ({ rotate: 180 as const }));
    const client = createScanImageClient({
      createWorker: () => w,
      detectOrientation,
    });
    const page = await client.processPage(marked(), {
      colorMode: 'gray',
      autoRotate: true,
    });
    expect(detectOrientation).toHaveBeenCalledTimes(1);
    expect(page.rotation).toBe(180);
  });

  it('an orientation check that fails leaves the page as it is', async () => {
    const { w } = fakeWorker();
    const client = createScanImageClient({
      createWorker: () => w,
      detectOrientation: async () => {
        throw new Error('no OSD data');
      },
    });
    const page = await client.processPage(marked(), {
      colorMode: 'gray',
      autoRotate: true,
    });
    expect(page.rotation).toBe(0);
  });

  it('copies the pixels unless asked to hand them over', async () => {
    const { w } = fakeWorker();
    const spy = vi.spyOn(w, 'postMessage');
    const client = createScanImageClient({ createWorker: () => w });
    const img = marked();
    await client.processPage(img, { colorMode: 'gray' });
    expect(spy.mock.calls[0][1]).toEqual([]);
    await client.processPage(img, { colorMode: 'gray' }, { transfer: true });
    expect(spy.mock.calls[1][1]).toEqual([img.data.buffer]);
  });

  it('reports errors, and fails waiting calls when the worker dies', async () => {
    const { w } = fakeWorker();
    let made = 0;
    const client = createScanImageClient({
      createWorker: () => {
        made++;
        return w;
      },
    });
    await expect(
      client.processPage(
        {
          width: 10,
          height: 10,
          channels: 1,
          data: new Uint8Array(3),
          dpi: 100,
        },
        {}
      )
    ).rejects.toThrow(/smaller/);
    const waiting = client.processPage(marked(), {});
    w.onerror?.({ message: 'out of memory' });
    await expect(waiting).rejects.toThrow('out of memory');
    expect(w.terminated).toBe(true);
    // the next call starts a new worker
    w.terminated = false;
    await client.processPage(marked(), { colorMode: 'gray' });
    expect(made).toBe(2);
    client.dispose();
  });
});
