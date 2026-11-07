/**
 * The scan dialog's flatbed preview: a quick scan of the whole glass, with
 * a box around the document (found by detectDocument) whose corners can be
 * dragged, or moved with the arrow keys. The real scan covers only the box.
 */
import type { Box } from './scan-settings';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

export interface GlassPreview {
  el: HTMLElement;
  /** Shows a preview image of the glass (its size in inches) and a box */
  show(image: Blob, glass: { width: number; height: number }, box: Box | null): void;
  clear(message: string): void;
  box(): Box | null;
  setBusy(busy: boolean): void;
}

const CORNERS = [
  ['nw', 'Top-left corner'],
  ['ne', 'Top-right corner'],
  ['sw', 'Bottom-left corner'],
  ['se', 'Bottom-right corner'],
] as const;
type Corner = (typeof CORNERS)[number][0];

/** The smallest box, in inches */
const MIN = 0.5;

export function createGlassPreview(onBoxChange: (box: Box) => void): GlassPreview {
  const img = el('img', { class: 'sp-image', alt: '' });
  const frame = el('div', { class: 'sp-box', 'aria-hidden': 'true' });
  const handles = CORNERS.map(([corner, label]) => {
    const h = el('button', {
      type: 'button',
      class: `sp-handle sp-${corner}`,
      'aria-label': `${label} of the scan area`,
      title: 'Drag to change the scan area (arrow keys move it)',
      'data-corner': corner,
    });
    return h;
  });
  const message = el('p', { class: 'sp-message' });
  const stage = el('div', { class: 'sp-stage' }, img, frame, ...handles);
  const root = el(
    'div',
    { class: 'sp-glass', role: 'group', 'aria-label': 'Preview of the glass' },
    stage,
    message
  );
  let glass = { width: 8.5, height: 11.69 };
  let current: Box | null = null;
  let url = '';

  function layout() {
    const visible = !!current && !stage.hidden;
    frame.hidden = !visible;
    handles.forEach((h) => (h.hidden = !visible));
    if (!current || !visible) return;
    const pct = (v: number, of: number) => `${(v / of) * 100}%`;
    frame.style.left = pct(current.x, glass.width);
    frame.style.top = pct(current.y, glass.height);
    frame.style.width = pct(current.width, glass.width);
    frame.style.height = pct(current.height, glass.height);
    const at: Record<Corner, [number, number]> = {
      nw: [current.x, current.y],
      ne: [current.x + current.width, current.y],
      sw: [current.x, current.y + current.height],
      se: [current.x + current.width, current.y + current.height],
    };
    for (const h of handles) {
      const [x, y] = at[h.dataset.corner as Corner];
      h.style.left = pct(x, glass.width);
      h.style.top = pct(y, glass.height);
    }
  }

  /** Moves one corner to (x, y) inches, keeping the box on the glass */
  function moveCorner(corner: Corner, x: number, y: number) {
    if (!current) return;
    let { x: left, y: top } = current;
    let right = left + current.width;
    let bottom = top + current.height;
    const cx = Math.min(Math.max(x, 0), glass.width);
    const cy = Math.min(Math.max(y, 0), glass.height);
    if (corner.includes('w')) left = Math.min(cx, right - MIN);
    else right = Math.max(cx, left + MIN);
    if (corner.includes('n')) top = Math.min(cy, bottom - MIN);
    else bottom = Math.max(cy, top + MIN);
    current = {
      x: round(left),
      y: round(top),
      width: round(right - left),
      height: round(bottom - top),
    };
    layout();
    onBoxChange(current);
  }

  for (const h of handles) {
    const corner = h.dataset.corner as Corner;
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      h.focus();
      const move = (ev: PointerEvent) => {
        const r = stage.getBoundingClientRect();
        moveCorner(
          corner,
          ((ev.clientX - r.left) / r.width) * glass.width,
          ((ev.clientY - r.top) / r.height) * glass.height
        );
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
    h.addEventListener('keydown', (e) => {
      if (!current) return;
      const step = e.shiftKey ? 0.5 : 0.1;
      const d: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const delta = d[e.key];
      if (!delta) return;
      e.preventDefault();
      e.stopPropagation();
      const x = corner.includes('w') ? current.x : current.x + current.width;
      const y = corner.includes('n') ? current.y : current.y + current.height;
      moveCorner(corner, x + delta[0], y + delta[1]);
    });
  }

  return {
    el: root,
    show(image, size, box) {
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(image);
      img.src = url;
      glass = size;
      stage.style.aspectRatio = `${size.width} / ${size.height}`;
      stage.hidden = false;
      message.hidden = true;
      current = box;
      layout();
    },
    clear(text) {
      stage.hidden = true;
      message.hidden = false;
      message.textContent = text;
      current = null;
      layout();
    },
    box: () => current,
    setBusy(busy) {
      root.classList.toggle('is-busy', busy);
      handles.forEach((h) => (h.disabled = busy));
    },
  };
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * Where the document lies on a preview of the glass: the box around what
 * differs from the lid (its color taken from the edges), in inches.
 * Null when nothing stands out (an empty glass).
 */
export async function findDocument(
  image: Blob,
  glass: { width: number; height: number }
): Promise<Box | null> {
  const bitmap = await createImageBitmap(image);
  const scale = Math.min(1, 400 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const px = ctx.getImageData(0, 0, w, h).data;
  const lum = (x: number, y: number) => {
    const o = (y * w + x) * 4;
    return 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
  };
  const edge: number[] = [];
  for (let x = 0; x < w; x += 2) edge.push(lum(x, 0), lum(x, h - 1));
  for (let y = 0; y < h; y += 2) edge.push(lum(0, y), lum(w - 1, y));
  edge.sort((a, b) => a - b);
  const lid = edge[Math.floor(edge.length / 2)];
  const differs = (x: number, y: number) => Math.abs(lum(x, y) - lid) > 14;
  const cols = new Array<number>(w).fill(0);
  const rows = new Array<number>(h).fill(0);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (differs(x, y)) {
        cols[x]++;
        rows[y]++;
      }
  // A row or column counts when a fair part of it differs (not a speck)
  const first = (a: number[], min: number) => a.findIndex((n) => n > min);
  const last = (a: number[], min: number) =>
    a.length - 1 - [...a].reverse().findIndex((n) => n > min);
  const x0 = first(cols, h * 0.05);
  const y0 = first(rows, w * 0.05);
  if (x0 < 0 || y0 < 0) return null;
  const x1 = last(cols, h * 0.05);
  const y1 = last(rows, w * 0.05);
  const box = {
    x: round((x0 / w) * glass.width),
    y: round((y0 / h) * glass.height),
    width: round(((x1 - x0 + 1) / w) * glass.width),
    height: round(((y1 - y0 + 1) / h) * glass.height),
  };
  // Nearly the whole glass: nothing was found (or it's a full-size page)
  if (box.width * box.height > glass.width * glass.height * 0.97) return null;
  return box.width >= MIN && box.height >= MIN ? box : null;
}
