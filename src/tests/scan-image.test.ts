// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  blankCoverageLimit,
  detectDocument,
  processPage,
  type ProcessedPage,
  type ScanImage,
} from '../acro/scan-image';
import { bitmapRowBytes } from '../acro/scan-g4';
import {
  addNoise,
  at,
  countDark,
  drawText,
  gray,
  rect,
  rgba,
  rng,
  set,
  textLayout,
} from './helpers/scan-synth';

/** Letter at a test-friendly resolution */
const DPI = 120;
const W = Math.round(8.5 * DPI);
const H = Math.round(11 * DPI);

function textPage(
  opts: { deg?: number; seed?: number; paper?: number; ink?: number } = {}
) {
  const img = gray(W, H, DPI, opts.paper ?? 245);
  const layout = textLayout(2550, 3300, { seed: opts.seed });
  drawText(img, layout.inkAt, { deg: opts.deg, ink: opts.ink });
  addNoise(img, 6, opts.seed);
  return img;
}

function imageOf(p: ProcessedPage): ScanImage {
  if (p.kind !== 'bw') return p.image;
  const { width, height, data } = p.bitmap;
  const out = new Uint8Array(width * height);
  const rb = bitmapRowBytes(width);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      out[y * width + x] =
        (data[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 255;
  return { width, height, channels: 1, data: out, dpi: p.dpi };
}

const OFF = { deskew: false } as const;

describe('deskew', () => {
  it.each([-7.3, -2, 0.6, 3.5, 11])(
    'finds a %s degree slope within 0.2 degrees',
    async (deg) => {
      const page = await processPage(textPage({ deg }), {
        colorMode: 'gray',
        deskew: true,
      });
      expect(Math.abs(page.skew - deg)).toBeLessThanOrEqual(0.2);
      // and the result is straight
      const again = await processPage(
        page.kind === 'gray' ? page.image : textPage(),
        {
          colorMode: 'gray',
          deskew: true,
        }
      );
      expect(Math.abs(again.skew)).toBeLessThanOrEqual(0.2);
    }
  );

  it('leaves a straight page, a blank page and a photo alone', async () => {
    expect((await processPage(textPage(), { colorMode: 'gray' })).skew).toBe(0);
    const blank = gray(W, H, DPI);
    addNoise(blank, 8);
    expect((await processPage(blank, { colorMode: 'gray' })).skew).toBe(0);
    // smooth random blobs, nothing line-like
    const photo = gray(W, H, DPI);
    const r = rng(5);
    for (let k = 0; k < 60; k++) {
      const cx = r() * W;
      const cy = r() * H;
      const rad = 20 + r() * 120;
      const v = Math.round(r() * 200);
      for (let y = Math.max(0, cy - rad); y < Math.min(H, cy + rad); y++)
        for (let x = Math.max(0, cx - rad); x < Math.min(W, cx + rad); x++)
          if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad)
            set(photo, Math.floor(x), Math.floor(y), v);
    }
    expect((await processPage(photo, { colorMode: 'gray' })).skew).toBe(0);
  });

  it('leaves a logo alone (curves and slanted edges are not lines of text)', async () => {
    // A crescent and an arrowhead, like a logo boxed on the preview
    const img = gray(360, 300, 120, 250);
    for (let y = 0; y < 300; y++)
      for (let x = 0; x < 360; x++) {
        const inA = (x - 150) ** 2 + (y - 150) ** 2 < 110 ** 2;
        const inB = (x - 190) ** 2 + (y - 120) ** 2 < 100 ** 2;
        const head = x > 220 && x < 340 && Math.abs(y - 200) < (340 - x) * 0.6;
        if ((inA && !inB) || head) set(img, x, y, 60);
      }
    expect((await processPage(img, { colorMode: 'gray', deskew: true })).skew).toBe(0);
  });

  it('straightens color pages and keeps them in color', async () => {
    const img = rgba(W, H, DPI, [250, 250, 250]);
    drawText(img, textLayout(2550, 3300).inkAt, {
      deg: -4,
      ink: [20, 30, 160],
    });
    const page = await processPage(img, { colorMode: 'auto' });
    expect(page.kind).toBe('color');
    expect(Math.abs(page.skew + 4)).toBeLessThanOrEqual(0.2);
  });
});

describe('despeckle', () => {
  /** Text with specks between the lines: `sizes` pixels each */
  function speckled(img: ScanImage, sizes: number[], count: number) {
    const r = rng(11);
    const specks: Array<[number, number]> = [];
    const { width: w, height: h } = img;
    while (specks.length < count) {
      const x = 4 + Math.floor(r() * (w - 12));
      const y = 4 + Math.floor(r() * (h - 12));
      if (countDark(img, 200, { x: x - 6, y: y - 6, width: 16, height: 16 }))
        continue;
      const size = sizes[Math.floor(r() * sizes.length)];
      for (let k = 0; k < size; k++)
        set(img, x + (k % 3), y + Math.floor(k / 3), 20);
      specks.push([x, y]);
    }
    return specks;
  }
  const speckCount = (img: ScanImage, specks: Array<[number, number]>) =>
    specks.filter(
      ([x, y]) => countDark(img, 128, { x, y, width: 3, height: 3 }) > 0
    ).length;

  it.each(['gray', 'bw'] as const)(
    'removes stray dots and keeps text (%s)',
    async (colorMode) => {
      const img = textPage();
      const specks = speckled(img, [1, 2], 300);
      // a dot over an i: 2x2, 2 pixels above a stroke
      rect(img, 600, 200, 3, 20, 25);
      rect(img, 600, 196, 2, 2, 25);
      const box = { x: 150, y: 150, width: 600, height: 400 };
      const before = countDark(img, 128, box);
      const kept = await processPage(img, {
        ...OFF,
        colorMode,
        despeckle: false,
      });
      expect(speckCount(imageOf(kept), specks)).toBeGreaterThan(290);
      const page = await processPage(img, {
        ...OFF,
        colorMode,
        despeckle: true,
      });
      const out = imageOf(page);
      expect(speckCount(out, specks)).toBe(0);
      // the text and the dot on the i stay
      const after = countDark(out, 128, box);
      expect(Math.abs(after - before) / before).toBeLessThan(0.03);
      expect(at(out, 600, 196)).toBeLessThan(128);
    }
  );

  it('scales with resolution: 300 dpi specks up to 9 pixels, full stops stay', async () => {
    const img = gray(900, 900, 300, 245);
    const t = textLayout(900, 900, { margin: 100 });
    drawText(img, t.inkAt);
    // full stops (3x3) 3 pixels after a word's last letter
    const stops = t.lines.map(
      (l) => [l.words[0][1] + 3, l.y + 19] as [number, number]
    );
    for (const [x, y] of stops) {
      rect(img, x - 7, y - 19, 4, 22, 30);
      rect(img, x, y, 3, 3, 25);
    }
    addNoise(img, 5);
    const specks = speckled(img, [1, 3, 5, 9], 150);
    const out = imageOf(
      await processPage(img, { ...OFF, colorMode: 'bw', despeckle: true })
    );
    expect(speckCount(out, specks)).toBe(0);
    for (const [x, y] of stops) expect(at(out, x + 1, y + 1)).toBeLessThan(128);
  });
});

describe('background removal', () => {
  function greyPaper(color: boolean) {
    // uneven, yellowed paper: 190 at the left to 225 at the right
    const img = color ? rgba(W, H, DPI, [0, 0, 0]) : gray(W, H, DPI);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const v = 190 + (35 * x) / W;
        set(img, x, y, color ? [v, v * 0.97, v * 0.82] : v);
      }
    drawText(img, textLayout(2550, 3300).inkAt, {
      ink: color ? [35, 35, 30] : 35,
    });
    addNoise(img, 4);
    return img;
  }
  const paperShare = (img: ScanImage, min: number) => {
    let n = 0;
    let white = 0;
    for (let y = 0; y < H; y += 3)
      for (let x = 0; x < W; x += 3) {
        // well away from the text lines
        if (y > 90 && y < H - 120 && x > 90 && x < W - 90) continue;
        n++;
        if (at(img, x, y) >= min) white++;
      }
    return white / n;
  };

  it.each(['medium', 'high'] as const)(
    'whitens grey, uneven paper (%s)',
    async (level) => {
      const img = greyPaper(false);
      expect(paperShare(img, 245)).toBe(0);
      const page = await processPage(img, {
        ...OFF,
        colorMode: 'gray',
        backgroundRemoval: level,
      });
      const out = imageOf(page);
      expect(paperShare(out, 245)).toBeGreaterThan(0.97);
      // text stays dark
      const t = textLayout(2550, 3300);
      const line = t.lines[3];
      const x = Math.round(((line.words[0][0] + 1) * DPI) / 300);
      const y = Math.round(((line.y + 1) * DPI) / 300);
      expect(at(out, x, y)).toBeLessThan(90);
    }
  );

  it('low brightens the paper evenly', async () => {
    const img = greyPaper(false);
    const out = imageOf(
      await processPage(img, {
        ...OFF,
        colorMode: 'gray',
        backgroundRemoval: 'low',
      })
    );
    // the brightest paper turns white, the gradient stays
    expect(at(out, W - 5, 10)).toBeGreaterThan(245);
    expect(at(out, 5, 10)).toBeLessThan(at(out, W - 5, 10));
    expect(at(out, 5, 10)).toBeGreaterThan(at(img, 5, 10));
  });

  it('yellowed color paper becomes neutral white, and isn\'t "color"', async () => {
    const img = greyPaper(true);
    const auto = await processPage(img, {
      ...OFF,
      colorMode: 'auto',
      backgroundRemoval: 'medium',
    });
    expect(auto.kind).not.toBe('color');
    const page = await processPage(img, {
      ...OFF,
      colorMode: 'color',
      backgroundRemoval: 'medium',
    });
    expect(page.kind).toBe('color');
    if (page.kind !== 'color') return;
    const d = page.image.data;
    let neutral = 0;
    let n = 0;
    for (let y = 5; y < 60; y += 5)
      for (let x = 5; x < W - 5; x += 7, n++) {
        const o = (y * W + x) * 4;
        if (
          Math.min(d[o], d[o + 1], d[o + 2]) >= 240 &&
          Math.max(d[o], d[o + 1], d[o + 2]) -
            Math.min(d[o], d[o + 1], d[o + 2]) <=
            8
        )
          neutral++;
      }
    expect(neutral / n).toBeGreaterThan(0.95);
  });
});

