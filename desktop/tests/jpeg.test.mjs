/**
 * JPEGs whose height comes at the end, in a DNL marker (jpeg.cjs, #55): the
 * height moved into the frame header, everything else left as it was.
 *
 *   node --test desktop/tests/jpeg.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { drawPage, encodeJpeg, encodePng, heightAtEnd } from './fake-escl.mjs';

const require = createRequire(import.meta.url);
const { fixJpegHeight, jpegSize } = require('../jpeg.cjs');

const page = (w = 120, h = 90, color = 'color') =>
  drawPage(w, h, { n: 3, color });
const has = (buf, ...bytes) => buf.indexOf(Buffer.from(bytes)) >= 0;
/** A segment: FF marker, length, body */
const seg = (marker, body) => {
  const b = Buffer.from(body);
  return Buffer.concat([
    Buffer.from([0xff, marker, (b.length + 2) >> 8, (b.length + 2) & 255]),
    b,
  ]);
};

test('a JPEG with its height in the header is passed on as it is', () => {
  const jpeg = encodeJpeg(page());
  const r = fixJpegHeight(jpeg);
  assert.equal(r.data, jpeg, 'the very same buffer');
  assert.equal(r.changed, false);
  assert.equal(r.error, undefined);
  assert.deepEqual(jpegSize(jpeg), { width: 120, height: 90 });
});

test('height 0 and a DNL: the height goes into the header and the DNL goes', () => {
  for (const color of ['color', 'gray']) {
    const original = encodeJpeg(page(200, 283, color));
    const hp = heightAtEnd(original);
    assert.equal(jpegSize(original).height, 283);
    assert.ok(
      has(hp, 0xff, 0xdc, 0, 4, 283 >> 8, 283 & 255),
      'the fake wrote a DNL'
    );
    assert.deepEqual(
      jpegSize(hp),
      { width: 200, height: 283 },
      'the size, from the DNL'
    );
    const r = fixJpegHeight(hp);
    assert.equal(r.changed, true);
    assert.ok(
      r.data.equals(original),
      `${color}: byte for byte the JPEG it was made from`
    );
    // Fixed once is fixed: nothing more to do
    assert.equal(fixJpegHeight(r.data).changed, false);
  }
});

test('restart markers and stuffed bytes in the scan data are stepped over', () => {
  // A busy page and a restart every block: plenty of FF 00 and FF D0-D7
  const original = encodeJpeg(drawPage(160, 120, { n: 40, color: 'color' }), {
    restart: 1,
    quality: 95,
  });
  const sos = original.indexOf(Buffer.from([0xff, 0xda]));
  const data = original.subarray(sos);
  assert.ok(has(data, 0xff, 0x00), 'the scan data has stuffed bytes');
  for (let k = 0; k < 8; k++)
    assert.ok(has(data, 0xff, 0xd0 + k), `the scan data has RST${k}`);
  assert.ok(has(original, 0xff, 0xdd, 0, 4, 0, 1), 'a restart interval (DRI)');
  const r = fixJpegHeight(heightAtEnd(original));
  assert.equal(r.changed, true);
  assert.ok(r.data.equals(original));
});

test('FF DC inside other segments or behind stuffing is not taken for a DNL', () => {
  const original = encodeJpeg(page(64, 48));
  const hp = heightAtEnd(original);
  // An APP segment (as EXIF or ICC data can) holding the bytes of a DNL
  const fake = seg(0xe1, [0xff, 0xdc, 0, 4, 0x12, 0x34, 0xff, 0xd9]);
  const withApp = Buffer.concat([hp.subarray(0, 2), fake, hp.subarray(2)]);
  assert.equal(jpegSize(withApp).height, 48);
  const r = fixJpegHeight(withApp);
  assert.equal(r.changed, true);
  assert.ok(
    r.data.equals(
      Buffer.concat([original.subarray(0, 2), fake, original.subarray(2)])
    )
  );

  // Made by hand: scan data with FF 00 then DC 00 04 .., a restart, a fill
  // byte before the real DNL (77 lines; it goes with its fill byte), then
  // more scan data
  const sof = seg(0xc0, [8, 0, 0, 0, 16, 1, 1, 0x11, 0]);
  const sos = seg(0xda, [1, 1, 0, 0, 63, 0]);
  const scan = [
    0x12, 0xff, 0x00, 0xdc, 0x00, 0x04, 0x99, 0x99, 0xff, 0xd3, 0x34,
  ];
  const file = Buffer.from([
    0xff,
    0xd8,
    ...sof,
    ...sos,
    ...scan,
    0xff,
    0xff,
    0xdc,
    0,
    4,
    0,
    77,
    0x56,
    0xff,
    0xd9,
  ]);
  assert.deepEqual(jpegSize(file), { width: 16, height: 77 });
  const fixed = fixJpegHeight(file);
  assert.equal(fixed.changed, true);
  assert.deepEqual(
    [...fixed.data],
    [
      0xff,
      0xd8,
      ...sof.subarray(0, 5),
      0,
      77,
      ...sof.subarray(7),
      ...sos,
      ...scan,
      0x56,
      0xff,
      0xd9,
    ]
  );
});

test('height 0 with no DNL: an error, and the file left alone', () => {
  const broken = heightAtEnd(encodeJpeg(page()), { dnl: false });
  const r = fixJpegHeight(broken);
  assert.equal(r.error, 'no-height');
  assert.equal(r.changed, false);
  assert.equal(r.data, broken);
  assert.deepEqual(jpegSize(broken), { width: 120, height: 0 });
  // A DNL that says 0 lines is no better
  const zero = Buffer.from(heightAtEnd(encodeJpeg(page())));
  zero.writeUInt16BE(0, zero.length - 4);
  assert.equal(fixJpegHeight(zero).error, 'no-height');
});

test('anything else is passed on untouched, and damaged files do not throw', () => {
  const png = encodePng(page());
  assert.equal(fixJpegHeight(png).data, png);
  assert.equal(fixJpegHeight(png).changed, false);
  assert.equal(jpegSize(png), null);
  const pdf = Buffer.from('%PDF-1.7\n');
  assert.equal(fixJpegHeight(pdf).data, pdf);
  assert.equal(fixJpegHeight(Buffer.alloc(0)).changed, false);
  const hp = heightAtEnd(encodeJpeg(page()));
  for (const cut of [3, 20, 200, hp.length - 8])
    assert.doesNotThrow(() => {
      fixJpegHeight(hp.subarray(0, cut));
      jpegSize(hp.subarray(0, cut));
    }, `cut at ${cut}`);
  // A JPEG with no frame header isn't ours to judge
  assert.equal(
    fixJpegHeight(Buffer.from([0xff, 0xd8, 0xff, 0xd9])).error,
    undefined
  );
});
