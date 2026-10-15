# Changelog

All notable changes to Paperwing are documented here. Paperwing follows
[Semantic Versioning](https://semver.org). Changes to the underlying PDF engine are listed in
[BentoPDF's releases](https://github.com/alam00000/bentopdf/releases).

## [Unreleased]

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

[1.0.1]: https://github.com/rohanvijaykumar/paperwing/releases/tag/v1.0.1
[1.0.0]: https://github.com/rohanvijaykumar/paperwing/releases/tag/v1.0.0