describe('blank pages', () => {
  const blank = async (img: ScanImage, sensitivity: number) =>
    (
      await processPage(img, {
        colorMode: 'gray',
        removeBlank: { enabled: true, sensitivity },
      })
    ).blank;

  it('the limit grows with sensitivity', () => {
    expect(blankCoverageLimit(0)).toBeLessThan(blankCoverageLimit(50));
    expect(blankCoverageLimit(50)).toBeLessThan(blankCoverageLimit(100));
  });

  it('a blank sheet with scanner noise is blank at every sensitivity', async () => {
    const img = gray(W, H, DPI, 240);
    addNoise(img, 10);
    for (const s of [0, 50, 100]) expect(await blank(img, s)).toBe(true);
  });

  it('dust and faint show-through are blank from the middle setting up', async () => {
    const img = gray(W, H, DPI, 242);
    addNoise(img, 6);
    // show-through: the back's text, faint
    drawText(img, textLayout(2550, 3300, { seed: 8 }).inkAt, { ink: 215 });
    const r = rng(4);
    for (let k = 0; k < 40; k++)
      set(img, Math.floor(r() * W), Math.floor(r() * H), 30);
    expect(await blank(img, 50)).toBe(true);
    expect(await blank(img, 100)).toBe(true);
  });

  it('a few words are kept at the middle setting, removed at the highest', async () => {
    const img = gray(W, H, DPI, 245);
    addNoise(img, 6);
    drawText(img, textLayout(2550, 3300, { lines: 1, wordsPerLine: 3 }).inkAt);
    expect(await blank(img, 0)).toBe(false);
    expect(await blank(img, 50)).toBe(false);
    expect(await blank(img, 100)).toBe(true);
  });

  it('a page of text is never blank', async () => {
    expect(await blank(textPage(), 100)).toBe(false);
  });

  it('a lid shadow along the edge does not count, with edge shadow removal', async () => {
    const img = gray(W, H, DPI, 244);
    addNoise(img, 5);
    for (let x = 0; x < 40; x++) rect(img, x, 0, 1, H, 40 + x * 5);
    const page = await processPage(img, {
      colorMode: 'gray',
      edgeShadowRemoval: true,
      removeBlank: { enabled: true, sensitivity: 0 },
    });
    expect(page.blank).toBe(true);
  });

  it('reports blank pages even when removal is off, but processes them fully', async () => {
    const img = gray(W, H, DPI, 240);
    addNoise(img, 4);
    const page = await processPage(img, {
      colorMode: 'gray',
      backgroundRemoval: 'high',
    });
    expect(page.blank).toBe(true);
    expect(page.kind).toBe('gray');
  });
});

