// Read aloud (src/acro/read-aloud.ts): how a page's text is cut into pieces
// to speak, which boxes a spoken word highlights, and how voices are named.
// The speaking itself runs in the desktop app (bench/check-read-aloud.mjs).
import { describe, expect, it } from 'vitest';
import {
  chunkAt,
  prepareText,
  readAloudPrefs,
  voiceName,
  wordRects,
} from '../acro/read-aloud';
import { setPrefs } from '../acro/prefs';

/** Text laid out as PDFium gives it: one box per character, lines 20pt
 *  apart, \r\n between lines (no size) */
function page(lines: string[]) {
  let text = '';
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  lines.forEach((line, n) => {
    if (n) {
      text += '\r\n';
      boxes.push({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 });
    }
    [...line].forEach((ch, i) => {
      text += ch;
      boxes.push(
        ch === ' '
          ? { x: 0, y: 0, w: 0, h: 0 }
          : { x: 10 + i * 6, y: 20 + n * 20, w: 5, h: 10 }
      );
    });
  });
  return prepareText(text, boxes);
}

describe('read aloud', () => {
  it('keeps the text the same length (indexes still match the boxes)', () => {
    const t = page(['One line.', 'Two lines.']);
    expect(t.spoken).toBe('One line.  Two lines.');
    expect(t.spoken.length).toBe(t.boxes.length);
  });

  it('speaks a sentence at a time', () => {
    const t = page(['First sentence. Second one!', 'Third?']);
    const pieces: string[] = [];
    for (let pos = 0, c = chunkAt(t, pos); c; pos = c[1], c = chunkAt(t, pos))
      pieces.push(t.spoken.slice(c[0], c[1]));
    expect(pieces).toEqual(['First sentence.', 'Second one!', 'Third?']);
  });

  it('pauses after a heading (a short line without punctuation)', () => {
    const t = page([
      'Introduction',
      'This paragraph runs over several lines, as',
      'paragraphs do, and its lines are about the',
      'same length until the sentence ends here.',
    ]);
    const first = chunkAt(t, 0)!;
    expect(t.spoken.slice(...first)).toBe('Introduction');
    const second = chunkAt(t, first[1])!;
    expect(t.spoken.slice(...second)).toBe(
      'This paragraph runs over several lines, as  paragraphs do, and its lines are about the  same length until the sentence ends here.'
    );
  });

  it('cuts a very long sentence at a space', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const t = page([long]);
    const [a, b] = chunkAt(t, 0)!;
    expect(b - a).toBeLessThanOrEqual(320);
    expect(t.spoken[b]).toBe(' ');
  });

  it('is done at the end of the text', () => {
    const t = page(['Only this.']);
    expect(chunkAt(t, t.spoken.length)).toBeNull();
    expect(chunkAt(page(['   ']), 0)).toBeNull();
  });

  it('highlights the whole word, one box per line', () => {
    const t = page(['Read these words']);
    // "these" starts at 5; the voice may not say how long the word is
    expect(wordRects(t, 5)).toEqual([{ x: 40, y: 20, w: 29, h: 10 }]);
    expect(wordRects(t, 5, 5)).toEqual([{ x: 40, y: 20, w: 29, h: 10 }]);
  });

  it('a word split over two lines gets two boxes', () => {
    const t = page(['hyphen-', 'ated']);
    expect(wordRects(t, 0, t.spoken.length)).toEqual([
      { x: 10, y: 20, w: 41, h: 10 },
      { x: 10, y: 40, w: 23, h: 10 },
    ]);
  });

  it('names voices without what their language group says', () => {
    const us = 'English (United States)';
    expect(voiceName('Microsoft David - English (United States)', us)).toBe(
      'David'
    );
    expect(voiceName('Eddy (English (United States))', us)).toBe('Eddy');
    expect(voiceName('Samantha', us)).toBe('Samantha');
  });

  it('puts broken settings right', () => {
    setPrefs({ readAloud: { voice: 5, rate: 9, color: 'red' } });
    expect(readAloudPrefs()).toEqual({
      voice: '',
      rate: 1,
      color: '#ffd400',
    });
    setPrefs({ readAloud: { voice: 'x', rate: 1.5, color: '' } });
    expect(readAloudPrefs()).toEqual({ voice: 'x', rate: 1.5, color: '' });
  });
});
