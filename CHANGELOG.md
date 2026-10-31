# Changelog

All notable changes to Paperwing are documented here. Paperwing follows
[Semantic Versioning](https://semver.org). Changes to the underlying PDF engine are listed in
[BentoPDF's releases](https://github.com/alam00000/bentopdf/releases).

## [Unreleased]

### Added

- **Fill in forms right on the page**, as in Chrome or Acrobat: click a field and type, tick
  checkboxes, choose radio buttons, pick from dropdowns and lists, and Tab from field to field.
  Text in any script works, including Cyrillic, Chinese and Hindi. Fields show as the document
  draws them, and stay fields when saved (nothing is flattened). A Form fields panel lists the same
  fields, and Highlight fields tints them on the page; required fields are outlined. Read-only
  fields stay locked; signature fields lead to Fill & Sign. Ctrl+Z takes back a change. Old
  Adobe XFA forms, which only Acrobat can fill in, say so. Reported by
  [@austinwilkerson](https://github.com/austinwilkerson) in
  [#26](https://github.com/rohanvijaykumar/paperwing/issues/26).
- **A print dialog like Acrobat's**, the same on Windows, macOS and Linux, with a preview of exactly
  what will print: the printer (your default one is chosen first), copies, color or black and white,
  two-sided; all pages, the current page or a range like `1-3, 5`, odd or even pages, reversed; the
  paper size and orientation; fit to the paper, actual size, shrink oversized pages or a custom
  scale; several pages to a sheet; booklets; and whether comments print. Text stays text, and comments
  and filled-in forms print as they show. Printing in Fill a form, Fill & Sign and Add Stamps prints
  what you filled in, signed or stamped there. Thanks to
  [@austinwilkerson](https://github.com/austinwilkerson), whose
  [#24](https://github.com/rohanvijaykumar/paperwing/pull/24) showed the way.
- **Form scripts run**, as in Acrobat and browsers: totals worked out as you fill in, numbers and
  dates formatted, entries checked, and the document's messages (such as instructions when it
  opens) shown. They run sandboxed, in the same engine Firefox uses: they can't reach your files or
  the internet, or send the form anywhere. Preferences ▸ Run form scripts turns them off; a notice
  then says the document has some. Reported by
  [@austinwilkerson](https://github.com/austinwilkerson) in
  [#27](https://github.com/rohanvijaykumar/paperwing/issues/27).

### Changed

- Every tool looks like the rest of Paperwing, in light and dark: the same fields, buttons, panels,
  headings, notes and upload boxes throughout. Scan & OCR's Advanced settings were dark in the light
  theme and set apart from the rest; they now open like the other tools' settings.
- The tools say Paperwing where they said BentoPDF (titles, messages, the files some tools save).
  BentoPDF is still credited in About, the README and NOTICE.md.
- Booklet printing explains how to print both sides on a printer that prints one side.

### Fixed

- A tool's messages under its main button (Table of Contents' "no bookmarks" error, for one) were
  partly hidden behind it.
- Preferences scrolled although everything in it fitted, and long dialogs' scroll bars squared off
  their rounded corners. Dialogs now grow to fit the window and only scroll when it's too small.
- After Export in Edit a PDF, going back to the document's tab showed a blank page once its
  "saved" message was closed. The editor now stays open with your edits, and any tool that would
  go back to an empty upload screen gets the document again instead.
- Saved form values and checkbox marks didn't show in the viewer. Thanks to
  [@austinwilkerson](https://github.com/austinwilkerson)
  ([#25](https://github.com/rohanvijaykumar/paperwing/pull/25)).
- Printing from the desktop app sent nothing to the printer (found on Windows in
  [#24](https://github.com/rohanvijaykumar/paperwing/pull/24)).
- Markdown to PDF's Export PDF opened a print dialog that couldn't preview in the desktop app. The
  PDF now opens as a document, ready to save or print.

## [1.2.3] — 2026-10-28

### Changed

- Paperwing checks for updates every time it starts (before, a launch within an hour of the last check
  skipped it, so a release could go unnoticed for hours), and every two hours while it's open instead
  of six. Choosing **Later** on the notice now holds it back for a day, so checking on every launch
  doesn't show it each time you open Paperwing; **Help ▸ Check for updates** always shows it.
- Built on Electron 45 (from 44.8), with electron-builder 26.18 and electron-updater 6.8.11.

### Fixed

- On touchscreen Windows computers, **Select** (V) could leave the viewer in Hand mode, so text
  couldn't be selected or copied
  ([#20](https://github.com/rohanvijaykumar/paperwing/issues/20)). Select now always selects text,
  and Hand (H) still pans. Thanks to [@Lehnemann](https://github.com/Lehnemann) for reporting it
  and [@austinwilkerson](https://github.com/austinwilkerson) for the fix
  ([#19](https://github.com/rohanvijaykumar/paperwing/pull/19)).
- Long file paths in tooltips (hovering a tab or a Recent file) ran off the edge of the window. They
  now wrap after a folder and stay inside it.
- On Windows, the taskbar's **Recent** list showed only one of several files with the same name
  (versions of a document kept in different folders, say): Windows keeps one entry per file name.
  Paperwing now keeps its own list of the last 10 files, with the folder after the name when files
  share one. Home ▸ Clear recent clears it too.

### From BentoPDF

Fixes from BentoPDF's main branch since 2.8.10 (not yet in a BentoPDF release):

- **Validate Signature** detects signatures whose dictionary has no `/Type` entry.
- **XPS to PDF** repairs XPS files from scanners that failed to convert.
- **Merge PDF** shows clearer result and error messages.
- **Markdown to PDF**: wide tables fit when printing, and the editor panes no longer collapse.

## [1.2.2] — 2026-10-27

### Added

- Paperwing has a website: [paperwingapp.com](https://paperwingapp.com). **Help ▸ Paperwing website**
  and the About box link to it.
- Files with the same name are told apart: tabs and Home's Recent list show the folder each one is
  in (`Rohan_Resume.pdf  Acme Corp` / `Rohan_Resume.pdf  Globex`), and hovering shows the full path.
- When another app saves a PDF that's open in Paperwing, a notice says so, with **Reload** to show the
  new version (keeping the page and zoom) or **Dismiss** to keep working on the one you have.
- Saving asks first if another app saved a newer version of the file since you opened it: replace it,
  save yours as a copy, or cancel.
- Right-click a tab for **Close**, **Close other tabs**, **Close tabs to the right**, **Show in File
  Explorer** (Finder on macOS), **Copy path** and **Reopen closed document**.
- The window opens at the size and place you left it, maximized if it was. If that place is on a
  screen that's no longer connected, it opens at the default place instead.

### Fixed

- Opening a PDF that's already open in a tab, after another app saved a new version of it (a resume
  regenerated under the same name, say), showed the old version until Paperwing was restarted. Paperwing
  now compares the file on disk with what the tab shows: it loads the new version in place, keeping the
  page and zoom, and asks first if the tab has unsaved changes. Opening an unchanged file still just
  switches to its tab.
- Served from a web server (self-hosting), changing the theme while a tool was still loading could
  switch it back: the tool applied the theme it was opened with and saved it over your choice. The
  desktop app wasn't affected.

## [1.2.1] — 2026-10-19

### BentoPDF 2.8.10

Paperwing now builds on BentoPDF 2.8.10 (from 2.8.8):

- Security hardening of Sanitize, Flatten, Redact and signature validation (hidden content and form
  fields are removed more thoroughly, redaction also clears document data, signature checks are
  stricter)
- A newer PDF engine and viewer
- Translation fixes
- Three tools have new internal names (PDF to Word, Protect, Unlock); pinned and recently used tools
  follow them

### Changed

- Paperwing looks for updates each time it starts (at most once an hour) and every 6 hours while
  it's open, instead of once a day: a new version could go unnoticed for a day if Paperwing had
  checked shortly before
- The Windows installer no longer downloads updates by itself: a notice (and a dot on Help) says a
  new version is available, and it downloads only when you choose **Update**, showing its
  progress, then offers **Restart now** or **Later**

### Fixed

- Keyboard shortcuts in tooltips were barely readable (grey on grey) in both light and dark
  themes; they're now shown as an outlined key in high-contrast text
- The Windows taskbar icon was still a few pixels smaller than other apps' (a 1 px margin in the
  32 and 40 px sizes used at 125–150% scaling); it's now edge to edge at every size, and Linux gets
  a full-size icon too (macOS keeps Apple's standard icon grid)
- Tooltips could fail to appear while the document view scrolled or moved focus on its own
- Validate Signatures showed a valid signature as unverified when its signer's certificate wasn't
  the first one in the signature

## [1.2.0] — 2026-10-19

### Added

- Toolbar buttons with related tools work like Acrobat's: the arrow (or a right-click or long
  press) opens the related tools, the one you pick becomes the button's tool, and the choice is
  remembered. Select | Hand | Marquee zoom, Note | Stamp, Highlight | Underline | Strikethrough |
  Squiggly | Highlighter, Pen | Line | Arrow | Rectangle | Oval | Polygon, Text | Callout
- Tooltips everywhere, in the workspace and every tool, with the keyboard shortcut
- Page thumbnails: right-click a page to rotate, insert a blank page or pages from another file,
  extract, move or delete it, or drag it to a new place. Ctrl/Cmd+click and Shift+click select
  several pages, which then rotate, extract, delete and move together. Drop PDFs onto the
  thumbnails to insert their pages there. Ctrl+Z undoes page changes
- Unsaved edits to any document are kept safe every few seconds and come back after a crash
  (named "… (Recovered).pdf" when the original file exists)
- Closing a full-page tool with unsaved work (Edit a PDF, Prepare a form, Organize pages…) asks
  first
- Recent files in the Windows taskbar jump list and the macOS Dock menu; Clear recent clears
  them too
- macOS and the Windows portable build: a new version's notice stays until you choose Download
  or Later, Help shows a dot (and **Download Paperwing …**) until you've updated, and Download
  fetches the file for your computer (the DMG for your Mac's chip, or the portable zip) instead
  of opening the release page
- PDFs that use the standard fonts without embedding them (Times, Helvetica, Courier, Calibri,
  Cambria…) are drawn in metric-compatible fonts, so text keeps its look and spacing

### Changed

- The PyMuPDF, Ghostscript and coherentpdf engines ship with the app: PDF to Word, PDF/A, Font
  to Outline, Rasterize and the other tools that use them no longer download anything from a
  CDN, and work offline (the installer grows accordingly)
- Scan & OCR works offline in English: the Tesseract engine, the English data and the text-layer
  font ship with the app. Other languages, and text-layer fonts for non-Latin scripts, download
  once when first used (before, all of it came from a CDN)
- Tools show only what makes sense inside Paperwing: no website sections, no second upload box
  or "remove file" for the open document, no duplicate Download, Print or Open buttons in the
  embedded viewers, and no main button before there's anything to do
- Recently used tools appear under the name you opened them with
- Taskbar and Dock icons are sized like other apps' (the Windows icon was too small)

### Fixed

- Tools briefly showed their upload screen or website header before the document appeared
- Copying text from some PDFs (e.g. made by wkhtmltopdf) gave tabs instead of spaces, and search
  couldn't find phrases in them
- Clicking a rail button or a tool while a full-page tool was open did nothing
- Edit a PDF: changing a text's font had no effect, System fonts showed an error, and text whose
  spaces are tabs exported with broken lines
- Fill & Sign and Fill a form failed to save, and Timestamp couldn't reach the timestamp server
- Results downloaded from the embedded PDF viewers went to Downloads instead of opening in
  Paperwing
- Fill & Sign opened with the Highlight tool selected

## [1.1.0] — 2026-10-14

### Added

- Home shows a preview of each recent file's first page, in the list and the grid
- File Explorer shows PDF thumbnails (Windows) while Paperwing is the default PDF app
- Pick or type any zoom percentage from the right rail (or Ctrl+Y)
- The open side panel's rail button is highlighted, pressing it again closes the panel, and a
  **Hide panel** button appears while one is open
- **Clear recent** on Home (starred files stay)
- Documents reopen at the page and zoom they were left at (a Preferences switch turns it off)
- Right-click a recent file: Open, Show in File Explorer / Finder, Copy path, Compress, Combine
  with other files, Star, Remove
- Batch: starting a tool that takes many files (Compress, Flatten, Repair, PDF to Word, PDF/A…)
  without a document and picking several PDFs runs it on all of them at once
- The Windows installer updates itself: new versions download in the background and install on
  restart (Restart now / Later) or on the next quit

### Changed

- No launch screen: the window appears as soon as it's ready, in about a second instead of
  two and a half
- Session restore brings back every tab at once but loads only the one in front; the others
  load when you open them
- Scrolling uses a quarter of the CPU it did and stays at 60 fps on long and scanned documents
- The Latin fallback font ships with the app, so opening a PDF never downloads one
- About uses the launch screen's look; Home no longer has a **Your computer** entry (it only
  opened the file dialog, like **Select a file**) or a sidebar: Recent | Starred is the heading
- Documents made by tools open as unsaved: closing asks Save / Don't save, they stay out of
  Recent until saved, and a recovery copy brings them back after a crash. (Before, they were kept
  as copies in the app's database, or not at all over 40 MB, and closing didn't warn.)
- Files dropped onto the window open by their real path, like files from the Open dialog
- Going to a page number jumps there instead of scrolling past every page

### Fixed

- Ctrl+mouse wheel zoomed out to the minimum in one notch; it now zooms in even, smooth steps
- The Automatic zoom preference (fit width, up to 150%) was sometimes ignored
- Escape didn't close a popover pressed right after it opened

## [1.0.1] — 2026-10-12

### Changed

- Annotation styles (colour, opacity, stroke width…) open in the right sidebar beside the
  navigation rail, instead of on the left over the floating annotation toolbar
- New **Annotation style** button on the right rail

## [1.0.0] — 2026-10-12

First public release, built on BentoPDF 2.8.8.

### Added

- Desktop app for Windows (installer and portable `.zip`) and macOS (Apple Silicon and Intel)
- Acrobat-style workspace: tabbed documents, Home with recent and starred files, a searchable All tools sidebar,
  Edit / Convert / E-Sign tool panels, floating quick-action toolbar and right navigation rail
- Built-in viewer with comments, highlights, drawing, text boxes, shapes, stamps, links and redaction
- Password-protected PDFs open after a password prompt
- Every BentoPDF tool runs beside the open document (side panel, or the document area for editors); tools that start from other files open in a workspace tab where the result appears
- Light and neutral dark themes that follow the system, with an override in Preferences
- Acrobat-compatible keyboard shortcuts including single-key tool accelerators; macOS menu bar
- Command palette (Shift+Ctrl+P), pinned and recently used tools
- Unsaved-change indicators, save prompts when closing tabs or the window, session restore and
  reopen closed tab (Shift+Ctrl+T)
- Preferences, document properties, zoom to, read mode and full screen
- Native open/save dialogs, "Save" back to the original file, PDF file association, single instance
- Optional once-a-day update check against GitHub Releases
- Launch screen that appears on its own before the main window, and background warm-up of the PDF engine for fast first open
- Small download: the LibreOffice engine for Office → PDF conversion is fetched once on first use (SHA-256 verified), and unused Chromium files are trimmed
- Automatic default zoom (fit width, up to 150%), configurable in Preferences
- Tool pages run on their own origin, isolated from the workspace and its file bridge (see [SECURITY.md](SECURITY.md))
- Unit tests for the shell and an end-to-end UI test suite

[Unreleased]: https://github.com/rohanvijaykumar/paperwing/compare/v1.2.3...HEAD
[1.2.3]: https://github.com/rohanvijaykumar/paperwing/releases/tag/v1.2.3
[1.2.2]: https://github.com/rohanvijaykumar/paperwing/releases/tag/v1.2.2
[1.2.1]: https://github.com/rohanvijaykumar/paperwing/releases/tag/v1.2.1
[1.2.0]: https://github.com/rohanvijaykumar/paperwing/releases/tag/v1.2.0
[1.1.0]: https://github.com/rohanvijaykumar/paperwing/releases/tag/v1.1.0
[1.0.1]: https://github.com/rohanvijaykumar/paperwing/releases/tag/v1.0.1
[1.0.0]: https://github.com/rohanvijaykumar/paperwing/releases/tag/v1.0.0