describe('descreen', () => {
  /** A gray ramp printed with a 45 degree clustered-dot screen of 150 lpi,
   *  scanned at 300 dpi */
  function halftone() {
    const dpi = 300;
    const w = 600;
    const h = 600;
    const img = gray(w, h, dpi, 250);
    const period = dpi / 150;
    const c = Math.SQRT1_2;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const level = 0.2 + (0.6 * x) / w; // ink coverage
        const u = ((x * c + y * c) / period) % 1;
        const v = ((-x * c + y * c) / period + 1000) % 1;
        const d = Math.hypot(u - 0.5, v - 0.5) / Math.SQRT1_2;
        if (d < Math.sqrt(level)) set(img, x, y, 30);
      }
    return { img, fx: c / period, fy: c / period };
  }
  /** Energy at one frequency (cycles per pixel), one DFT term */
  function energy(img: ScanImage, fx: number, fy: number) {
    let re = 0;
    let im = 0;
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const a = 2 * Math.PI * (fx * x + fy * y);
        const v = at(img, x, y);
        re += v * Math.cos(a);
        im -= v * Math.sin(a);
      }
    return Math.hypot(re, im);
  }

  it('removes the dot pattern and keeps the tones', async () => {
    const { img, fx, fy } = halftone();
    const before = energy(img, fx, fy);
    const page = await processPage(img, {
      ...OFF,
      colorMode: 'gray',
      descreen: true,
    });
    const out = imageOf(page);
    expect(energy(out, fx, fy)).toBeLessThan(before * 0.05);
    const mean = (i: ScanImage, x0: number) => {
      let s = 0;
      for (let y = 100; y < 500; y++)
        for (let x = x0; x < x0 + 40; x++) s += at(i, x, y);
      return s / (400 * 40);
    };
    for (const x0 of [60, 280, 500])
      expect(Math.abs(mean(out, x0) - mean(img, x0))).toBeLessThan(3);
  });
});

