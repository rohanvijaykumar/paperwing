/**
 * CCITT Group 4 (ITU-T T.6) encoder for black-and-white scanned pages: the
 * lossless compression most scanners and Acrobat use for 1-bit pages. The
 * output is the raw T.6 stream, ending with EOFB, for a PDF image XObject
 * with /Filter /CCITTFaxDecode /DecodeParms <</K -1 /Columns w /Rows h>>.
 *
 * Coding follows T.6 section 2.2 (the same mode decisions as libtiff's
 * Fax3Encode2DRow): pass mode when b2 lies left of a1, vertical mode when
 * a1 is within 3 pixels of b1, horizontal mode (two run lengths) otherwise.
 * Pure and framework-free: runs in a Web Worker.
 */

/** A 1-bit image: rows of ceil(width / 8) bytes, most significant bit
 *  first, 1 = black (ink), 0 = white (paper) */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

export function bitmapRowBytes(width: number): number {
  return (width + 7) >> 3;
}

// Run-length codes from T.4 tables 2 and 3, as [length, bits]; makeup codes
// for 1792-2560 (T.4 table 3b) are shared by both colors
const WHITE_TERM = [
  '00110101',
  '000111',
  '0111',
  '1000',
  '1011',
  '1100',
  '1110',
  '1111',
  '10011',
  '10100',
  '00111',
  '01000',
  '001000',
  '000011',
  '110100',
  '110101',
  '101010',
  '101011',
  '0100111',
  '0001100',
  '0001000',
  '0010111',
  '0000011',
  '0000100',
  '0101000',
  '0101011',
  '0010011',
  '0100100',
  '0011000',
  '00000010',
  '00000011',
  '00011010',
  '00011011',
  '00010010',
  '00010011',
  '00010100',
  '00010101',
  '00010110',
  '00010111',
  '00101000',
  '00101001',
  '00101010',
  '00101011',
  '00101100',
  '00101101',
  '00000100',
  '00000101',
  '00001010',
  '00001011',
  '01010010',
  '01010011',
  '01010100',
  '01010101',
  '00100100',
  '00100101',
  '01011000',
  '01011001',
  '01011010',
  '01011011',
  '01001010',
  '01001011',
  '00110010',
  '00110011',
  '00110100',
];
const WHITE_MAKEUP = [
  '11011',
  '10010',
  '010111',
  '0110111',
  '00110110',
  '00110111',
  '01100100',
  '01100101',
  '01101000',
  '01100111',
  '011001100',
  '011001101',
  '011010010',
  '011010011',
  '011010100',
  '011010101',
  '011010110',
  '011010111',
  '011011000',
  '011011001',
  '011011010',
  '011011011',
  '010011000',
  '010011001',
  '010011010',
  '011000',
  '010011011',
];
const BLACK_TERM = [
  '0000110111',
  '010',
  '11',
  '10',
  '011',
  '0011',
  '0010',
  '00011',
  '000101',
  '000100',
  '0000100',
  '0000101',
  '0000111',
  '00000100',
  '00000111',
  '000011000',
  '0000010111',
  '0000011000',
  '0000001000',
  '00001100111',
  '00001101000',
  '00001101100',
  '00000110111',
  '00000101000',
  '00000010111',
  '00000011000',
  '000011001010',
  '000011001011',
  '000011001100',
  '000011001101',
  '000001101000',
  '000001101001',
  '000001101010',
  '000001101011',
  '000011010010',
  '000011010011',
  '000011010100',
  '000011010101',
  '000011010110',
  '000011010111',
  '000001101100',
  '000001101101',
  '000011011010',
  '000011011011',
  '000001010100',
  '000001010101',
  '000001010110',
  '000001010111',
  '000001100100',
  '000001100101',
  '000001010010',
  '000001010011',
  '000000100100',
  '000000110111',
  '000000111000',
  '000000100111',
  '000000101000',
  '000001011000',
  '000001011001',
  '000000101011',
  '000000101100',
  '000001011010',
  '000001100110',
  '000001100111',
];
const BLACK_MAKEUP = [
  '0000001111',
  '000011001000',
  '000011001001',
  '000001011011',
  '000000110011',
  '000000110100',
  '000000110101',
  '0000001101100',
  '0000001101101',
  '0000001001010',
  '0000001001011',
  '0000001001100',
  '0000001001101',
  '0000001110010',
  '0000001110011',
  '0000001110100',
  '0000001110101',
  '0000001110110',
  '0000001110111',
  '0000001010010',
  '0000001010011',
  '0000001010100',
  '0000001010101',
  '0000001011010',
  '0000001011011',
  '0000001100100',
  '0000001100101',
];
const EXT_MAKEUP = [
  '00000001000',
  '00000001100',
  '00000001101',
  '000000010010',
  '000000010011',
  '000000010100',
  '000000010101',
  '000000010110',
  '000000010111',
  '000000011100',
  '000000011101',
  '000000011110',
  '000000011111',
];

/** A code as (value << 5) | length, so writing it is one shift */
type Code = number;
const code = (bits: string): Code => (parseInt(bits, 2) << 5) | bits.length;

interface RunTable {
  term: Code[];
  /** index i: run 64 * (i + 1), up to 2560 */
  makeup: Code[];
}
function table(term: string[], makeup: string[]): RunTable {
  return {
    term: term.map(code),
    makeup: [...makeup, ...EXT_MAKEUP].map(code),
  };
}
const WHITE = table(WHITE_TERM, WHITE_MAKEUP);
const BLACK = table(BLACK_TERM, BLACK_MAKEUP);

