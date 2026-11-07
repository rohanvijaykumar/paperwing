import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  desktopCode,
  desktopHtml,
  desktopStrings,
  desktopWords,
} from '../../reskin/desktop-words.mjs';

describe("The desktop app's words in BentoPDF's tool pages", () => {
  it('saves results instead of downloading them', () => {
    expect(desktopWords('Save & Download Signed PDF')).toBe('Save Signed PDF');
    expect(desktopWords('Save &amp; Download Filled Form')).toBe(
      'Save Filled Form'
    );
    expect(desktopWords('Download')).toBe('Save');
    expect(desktopWords('Download Edited PDF')).toBe('Save Edited PDF');
    expect(desktopWords('Sign & Download')).toBe('Sign & Save');
    expect(desktopWords('Crop & Download')).toBe('Crop & Save');
    expect(
      desktopWords(
        'then click the button to save and download the filled form.'
      )
    ).toBe('then click the button to save the filled form.');
    expect(desktopWords('Crop complete! Your download has started.')).toBe(
      'Crop complete!'
    );
    expect(
      desktopWords('Your PDF has been cropped and the download has started.')
    ).toBe('Your PDF has been cropped.');
    expect(desktopWords('Converted successfully! ZIP download started.')).toBe(
      'Converted successfully!'
    );
    expect(desktopWords('PDF has been sanitized and downloaded.')).toBe(
      'PDF has been sanitized.'
    );
    // A PDF result opens in a new tab: it's created, not on disk yet
    expect(desktopWords('Signed PDF downloaded successfully!')).toBe(
      'Signed PDF created successfully!'
    );
    expect(desktopWords('Preparing download...')).toBe('Preparing the file...');
    expect(desktopWords('Downloads started for all files.')).toBe(
      'All files are ready.'
    );
  });

  it('chooses files instead of uploading them', () => {
    expect(desktopWords('Upload certificate (.pfx, .p12, .pem)')).toBe(
      'Choose certificate file (.pfx, .p12, .pem)'
    );
    expect(desktopWords('Upload PDFs')).toBe('Choose PDFs');
    expect(desktopWords('Click to Upload Image')).toBe('Click to Choose Image');
    expect(desktopWords('Please upload a PDF file first.')).toBe(
      'Please choose a PDF file first.'
    );
    expect(desktopWords('Draw, type, or upload your signature.')).toBe(
      'Draw, type, or use an image of your signature.'
    );
    expect(
      desktopWords('All pages from your uploaded PDFs are shown below.')
    ).toBe('All pages from your PDFs are shown below.');
    expect(desktopWords('No PDF files uploaded in PDF Input node')).toBe(
      'No PDF files added in PDF Input node'
    );
    expect(desktopWords('Click a tool to open the file uploader')).toBe(
      'Click a tool to open the file picker'
    );
    expect(desktopWords("You're prompted for the password on upload")).toBe(
      "You're prompted for the password on opening"
    );
  });

  it("says it's on your computer, not in your browser", () => {
    expect(desktopWords('Your files never leave your device.')).toBe(
      'Your files never leave your computer.'
    );
    expect(desktopWords('This tool uses CoherentPDF in your browser.')).toBe(
      'This tool uses CoherentPDF on your computer.'
    );
    expect(desktopWords('Your private key never leaves your browser.')).toBe(
      'Your private key never leaves your computer.'
    );
    expect(desktopWords('Fill in forms directly in the browser.')).toBe(
      'Fill in forms directly in Paperwing.'
    );
    expect(
      desktopWords('The browser ran out of memory while converting.')
    ).toBe('Paperwing ran out of memory while converting.');
    // Pages wrap lines mid-phrase
    expect(desktopWords('combined in your\n      browser by cpdf')).toBe(
      'combined on your computer by cpdf'
    );
  });

  it('keeps what is true in the desktop app too', () => {
    for (const kept of [
      'Your files are never uploaded, nobody else sees your documents',
      'Everything runs locally, and nothing is uploaded.',
      'Most PDF tools upload your files to a server for processing.',
      'Is my PDF uploaded when I add a watermark?',
      'Does the editor upload my PDF?',
      'There are no uploads, no history logs.',
      'First load takes a moment as we download our conversion engine.',
      'The PyMuPDF engine, which downloads on first use, takes longer.',
      'A font needed for some characters could not be downloaded.',
      'Half a megabyte is the most forgiving of the common upload limits.',
      'Better than a download link',
      'Avoid common browser shortcuts',
    ])
      expect(desktopWords(kept)).toBe(kept);
  });

  it('never touches names, paths or identifiers', () => {
    const code = 'id=download-btn ./download-node a.download x.browser.min.js';
    expect(desktopWords(code)).toBe(code);
    expect(desktopWords('#tool-uploader @scope/browser')).toBe(
      '#tool-uploader @scope/browser'
    );
  });

  it('pages: text and tooltips, not markup or scripts', () => {
    const html =
      '<button id="download-btn" class="download" data-i18n="common.download" title="Download">' +
      '<i data-lucide="download"></i>Download</button>' +
      '<input placeholder="Upload a file" name="upload">' +
      '<script>const label = "Download";</script>' +
      '<style>.upload { color: red }</style>';
    expect(desktopHtml(html)).toBe(
      '<button id="download-btn" class="download" data-i18n="common.download" title="Save">' +
        '<i data-lucide="download"></i>Save</button>' +
        '<input placeholder="Choose a file" name="upload">' +
        '<script>const label = "Download";</script>' +
        '<style>.upload { color: red }</style>'
    );
  });

  it('strings: values, not the keys the code looks up', () => {
    expect(
      desktopStrings({
        common: { download: 'Download', upload: 'Upload PDFs' },
        'Upload PDFs': 'Upload PDFs',
      })
    ).toEqual({
      common: { download: 'Save', upload: 'Choose PDFs' },
      'Upload PDFs': 'Choose PDFs',
    });
  });

  it('code: the text in strings, not imports, selectors, keys or comparisons', () => {
    const code = [
      "import './download-node';",
      "const m = await import('@scope/lib/browser');",
      "showAlert('Error', 'Please upload a PDF first.');",
      "btn.textContent = trText('Download Edited PDF');",
      'el.innerHTML = \'<i data-lucide="download"></i> Download\';',
      'document.querySelector(\'[title="Download"]\');',
      "if (mode === 'Upload Files') run();",
      "const labels = { 'Download PDF': 1 };",
      "const k = t('common.download');",
      "super('Download');",
      '// Download the file (a comment)',
    ].join('\n');
    expect(desktopCode(code, 'page.ts').split('\n')).toEqual([
      "import './download-node';",
      "const m = await import('@scope/lib/browser');",
      "showAlert('Error', 'Please choose a PDF first.');",
      "btn.textContent = trText('Save Edited PDF');",
      'el.innerHTML = \'<i data-lucide="download"></i> Save\';',
      'document.querySelector(\'[title="Download"]\');',
      "if (mode === 'Upload Files') run();",
      "const labels = { 'Download PDF': 1 };",
      "const k = t('common.download');",
      "super('Save');",
      '// Download the file (a comment)',
    ]);
  });

  it('the English strings: what still says upload, download or browser is meant', () => {
    const shown = /\bupload|\bdownload|\bbrowser\b|your device/i;
    const left: string[] = [];
    for (const file of ['common', 'tools']) {
      const json = desktopStrings(
        JSON.parse(
          readFileSync(
            resolve(__dirname, `../../public/locales/en/${file}.json`),
            'utf8'
          )
        )
      );
      const walk = (v: unknown) => {
        if (typeof v === 'string') {
          if (shown.test(v)) left.push(v);
        } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(json);
    }
    // Each one is true in the desktop app (nothing is uploaded; the engines
    // and fonts are downloaded), or a website-only FAQ the app never shows
    const meant =
      /never upload|no uploads?\b|never leave|not uploaded|uploaded to any server|upload your files to a server|no upload or download step|download our conversion engine|could not be downloaded|browser shortcuts|browser\/system|modern web browser/i;
    expect(left.filter((s) => !meant.test(s))).toEqual([]);
  });
});