describe('finding the document', () => {
  function onLid(
    lid: number,
    paper: number,
    box: [number, number, number, number],
    shadow = 0
  ) {
    const w = 850;
    const h = 1170;
    const img = gray(w, h, 100, lid);
    const [x0, y0, bw, bh] = box;
    // shadow along the right and bottom, darkest at the paper
    for (let k = shadow; k > 0; k--) {
      const v = Math.round(150 + ((lid - 150) * k) / shadow);
      rect(img, x0 + bw, y0 + 6, k, bh, v);
      rect(img, x0 + 6, y0 + bh, bw, k, v);
    }
    rect(img, x0, y0, bw, bh, paper);
    const t = textLayout(bw * 3, bh * 3, { margin: 120 });
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++)
        if (t.inkAt(x * 3, y * 3)) set(img, x0 + x, y0 + y, 40);
    addNoise(img, 5);
    return img;
  }
  const close = (
    r: { x: number; y: number; width: number; height: number },
    b: number[]
  ) => {
    const tol = 12;
    expect(Math.abs(r.x - b[0])).toBeLessThanOrEqual(tol);
    expect(Math.abs(r.y - b[1])).toBeLessThanOrEqual(tol);
    expect(Math.abs(r.x + r.width - (b[0] + b[2]))).toBeLessThanOrEqual(tol);
    expect(Math.abs(r.y + r.height - (b[1] + b[3]))).toBeLessThanOrEqual(tol);
  };

  it('white paper on a black lid', () => {
    const box = [120, 90, 600, 800];
    close(detectDocument(onLid(20, 240, box as never)), box);
  });

  it('white paper on a white lid, ignoring its shadow', () => {
    const box = [60, 70, 550, 720];
    close(detectDocument(onLid(228, 250, box as never, 14)), box);
  });

  it('a page in the corner of the glass', () => {
    const box = [0, 0, 620, 800];
    close(detectDocument(onLid(225, 248, box as never, 10)), box);
  });

  it('grey paper on a white lid keeps its edges', () => {
    const box = [100, 100, 500, 700];
    close(detectDocument(onLid(240, 205, box as never)), box);
  });

  it('the whole glass when nothing is on it', () => {
    const img = gray(850, 1170, 100, 232);
    addNoise(img, 6);
    expect(detectDocument(img)).toEqual({
      x: 0,
      y: 0,
      width: 850,
      height: 1170,
    });
  });

  it('works on color previews and in full-size pixels', () => {
    const g = onLid(20, 240, [200, 150, 1000, 1400] as never);
    // (onLid draws 850x1170; make a bigger color preview from scratch)
    void g;
    const img = rgba(1700, 2340, 200, [15, 15, 18]);
    rect(img, 200, 150, 1000, 1400, [235, 232, 220]);
    addNoise(img, 4);
    close(detectDocument(img), [200, 150, 1000, 1400].map((v) => v) as never);
  });

  it('auto-crop cuts a page out of a dark feeder background', async () => {
    const img = gray(W, H, DPI, 25);
    rect(img, 40, 30, W - 140, H - 100, 245);
    addNoise(img, 5);
    const page = await processPage(img, {
      ...OFF,
      colorMode: 'gray',
      autoCrop: true,
    });
    expect(page.crop).not.toBeNull();
    close(page.crop!, [40, 30, W - 140, H - 100]);
    expect(page.width).toBe(page.crop!.width);
  });
});