const PASS = code('0001');
const HORIZONTAL = code('001');
// a1 - b1 from -3 to 3: VL3, VL2, VL1, V0, VR1, VR2, VR3
const VERTICAL = [
  '0000010',
  '000010',
  '010',
  '1',
  '011',
  '000011',
  '0000011',
].map(code);
const EOL = code('000000000001');

class BitWriter {
  private buf: Uint8Array;
  private pos = 0;
  private acc = 0;
  private n = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(Math.max(1024, size));
  }
  put(c: Code) {
    const len = c & 31;
    // (lengths are at most 13 bits, so acc stays under 21 bits)
    this.acc = (this.acc << len) | (c >>> 5);
    this.n += len;
    while (this.n >= 8) {
      this.n -= 8;
      if (this.pos === this.buf.length) this.grow();
      this.buf[this.pos++] = (this.acc >>> this.n) & 0xff;
    }
    this.acc &= (1 << this.n) - 1;
  }
  private grow() {
    const next = new Uint8Array(this.buf.length * 2);
    next.set(this.buf);
    this.buf = next;
  }
  finish(): Uint8Array {
    if (this.n > 0) {
      if (this.pos === this.buf.length) this.grow();
      this.buf[this.pos++] = (this.acc << (8 - this.n)) & 0xff;
      this.n = 0;
      this.acc = 0;
    }
    return this.buf.slice(0, this.pos);
  }
}

function putRun(w: BitWriter, run: number, t: RunTable) {
  while (run >= 2560 + 64) {
    w.put(t.makeup[39]);
    run -= 2560;
  }
  if (run >= 64) {
    const m = run >> 6;
    w.put(t.makeup[m - 1]);
    run -= m << 6;
  }
  w.put(t.term[run]);
}

/** Changing elements of a row: positions where the color differs from the
 *  pixel before (the pixel before the first is white), then `width` twice.
 *  Even entries start black runs, odd entries start white runs. */
function changes(
  data: Uint8Array,
  offset: number,
  width: number,
  out: Int32Array
): number {
  let n = 0;
  let color = 0;
  const bytes = bitmapRowBytes(width);
  for (let b = 0; b < bytes; b++) {
    const v = data[offset + b];
    // whole bytes of the current color are skipped quickly
    if ((color === 0 && v === 0) || (color === 1 && v === 0xff)) continue;
    const base = b << 3;
    for (let k = 0; k < 8; k++) {
      const x = base + k;
      if (x >= width) break;
      const bit = (v >> (7 - k)) & 1;
      if (bit !== color) {
        out[n++] = x;
        color = bit;
      }
    }
  }
  out[n] = width;
  out[n + 1] = width;
  return n;
}

/** Encodes a 1-bit image as CCITT Group 4 (T.6) */
export function encodeG4(bitmap: Bitmap): Uint8Array {
  const { width, height, data } = bitmap;
  if (width < 1 || height < 1) throw new Error('The image is empty');
  const rowBytes = bitmapRowBytes(width);
  if (data.length < rowBytes * height)
    throw new Error('The bitmap is smaller than its size says');
  const w = new BitWriter((rowBytes * height) >> 3);
  // reference line: initially an imaginary all-white line
  let ref = new Int32Array(width + 2);
  let cur = new Int32Array(width + 2);
  ref[0] = width;
  ref[1] = width;
  for (let y = 0; y < height; y++) {
    changes(data, y * rowBytes, width, cur);
    let a0 = -1;
    let color = 0; // color of the run starting at a0 (0 white, 1 black)
    let ia = 0; // index into cur of the first change after a0
    let ib = 0; // index into ref, moved forward only
    while (true) {
      // a1: first change on the coding line after a0
      while (cur[ia] <= a0 && cur[ia] < width) ia++;
      const a1 = cur[ia];
      // b1: first change on the reference line after a0 whose color is
      // opposite to a0's color (even indices are changes to black). After a
      // vertical step a0 can fall back left of a change skipped last time.
      while (ib > 0 && ref[ib - 1] > a0) ib--;
      while (ref[ib] <= a0 && ref[ib] < width) ib++;
      if ((ib & 1) !== color && ref[ib] < width) ib++;
      const b1 = ref[ib];
      const b2 = b1 < width ? ref[ib + 1] : width;
      if (b2 < a1) {
        w.put(PASS);
        a0 = b2;
      } else {
        const d = a1 - b1;
        if (d >= -3 && d <= 3) {
          w.put(VERTICAL[d + 3]);
          a0 = a1;
          color ^= 1;
        } else {
          const a2 = a1 < width ? cur[ia + 1] : width;
          const start = a0 < 0 ? 0 : a0;
          w.put(HORIZONTAL);
          if (color === 0) {
            putRun(w, a1 - start, WHITE);
            putRun(w, a2 - a1, BLACK);
          } else {
            putRun(w, a1 - start, BLACK);
            putRun(w, a2 - a1, WHITE);
          }
          a0 = a2;
        }
      }
      if (a0 >= width) break;
    }
    const t = ref;
    ref = cur;
    cur = t;
  }
  w.put(EOL);
  w.put(EOL);
  return w.finish();
}
