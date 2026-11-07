/**
 * A baseline JPEG encoder for gray pages: one component, so a grayscale
 * scan is a gray image in the PDF (DeviceGray). The canvas's own encoder
 * only writes three-component (color) JPEGs, which made gray pages color
 * images of gray. The standard quantization table (ITU T.81 Annex K),
 * quality scaled the way libjpeg (and so the canvas) does; Huffman tables
 * made for each image.
 */

// prettier-ignore
const LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
// prettier-ignore
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48,
  41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22,
  15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55,
  62, 63,
];
/** symbol -> [code, length] for a table given as bits per length + values */
function huffman(bits: number[], vals: number[]): [number, number][] {
  const out: [number, number][] = [];
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) out[vals[k++]] = [code++, len];
    code <<= 1;
  }
  return out;
}

/** cos table for the 8-point DCT, with C(u)/2 folded in */
const COS = (() => {
  const t = new Float64Array(64);
  for (let u = 0; u < 8; u++)
    for (let x = 0; x < 8; x++)
      t[u * 8 + x] =
        ((u ? 1 : Math.SQRT1_2) / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return t;
})();

/** libjpeg's quality scaling of the standard table (quality 1-100) */
export function quantTable(quality: number): Uint8Array {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  return Uint8Array.from(LUMA_QUANT, (v) =>
    Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100)))
  );
}