describe('edge shadows', () => {
  it('fills a dark band along the edge with the paper color', async () => {
    const img = textPage();
    for (let x = 0; x < 30; x++) rect(img, x, 0, 1, H, 30 + x * 6);
    const before = countDark(img, 128);
    const page = await processPage(img, {
      ...OFF,
      colorMode: 'gray',
      edgeShadowRemoval: true,
    });
    const out = imageOf(page);
    for (let y = 100; y < H - 100; y += 50)
      expect(at(out, 5, y)).toBeGreaterThan(220);
    // the text is untouched
    const ink = countDark(out, 128);
    expect(ink).toBeLessThan(before);
    expect(countDark(out, 128, { x: 60, y: 0, width: W - 60, height: H })).toBe(
      countDark(img, 128, { x: 60, y: 0, width: W - 60, height: H })
    );
  });
});

describe('color modes', () => {
  it('Autodetect: text is black and white, a photo gray, a stamp color', async () => {
    expect(
      (await processPage(textPage(), { ...OFF, colorMode: 'auto' })).kind
    ).toBe('bw');
    const photo = gray(W, H, DPI);
    for (let y = 100; y < H - 100; y++)
      for (let x = 100; x < W - 100; x++)
        set(photo, x, y, Math.round(40 + (180 * (x + y)) / (W + H)));
    expect((await processPage(photo, { ...OFF, colorMode: 'auto' })).kind).toBe(
      'gray'
    );
    const stamp = rgba(W, H, DPI, [245, 245, 245]);
    drawText(stamp, textLayout(2550, 3300).inkAt, { ink: [30, 30, 30] });
    rect(stamp, 700, 1100, 120, 120, [200, 30, 30]);
    expect((await processPage(stamp, { ...OFF, colorMode: 'auto' })).kind).toBe(
      'color'
    );
    // the same in gray
    const grayStamp = await processPage(stamp, { ...OFF, colorMode: 'auto' });
    expect(grayStamp.kind).toBe('color');
  });

  it('black and white follows the threshold slider', async () => {
    // strokes of every gray level on white paper
    const img = gray(560, 100, 100, 250);
    for (let v = 0; v < 26; v++) rect(img, 20 + v * 20, 20, 8, 60, v * 10);
    const black = async (threshold: number) => {
      const p = imageOf(
        await processPage(img, { ...OFF, colorMode: 'bw', threshold })
      );
      return [...Array(26).keys()]
        .filter((v) => at(p, 24 + v * 20, 50) === 0)
        .map((v) => v * 10);
    };
    expect(await black(80)).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
    expect((await black(160)).at(-1)).toBe(150);
    // automatic: Otsu between the strokes and the paper
    const auto = imageOf(await processPage(img, { ...OFF, colorMode: 'bw' }));
    expect(at(auto, 24, 50)).toBe(0);
    expect(at(auto, 10, 50)).toBe(255);
  });

  it('invert turns a negative scan positive; brightness and contrast apply', async () => {
    const neg = gray(200, 200, 100, 10);
    rect(neg, 50, 50, 20, 20, 250);
    const p = imageOf(
      await processPage(neg, { ...OFF, colorMode: 'bw', invert: true })
    );
    expect(at(p, 10, 10)).toBe(255);
    expect(at(p, 60, 60)).toBe(0);
    const mid = gray(100, 100, 100, 128);
    const bright = imageOf(
      await processPage(mid, { ...OFF, colorMode: 'gray', brightness: 50 })
    );
    expect(at(bright, 50, 50)).toBe(192);
    const two = gray(100, 100, 100, 100);
    rect(two, 0, 0, 50, 100, 160);
    const c = imageOf(
      await processPage(two, { ...OFF, colorMode: 'gray', contrast: 50 })
    );
    expect(at(c, 75, 50)).toBeLessThan(100);
    expect(at(c, 25, 50)).toBeGreaterThan(160);
  });
});

