/**
 * JPEGs from scanners whose height comes at the end (#55).
 *
 * A document feeder doesn't know how long the paper is when it starts
 * sending the page, so some scanners (HP's feeders, over eSCL) write height
 * 0 in the frame header and give the real number of lines in a DNL marker
 * (ITU T.81, B.2.5) after the first scan's data. The standard allows it;
 * Chromium's decoder (libjpeg-turbo) doesn't, and fails with "The source
 * image could not be decoded". fixJpegHeight() moves the height into the
 * frame header and drops the DNL, so every backend's pages open; any other
 * file is passed on untouched.
 */

/** Frame headers: SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC) */
const isFrame = (m) =>
  m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
const isJpeg = (buf) => buf?.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8;

/**
 * Walks a JPEG's markers: segments are skipped by their length; inside a
 * scan's entropy-coded data, FF 00 is a stuffed byte and FF D0-D7 a restart,
 * so only another marker ends it. Returns
 * { frame: offset of the frame header's FF | -1, width, height, dnl: { at,
 * end, lines } | null } (the DNL from `at`, with any fill bytes before it,
 * to `end`). With `untilFrame`, stops at a frame header that has a height
 * (all that's needed then).
 */
function walk(buf, { untilFrame = false } = {}) {
  const out = { frame: -1, width: 0, height: 0, dnl: null };
  let i = 2;
  // Where the marker being read starts, fill bytes included
  let at = i;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) break; // not a marker: a damaged file, stop
    const m = buf[i + 1];
    if (m === 0xff) {
      i++; // a fill byte before a marker
      continue;
    }
    if (m === 0xd9) break; // end of image
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      at = i += 2; // markers without a length
      continue;
    }
    if (i + 4 > buf.length) break;
    const length = buf.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > buf.length) break;
    if (isFrame(m) && out.frame < 0 && length >= 8) {
      out.frame = i;
      out.height = buf.readUInt16BE(i + 5);
      out.width = buf.readUInt16BE(i + 7);
      if (untilFrame && out.height) return out;
    } else if (m === 0xdc) {
      out.dnl = {
        at,
        end: i + 2 + length,
        lines: length >= 4 ? buf.readUInt16BE(i + 4) : 0,
      };
      return out;
    }
    i += 2 + length;
    if (m === 0xda) {
      // The scan's data, up to the next marker that isn't part of it
      for (;;) {
        i = buf.indexOf(0xff, i);
        if (i < 0 || i + 1 >= buf.length) return out;
        const n = buf[i + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) i += 2;
        else break;
      }
    }
    at = i;
  }
  return out;
}

/** A JPEG's size in pixels, the height from a DNL if the header has 0;
 *  null if it isn't a JPEG with a frame header */
function jpegSize(buf) {
  if (!isJpeg(buf)) return null;
  let info = walk(buf, { untilFrame: true });
  if (info.frame < 0) return null;
  if (!info.height) info = walk(buf);
  return { width: info.width, height: info.height || info.dnl?.lines || 0 };
}

/**
 * A JPEG with its height where every decoder looks for it.
 * Returns { data, changed }: `data` is `buf` itself unless a height-0 frame
 * header was given the DNL's height (and the DNL dropped). A JPEG whose
 * height is 0 with no DNL to say it can't be opened by anything:
 * { data: buf, changed: false, error: 'no-height' }.
 */
function fixJpegHeight(buf) {
  if (!isJpeg(buf)) return { data: buf, changed: false };
  const head = walk(buf, { untilFrame: true });
  if (head.frame < 0 || head.height) return { data: buf, changed: false };
  const { frame, dnl } = walk(buf);
  if (!dnl?.lines) return { data: buf, changed: false, error: 'no-height' };
  const data = Buffer.concat([buf.subarray(0, dnl.at), buf.subarray(dnl.end)]);
  data.writeUInt16BE(dnl.lines, frame + 5);
  return { data, changed: true };
}

module.exports = { fixJpegHeight, jpegSize };
