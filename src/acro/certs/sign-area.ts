/**
 * Digitally sign, step 1 (Acrobat's): drag a box on the page where the
 * signature goes. While it's on, every page shown gets a layer that takes
 * the mouse (pages come and go as the document scrolls); the box is
 * measured in the page's own coordinates, so zoom and the view's rotation
 * don't matter.
 */
import { findPages, pageBoxes } from '../form-layer';
import type { Viewer } from '../viewer';

export interface DrawnBox {
  /** 0-based page */
  page: number;
  /** Fractions of the page, unrotated (the layer's own coordinates:
   *  the viewer turns the page around it), from its top left */
  box: { x: number; y: number; width: number; height: number };
  /** The page's size on screen when drawn, in CSS pixels (for the
   *  appearance's proportions) */
  pixels: { width: number; height: number };
  /** The page's /Rotate (the appearance is drawn upright for it) */
  rotation?: number;
}

/** A click without a drag places a box this size (fractions of the page
 *  width; about 2.5 × 0.8 in on Letter) */
const CLICK_WIDTH = 0.3;
const CLICK_ASPECT = 3.2;
const MIN_DRAG_PX = 8;

const STYLE = `
  .pwsig-layer { position: absolute; inset: 0; z-index: 30; cursor: crosshair;
    touch-action: none; }
  .pwsig-box { position: absolute; border: 1.5px solid #3b63fb;
    background: rgb(59 99 251 / 0.12); pointer-events: none; }
`;

/**
 * Lets the user draw the box. Resolves with it, or null if they cancelled
 * (`cancel()` or Escape).
 */
export function drawSignatureBox(
  viewer: Viewer,
  tabId: string
): { done: Promise<DrawnBox | null>; cancel: () => void } {
  let finish: (box: DrawnBox | null) => void = () => {};
  const done = new Promise<DrawnBox | null>((r) => (finish = r));
  const root = viewer.shadow();
  if (!root) {
    finish(null);
    return { done, cancel: () => {} };
  }
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.append(style);
  const layers = new Map<HTMLElement, HTMLElement>();
  let stopped = false;
  // The viewer reports a new layout (zoom, scroll) before it has moved its
  // pages, and moving them changes only their style, which nothing here
  // hears: pages that don't match the layout yet are tried again on the
  // next frames
  let retry = 0;
  let retrying = false;
  const again = () => {
    if (retrying || stopped || retry >= 120) return;
    retrying = true;
    retry++;
    requestAnimationFrame(() => {
      retrying = false;
      if (!stopped) place(false);
    });
  };

  const place = (fresh = true) => {
    if (fresh) retry = 0;
    const layout = viewer.pageLayout(tabId);
    if (!layout || !viewer.isShowing(tabId)) {
      again();
      return;
    }
    const found = findPages(root, layout);
    if (found.length < pageBoxes(root).length || !found.length) again();
    const shown = new Set<HTMLElement>();
    for (const { page, index } of found) {
      shown.add(page);
      const existing = layers.get(page);
      if (existing?.isConnected && existing.dataset.page === String(index))
        continue;
      existing?.remove();
      const layer = document.createElement('div');
      layer.className = 'pwsig-layer';
      layer.dataset.page = String(index);
      layer.addEventListener('pointerdown', (e) => start(e, layer, index));
      page.append(layer);
      layers.set(page, layer);
    }
    for (const [page, layer] of layers)
      if (!shown.has(page) || !page.isConnected) {
        layer.remove();
        layers.delete(page);
      }
  };

  const observer = new MutationObserver((records) => {
    if (
      records.every((r) =>
        [...r.addedNodes, ...r.removedNodes].every(
          (n) => n instanceof Element && n.classList.contains('pwsig-layer')
        )
      )
    )
      return;
    place();
  });
  observer.observe(root, { childList: true, subtree: true });
  const unsubscribe = viewer.onPagesMoved((id) => {
    if (id === tabId) place();
  });
  place();

  function start(e: PointerEvent, layer: HTMLElement, index: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    layer.setPointerCapture(e.pointerId);
    const w = layer.clientWidth;
    const h = layer.clientHeight;
    const x0 = e.offsetX;
    const y0 = e.offsetY;
    const box = document.createElement('div');
    box.className = 'pwsig-box';
    layer.append(box);
    let x1 = x0;
    let y1 = y0;
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    const draw = () => {
      Object.assign(box.style, {
        left: `${Math.min(x0, x1)}px`,
        top: `${Math.min(y0, y1)}px`,
        width: `${Math.abs(x1 - x0)}px`,
        height: `${Math.abs(y1 - y0)}px`,
      });
    };
    const move = (m: PointerEvent) => {
      // (offsets are the layer's own: pointer capture keeps it the target)
      x1 = clamp(m.offsetX, w);
      y1 = clamp(m.offsetY, h);
      draw();
    };
    const up = () => {
      layer.removeEventListener('pointermove', move);
      layer.removeEventListener('pointerup', up);
      layer.removeEventListener('pointercancel', up);
      let left = Math.min(x0, x1);
      let top = Math.min(y0, y1);
      let bw = Math.abs(x1 - x0);
      let bh = Math.abs(y1 - y0);
      if (bw < MIN_DRAG_PX || bh < MIN_DRAG_PX) {
        // A click: a box of the usual size, centred there
        bw = CLICK_WIDTH * w;
        bh = bw / CLICK_ASPECT;
        left = clamp(x0 - bw / 2, w - bw);
        top = clamp(y0 - bh / 2, h - bh);
      }
      draw();
      stop();
      finish({
        page: index,
        box: { x: left / w, y: top / h, width: bw / w, height: bh / h },
        pixels: { width: w, height: h },
      });
    };
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  };
  document.addEventListener('keydown', onKey, true);

  function stop() {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    unsubscribe();
    document.removeEventListener('keydown', onKey, true);
    for (const layer of layers.values()) layer.remove();
    layers.clear();
    style.remove();
  }
  function cancel() {
    stop();
    finish(null);
  }
  return { done, cancel };
}