describe('text sharpening', () => {
  it('makes soft edges steeper, more so at higher levels', async () => {
    const img = gray(300, 100, 300, 240);
    // a soft edge: 240 to 40 over 6 pixels
    for (let y = 0; y < 100; y++)
      for (let x = 150; x < 300; x++)
        set(img, x, y, Math.max(40, 240 - (x - 150) * 33));
    const steep = (i: ScanImage) => {
      let m = 0;
      for (let x = 140; x < 165; x++)
        m = Math.max(m, at(i, x, 50) - at(i, x + 1, 50));
      return m;
    };
    const base = steep(img);
    const low = steep(
      imageOf(
        await processPage(img, {
          ...OFF,
          colorMode: 'gray',
          textSharpening: 'low',
        })
      )
    );
    const high = steep(
      imageOf(
        await processPage(img, {
          ...OFF,
          colorMode: 'gray',
          textSharpening: 'high',
        })
      )
    );
    expect(low).toBeGreaterThan(base);
    expect(high).toBeGreaterThan(low);
  });

  it.each([75, 100, 150])('does something at %s dpi too (every level)', async (dpi) => {
    // (the blur it compares with used to round away below about 150 dpi)
    const img = gray(120, 40, dpi, 240);
    for (let y = 0; y < 40; y++)
      for (let x = 60; x < 120; x++) set(img, x, y, Math.max(40, 240 - (x - 60) * 70));
    const edge = (i: ScanImage) => at(i, 60, 20) - at(i, 63, 20);
    for (const level of ['low', 'medium', 'high'] as const) {
      const out = imageOf(
        await processPage(img, { ...OFF, colorMode: 'gray', textSharpening: level })
      );
      expect(edge(out), level).toBeGreaterThan(edge(img));
    }
  });
});