class BitWriter {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private acc = 0;
  private n = 0;
  private byte(b: number) {
    if (this.len + 2 > this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.len++] = b;
    // (a 0xFF in the data is followed by a 0 so it isn't read as a marker)
    if (b === 0xff) this.buf[this.len++] = 0;
  }
  bits(value: number, count: number) {
    for (let i = count - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      if (++this.n === 8) {
        this.byte(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  done(): Uint8Array {
    // (the last byte padded with 1 bits)
    if (this.n) this.bits(0xff, 8 - this.n);
    return this.buf.subarray(0, this.len);
  }
}

const category = (v: number) => {
  let a = Math.abs(v);
  let n = 0;
  while (a) {
    n++;
    a >>= 1;
  }
  return n;
};
const valueBits = (v: number, n: number) => (v < 0 ? v + (1 << n) - 1 : v);

/**
 * Code lengths for symbols used `freq` times (T.81 Annex K.2): Huffman's
 * method, then no code over 16 bits. Returns the table as bits per length
 * and the symbols in order.
 */
export function optimalTable(freq: ArrayLike<number>): { bits: number[]; vals: number[] } {
  const f = Float64Array.from({ length: 257 }, (_, i) => (i < 256 ? freq[i] || 0 : 1));
  const size = new Int32Array(257);
  const others = new Int32Array(257).fill(-1);
  for (;;) {
    let v1 = -1;
    let v2 = -1;
    // the least frequent two (the higher symbol on ties)
    for (let i = 0; i < 257; i++)
      if (f[i] && (v1 < 0 || f[i] <= f[v1])) v1 = i;
    for (let i = 0; i < 257; i++)
      if (f[i] && i !== v1 && (v2 < 0 || f[i] <= f[v2])) v2 = i;
    if (v2 < 0) break;
    f[v1] += f[v2];
    f[v2] = 0;
    size[v1]++;
    while (others[v1] >= 0) {
      v1 = others[v1];
      size[v1]++;
    }
    others[v1] = v2;
    size[v2]++;
    while (others[v2] >= 0) {
      v2 = others[v2];
      size[v2]++;
    }
  }
  // (a code can be as long as there are symbols, before it's shortened)
  const bits = new Array<number>(258).fill(0);
  for (let i = 0; i < 257; i++) if (size[i]) bits[size[i]]++;
  for (let i = 257; i > 16; i--)
    while (bits[i] > 0) {
      let j = i - 2;
      while (!bits[j]) j--;
      bits[i] -= 2;
      bits[i - 1]++;
      bits[j + 1] += 2;
      bits[j]--;
    }
  // (the reserved symbol 256 takes the longest code: drop it)
  let i = 16;
  while (!bits[i]) i--;
  bits[i]--;
  const vals: number[] = [];
  for (let len = 1; len <= 257; len++)
    for (let v = 0; v < 256; v++) if (size[v] === len) vals.push(v);
  return { bits: bits.slice(1, 17), vals };
}

/**
 * A one-component (gray) baseline JPEG of `gray` (one byte a pixel, rows
 * of `width`), at `quality` 0-1 as the canvas takes it. Two passes: the
 * coefficients and how often each code is needed, then Huffman tables made
 * for this image (smaller than the standard ones).
 */
export function encodeGrayJpeg(
  gray: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  quality: number,
  dpi = 0
): Uint8Array {
  const qt = quantTable(quality * 100);
  const bw = Math.ceil(width / 8);
  const bh = Math.ceil(height / 8);
  // quantized coefficients, in zigzag order, block after block
  const coef = new Int16Array(bw * bh * 64);
  const block = new Float64Array(64);
  const rows = new Float64Array(64);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      // (past the edge: the edge pixel again)
      for (let y = 0; y < 8; y++) {
        const sy = Math.min(height - 1, by * 8 + y) * width;
        for (let x = 0; x < 8; x++)
          block[y * 8 + x] = gray[sy + Math.min(width - 1, bx * 8 + x)] - 128;
      }
      // 2-D DCT: rows, then columns
      for (let y = 0; y < 8; y++)
        for (let u = 0; u < 8; u++) {
          let sum = 0;
          for (let x = 0; x < 8; x++) sum += COS[u * 8 + x] * block[y * 8 + x];
          rows[y * 8 + u] = sum;
        }
      const at = (by * bw + bx) * 64;
      for (let k = 0; k < 64; k++) {
        const i = ZIGZAG[k];
        const v = i >> 3;
        const u = i & 7;
        let sum = 0;
        for (let y = 0; y < 8; y++) sum += COS[v * 8 + y] * rows[y * 8 + u];
        coef[at + k] = Math.round(sum / qt[i]);
      }
    }

  /** Each symbol to write, in order: (table, symbol, extra bits) */
  function walk(emit: (ac: boolean, sym: number, value: number, n: number) => void) {
    let prevDc = 0;
    for (let b = 0; b < bw * bh; b++) {
      const at = b * 64;
      const diff = coef[at] - prevDc;
      prevDc = coef[at];
      const n = category(diff);
      emit(false, n, valueBits(diff, n), n);
      let zeros = 0;
      for (let k = 1; k < 64; k++) {
        const q = coef[at + k];
        if (!q) {
          zeros++;
          continue;
        }
        while (zeros > 15) {
          emit(true, 0xf0, 0, 0);
          zeros -= 16;
        }
        const m = category(q);
        emit(true, (zeros << 4) | m, valueBits(q, m), m);
        zeros = 0;
      }
      if (zeros) emit(true, 0, 0, 0);
    }
  }
  const dcFreq = new Float64Array(256);
  const acFreq = new Float64Array(256);
  walk((ac, sym) => (ac ? acFreq : dcFreq)[sym]++);
  const dcTable = optimalTable(dcFreq);
  const acTable = optimalTable(acFreq);
  const dcCodes = huffman(dcTable.bits, dcTable.vals);
  const acCodes = huffman(acTable.bits, acTable.vals);
  const w = new BitWriter();
  walk((ac, sym, value, n) => {
    const [code, len] = (ac ? acCodes : dcCodes)[sym];
    w.bits(code, len);
    if (n) w.bits(value, n);
  });
  const data = w.done();

  const head: number[] = [0xff, 0xd8];
  const seg = (marker: number, body: number[]) =>
    head.push(0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body);
  const d = Math.min(65535, Math.max(0, Math.round(dpi)));
  // JFIF, with the resolution
  seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, d ? 1 : 0, d >> 8, d & 0xff || 1, d >> 8, d & 0xff || 1, 0, 0]);
  seg(0xdb, [0, ...ZIGZAG.map((i) => qt[i])]);
  seg(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
  seg(0xc4, [0x00, ...dcTable.bits, ...dcTable.vals]);
  seg(0xc4, [0x10, ...acTable.bits, ...acTable.vals]);
  seg(0xda, [1, 1, 0x00, 0, 63, 0]);
  const out = new Uint8Array(head.length + data.length + 2);
  out.set(head);
  out.set(data, head.length);
  out.set([0xff, 0xd9], head.length + data.length);
  return out;
}
