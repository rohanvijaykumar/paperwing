/**
 * The scan dialog's flatbed preview: the glass, whole, fitted into the pane
 * at any window size; a quick scan of it (Preview) shown with the chosen
 * color mode, brightness, contrast and threshold applied live (scan.ts
 * works them out); and the box the scan will cover (the paper size, or a
 * box around the document scan-image.ts finds), whose corners can be
 * dragged, or moved with the arrow keys. Dragging makes the box the scan
 * area. Before a preview the glass is shown empty, with the box on it.
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
  /**
   * The glass (its size in inches), or null when there's no glass to show
   * (a document feeder, no scanner) and `message` says why. A new glass
   * drops the picture of the old one.
   */
  setGlass(glass: { width: number; height: number } | null, message: string): void;
  /** Draws a preview (or the preview adjusted) scanned at `dpi`, placed by
   *  its own size from the glass's corner, so a driver that sends less (or
   *  more) than the whole glass still lines up with the box */
  draw(pixels: ImageData, dpi: number): void;
  /** Whether a preview is shown */
  hasImage(): boolean;
  /** The box the scan covers (null: none, the scanner finds the paper) */
  setBox(box: Box | null): void;
  box(): Box | null;
  /** A line shown on the empty glass (or over the picture, when busy) */
  note(text: string): void;
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
/** Room around the glass in the pane, px */
const PAD = 16;

export function createGlassPreview(onBoxChange: (box: Box) => void): GlassPreview {
  const canvas = el('canvas', { class: 'sp-image', 'aria-hidden': 'true' });
  const frame = el('div', { class: 'sp-box', 'aria-hidden': 'true' });
  const handles = CORNERS.map(([corner, label]) =>
    el('button', {
      type: 'button',
      class: `sp-handle sp-${corner}`,
      'aria-label': `${label} of the scan area`,
      title: 'Drag to change the scan area (arrow keys move it)',
      'data-corner': corner,
    })
  );
  const empty = el('p', { class: 'sp-empty' });
  const stage = el('div', { class: 'sp-stage' }, canvas, empty, frame, ...handles);
  const message = el('p', { class: 'sp-message' });
  const root = el(
    'div',
    { class: 'sp-glass', role: 'group', 'aria-label': 'Preview of the glass' },
    stage,
    message
  );
  let glass: { width: number; height: number } | null = null;
  let current: Box | null = null;
  let image = false;

  /** The glass as big as the pane allows, whole */
  function fit() {
    if (!glass) return;
    const w = root.clientWidth - 2 * PAD;
    const h = root.clientHeight - 2 * PAD;
    if (w <= 0 || h <= 0) return;
    const scale = Math.min(w / glass.width, h / glass.height);
    stage.style.width = `${Math.floor(glass.width * scale)}px`;
    stage.style.height = `${Math.floor(glass.height * scale)}px`;
  }
  new ResizeObserver(fit).observe(root);

  function layout() {
    const visible = !!current && !!glass;
    frame.hidden = !visible;
    handles.forEach((h) => (h.hidden = !visible));
    if (!current || !glass) return;
    const g = glass;
    const pct = (v: number, of: number) => `${(v / of) * 100}%`;
    frame.style.left = pct(current.x, g.width);
    frame.style.top = pct(current.y, g.height);
    frame.style.width = pct(current.width, g.width);
    frame.style.height = pct(current.height, g.height);
    const at: Record<Corner, [number, number]> = {
      nw: [current.x, current.y],
      ne: [current.x + current.width, current.y],
      sw: [current.x, current.y + current.height],
      se: [current.x + current.width, current.y + current.height],
    };
    for (const h of handles) {
      const [x, y] = at[h.dataset.corner as Corner];
      h.style.left = pct(x, g.width);
      h.style.top = pct(y, g.height);
    }
  }

  /** Moves one corner to (x, y) inches, keeping the box on the glass */
  function moveCorner(corner: Corner, x: number, y: number) {
    if (!current || !glass) return;
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
        if (!glass) return;
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
    setGlass(size, text) {
      const same = !!size && !!glass && size.width === glass.width && size.height === glass.height;
      glass = size;
      stage.hidden = !size;
      message.hidden = !!size;
      message.textContent = size ? '' : text;
      if (!same) {
        image = false;
        canvas.hidden = true;
        empty.hidden = false;
      }
      if (size) {
        // (its size, for the benches)
        stage.dataset.glass = `${size.width}x${size.height}`;
        empty.textContent = text;
        fit();
      } else current = null;
      layout();
    },
    draw(pixels, dpi) {
      if (!glass) return;
      canvas.width = pixels.width;
      canvas.height = pixels.height;
      canvas.getContext('2d')!.putImageData(pixels, 0, 0);
      // Its size on the glass, from its resolution
      canvas.style.width = `${(Math.min(pixels.width / dpi, glass.width) / glass.width) * 100}%`;
      canvas.style.height = `${(Math.min(pixels.height / dpi, glass.height) / glass.height) * 100}%`;
      canvas.hidden = false;
      empty.hidden = true;
      image = true;
    },
    hasImage: () => image,
    setBox(box) {
      current = box && glass ? { ...box } : null;
      layout();
    },
    box: () => current,
    note(text) {
      empty.textContent = text;
    },
    setBusy(busy) {
      root.classList.toggle('is-busy', busy);
      handles.forEach((h) => (h.disabled = busy));
    },
  };
}

const round = (v: number) => Math.round(v * 100) / 100;