describe('orientation', () => {
  /** A page with a mark near the top left corner */
  function marked() {
    const img = gray(300, 400, 100, 245);
    rect(img, 10, 10, 30, 20, 20);
    return img;
  }
  const markAt = (p: ProcessedPage, x: number, y: number) =>
    at(imageOf(p), x, y) < 128;

  it('rotates clockwise by the chosen angle', async () => {
    const p = await processPage(marked(), {
      ...OFF,
      colorMode: 'gray',
      rotate: 90,
    });
    expect(p.rotation).toBe(90);
    expect([p.width, p.height]).toEqual([400, 300]);
    // top left goes to top right
    expect(markAt(p, 400 - 20, 20)).toBe(true);
  });

  it('flip turns back sides upside down', async () => {
    const p = await processPage(marked(), {
      ...OFF,
      colorMode: 'gray',
      flip: true,
    });
    expect(p.rotation).toBe(180);
    expect(markAt(p, 300 - 20, 400 - 15)).toBe(true);
  });

  it('auto-rotate asks the detector, then adds the chosen rotation', async () => {
    const detectOrientation = vi.fn(() => ({ rotate: 270 as const }));
    const p = await processPage(
      marked(),
      { ...OFF, colorMode: 'bw', autoRotate: true, rotate: 180, flip: true },
      { detectOrientation }
    );
    expect(detectOrientation).toHaveBeenCalledTimes(1);
    const seen = (detectOrientation.mock.calls[0] as unknown as [ScanImage])[0];
    expect(seen.channels).toBe(1);
    expect([seen.width, seen.height]).toEqual([300, 400]);
    // the detector's answer replaces flip
    expect(p.rotation).toBe(90);
    expect(p.kind).toBe('bw');
    expect([p.width, p.height]).toEqual([400, 300]);
  });

  it("keeps flip when the detector can't tell", async () => {
    const p = await processPage(
      marked(),
      { ...OFF, colorMode: 'gray', autoRotate: true, flip: true },
      { detectOrientation: async () => null }
    );
    expect(p.rotation).toBe(180);
  });
});

describe('input', () => {
  it('rejects a buffer smaller than the size', async () => {
    await expect(
      processPage(
        {
          width: 10,
          height: 10,
          channels: 4,
          data: new Uint8ClampedArray(10),
          dpi: 100,
        },
        {}
      )
    ).rejects.toThrow(/smaller/);
  });

  it("doesn't change the caller's pixels", async () => {
    const img = textPage({ deg: 2 });
    const copy = img.data.slice();
    await processPage(img, {
      colorMode: 'gray',
      backgroundRemoval: 'high',
      despeckle: true,
    });
    expect(img.data.every((v, i) => v === copy[i])).toBe(true);
  });

  it('accepts RGB and RGBA', async () => {
    const img = rgba(100, 80, 100, [200, 10, 10]);
    const rgb = new Uint8Array(100 * 80 * 3);
    for (let i = 0; i < 100 * 80; i++)
      rgb.set(img.data.subarray(i * 4, i * 4 + 3), i * 3);
    const a = await processPage(img, { ...OFF, colorMode: 'color' });
    const b = await processPage(
      { ...img, channels: 3, data: rgb },
      { ...OFF, colorMode: 'color' }
    );
    expect(a.kind === 'color' && b.kind === 'color' && a.image.data).toEqual(
      b.kind === 'color' && b.image.data
    );
  });
});

describe('the scan area', () => {
  // A 10 × 14 in glass at 20 dpi, a dark square at (3, 4) in, 1 in wide
  const glass = () => {
    const img = gray(200, 280, 20, 240);
    rect(img, 60, 80, 20, 20, 10);
    return img;
  };

  it('keeps just the box, measured from the corner of what came', async () => {
    const p = await processPage(glass(), {
      crop: { x: 2.5, y: 3.5, width: 2, height: 3 },
      colorMode: 'gray',
      deskew: false,
    });
    expect([p.width, p.height]).toEqual([40, 60]);
    const img = imageOf(p);
    // the square starts 0.5 in (10 px) into the box
    expect(at(img, 12, 12)).toBeLessThan(50);
    expect(at(img, 5, 5)).toBeGreaterThan(200);
  });

  it('a box partly off what came is cut to what there is', async () => {
    const p = await processPage(glass(), {
      crop: { x: 8, y: 12, width: 5, height: 5 },
      colorMode: 'gray',
      deskew: false,
    });
    expect([p.width, p.height]).toEqual([40, 40]);
  });
});
