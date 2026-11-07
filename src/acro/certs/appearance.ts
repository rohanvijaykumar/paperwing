/**
 * How a signature looks on the page, like Acrobat's signature appearances:
 * the signer's name large on the left (or an image, or nothing), and the
 * details on the right (signed by, date, reason, location, distinguished
 * name), with or without labels. Drawn into a PNG for the signature field;
 * appearances people make are kept (localStorage).
 */

export interface Appearance {
  id: string;
  title: string;
  /** Left side: the name, an image (data: URL), or nothing */
  graphic: 'name' | 'image' | 'none';
  image?: string;
  show: {
    name: boolean;
    date: boolean;
    reason: boolean;
    location: boolean;
    dn: boolean;
    labels: boolean;
  };
}

export interface AppearanceValues {
  name: string;
  dn: string;
  date: Date;
  reason?: string;
  location?: string;
}

export const STANDARD: Appearance = {
  id: 'standard',
  title: 'Standard text',
  graphic: 'name',
  show: {
    name: true,
    date: true,
    reason: true,
    location: true,
    dn: false,
    labels: true,
  },
};

const KEY = 'paperwing:signatureAppearances';
const LAST = 'paperwing:signatureAppearance';

export function savedAppearances(): Appearance[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list)
      ? list.filter((a) => a && typeof a.id === 'string' && a.show)
      : [];
  } catch {
    return [];
  }
}

export function allAppearances(): Appearance[] {
  return [STANDARD, ...savedAppearances()];
}

export function saveAppearance(a: Appearance): void {
  const list = savedAppearances().filter((x) => x.id !== a.id);
  list.push(a);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full (a large image): kept for this session only */
  }
}

export function deleteAppearance(id: string): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(savedAppearances().filter((x) => x.id !== id))
    );
  } catch {
    /* (nothing kept) */
  }
}

export function lastAppearanceId(): string {
  try {
    return localStorage.getItem(LAST) ?? STANDARD.id;
  } catch {
    return STANDARD.id;
  }
}

export function rememberAppearance(id: string): void {
  try {
    localStorage.setItem(LAST, id);
  } catch {
    /* (not remembered) */
  }
}

/** Acrobat's date format in signatures: 2026.11.06 18:30:12 -05'00' */
export function signatureDate(d: Date): string {
  const p = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return (
    `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ` +
    `${off < 0 ? '-' : '+'}${p(Math.trunc(off / 60))}'${p(off % 60)}'`
  );
}

/** The text lines on the right */
export function detailLines(a: Appearance, v: AppearanceValues): string[] {
  const label = (l: string, text: string) =>
    a.show.labels ? `${l}: ${text}` : text;
  const lines: string[] = [];
  if (a.show.name)
    lines.push(a.show.labels ? `Digitally signed by ${v.name}` : v.name);
  if (a.show.dn && v.dn) lines.push(label('DN', v.dn));
  if (a.show.reason && v.reason) lines.push(label('Reason', v.reason));
  if (a.show.location && v.location) lines.push(label('Location', v.location));
  if (a.show.date) lines.push(label('Date', signatureDate(v.date)));
  return lines;
}

const FONT =
  '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number
): string[] {
  const words = text.split(/(\s+|,\s*)/).filter((w) => w.length);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line + w;
    if (line && ctx.measureText(next.trimEnd()).width > width) {
      out.push(line.trimEnd());
      line = w.trimStart();
    } else {
      line = next;
    }
  }
  if (line.trim()) out.push(line.trimEnd());
  return out;
}

async function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Draws the appearance into a canvas of this size (pixels) */
export async function drawAppearance(
  canvas: HTMLCanvasElement,
  a: Appearance,
  v: AppearanceValues,
  width: number,
  height: number
): Promise<void> {
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  const pad = Math.round(Math.min(width, height) * 0.06);
  const lines = detailLines(a, v);
  const split = a.graphic !== 'none' && lines.length > 0;
  const leftW = split ? (width - pad * 3) / 2 : 0;
  const textX = split ? pad * 2 + leftW : pad;
  const textW = width - textX - pad;

  if (a.graphic === 'name') {
    // The name as large as fits the left half
    const target = split ? leftW : width - pad * 2;
    let size = height * 0.5;
    ctx.font = `600 ${size}px ${FONT}`;
    const words = wrap(ctx, v.name, target);
    for (; size > 6; size *= 0.92) {
      ctx.font = `600 ${size}px ${FONT}`;
      const ls = wrap(ctx, v.name, target);
      // (a word longer than the half it's in would run into the details)
      if (
        ls.length * size * 1.15 <= height - pad * 2 &&
        ls.length <= 3 &&
        ls.every((l) => ctx.measureText(l).width <= target)
      ) {
        words.splice(0, words.length, ...ls);
        break;
      }
    }
    const blockH = words.length * size * 1.15;
    let y = (height - blockH) / 2;
    for (const l of words) {
      ctx.fillText(l, pad, y);
      y += size * 1.15;
    }
  } else if (a.graphic === 'image' && a.image) {
    const img = await loadImage(a.image);
    if (img) {
      const boxW = split ? leftW : width - pad * 2;
      const boxH = height - pad * 2;
      const s = Math.min(boxW / img.width, boxH / img.height);
      const w = img.width * s;
      const h = img.height * s;
      ctx.drawImage(img, pad + (boxW - w) / 2, pad + (boxH - h) / 2, w, h);
    }
  }

  if (lines.length) {
    // The largest size at which the wrapped lines fit
    let size = Math.min(height / 3, 28 * (height / 100));
    let wrapped: string[] = [];
    for (; size > 4; size *= 0.92) {
      ctx.font = `${size}px ${FONT}`;
      wrapped = lines.flatMap((l) => wrap(ctx, l, textW));
      if (
        wrapped.length * size * 1.2 <= height - pad * 2 &&
        wrapped.every((l) => ctx.measureText(l).width <= textW)
      )
        break;
    }
    const blockH = wrapped.length * size * 1.2;
    let y = Math.max(pad, (height - blockH) / 2);
    for (const l of wrapped) {
      ctx.fillText(l, textX, y);
      y += size * 1.2;
    }
  }
}

/** The appearance as a PNG for a box of this size in points (drawn at
 *  about 300 dpi, so it prints sharply) */
export async function appearancePng(
  a: Appearance,
  v: AppearanceValues,
  widthPt: number,
  heightPt: number
): Promise<Uint8Array> {
  const scale = Math.min(4, 2400 / Math.max(widthPt, heightPt, 1));
  const canvas = document.createElement('canvas');
  await drawAppearance(canvas, a, v, widthPt * scale, heightPt * scale);
  const blob = await new Promise<Blob | null>((r) =>
    canvas.toBlob(r, 'image/png')
  );
  if (!blob) throw new Error('Couldn’t draw the signature');
  return new Uint8Array(await blob.arrayBuffer());
}
