import { describe, expect, it } from 'vitest';
import { rebrand, rebrandCode, rebrandStrings } from '../../reskin/brand.mjs';

describe("Paperwing's name in BentoPDF's pages and code", () => {
  it('replaces the name', () => {
    expect(rebrand('<title>Merge PDF | BentoPDF</title>')).toBe(
      '<title>Merge PDF | Paperwing</title>'
    );
    expect(rebrand("so BentoPDF can't also remove")).toBe(
      "so Paperwing can't also remove"
    );
  });

  it('keeps copyright notices, web addresses and storage keys', () => {
    const copyright = '<p>© 2026 BentoPDF. All rights reserved.</p>';
    expect(rebrand(copyright)).toBe(copyright);
    expect(rebrand('Copyright BentoPDF, all rights reserved')).toContain(
      'BentoPDF'
    );
    const kept = "fetch('https://bentopdf.com'); key = 'bentopdf_shortcuts'";
    expect(rebrand(kept)).toBe(kept);
    expect(rebrand('BentoPDFViewer')).toBe('BentoPDFViewer');
  });

  it('only touches the lines that have the name', () => {
    const text = 'a\n© BentoPDF\nBentoPDF tools\nb';
    expect(rebrand(text)).toBe('a\n© BentoPDF\nPaperwing tools\nb');
  });

  it('renames the files the tools save', () => {
    const code =
      "download(blob, 'bentopdf-compare-export.pdf'); save('bentopdf_shortcuts.json'); const STORAGE_KEY = 'bentopdf_shortcuts';";
    expect(rebrandCode(code)).toBe(
      "download(blob, 'paperwing-compare-export.pdf'); save('paperwing_shortcuts.json'); const STORAGE_KEY = 'bentopdf_shortcuts';"
    );
  });

  it('rebrands interface strings, keeping copyright', () => {
    expect(
      rebrandStrings({
        aboutBentoPDF: 'BentoPDF',
        nested: { title: 'Why BentoPDF?', list: ['BentoPDF', 1, null] },
        footer: '© 2026 BentoPDF. All rights reserved.',
      })
    ).toEqual({
      aboutBentoPDF: 'Paperwing',
      nested: { title: 'Why Paperwing?', list: ['Paperwing', 1, null] },
      footer: '© 2026 BentoPDF. All rights reserved.',
    });
  });

  it('rebrands keys that are the English text (ui.json), as the code is', () => {
    const key = 'A new version of BentoPDF is available. Reload to update?';
    const branded = rebrandStrings({
      [key]: 'Er is een nieuwe versie van BentoPDF.',
    });
    expect(branded).toEqual({
      [rebrandCode(key)]: 'Er is een nieuwe versie van Paperwing.',
    });
    expect(rebrandCode(key)).toBe(
      'A new version of Paperwing is available. Reload to update?'
    );
  });
});
