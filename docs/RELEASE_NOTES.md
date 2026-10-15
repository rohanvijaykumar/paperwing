## Paperwing 1.1.0

Faster, smoother and a little more polished, everywhere.

### Faster

- **Opens in about a second.** The launch screen is gone: the window appears as soon as it's
  ready, less than half the time it took before.
- **Smooth scrolling**, even through long and scanned documents: a steady 60 fps using a quarter
  of the CPU it used to.
- **Quicker restores.** Your last session's tabs come back instantly; each document loads when
  you open its tab.

### New

- **Previews on Home.** Recent files show their first page, in the list and the grid.
- **PDF thumbnails in File Explorer** (Windows) while Paperwing is your default PDF app.
- **Any zoom level.** Click the zoom percentage on the right rail (or press Ctrl+Y) to pick a
  preset or type your own.
- **Collapsible side panel.** The open panel's button is highlighted; click it again, or
  **Hide panel**, to close it.
- **Clear recent** on Home. Starred files stay.
- **Pick up where you left off.** Documents reopen at the page and zoom you left them at.
- **Right-click a recent file** to show it in File Explorer or Finder, copy its path, compress
  it, or combine it with other files.
- **Batch tools.** Start Compress, Flatten, PDF to Word and many more from Home, pick several
  PDFs, and they're all done in one go.
- **Automatic updates** (Windows installer, from this version on). New versions download in the
  background; restart when you're ready.
- **Nothing a tool makes gets lost.** Compressed, merged and converted documents open as unsaved:
  Paperwing asks before closing them and brings them back if it closes unexpectedly.

### Fixed

- **Ctrl+scroll zoom** jumped to the smallest size on the first notch out. It now zooms in
  even, smooth steps both ways.
- The **Automatic** zoom preference is applied reliably again.

Paperwing will tell you about this update (it checks once a day). Download it below and install
it over the old version; from 1.1 on, the Windows installer updates itself. Full list of changes: [CHANGELOG.md](https://github.com/rohanvijaykumar/paperwing/blob/main/CHANGELOG.md).

### Downloads

|                     |                                    |
| ------------------- | ---------------------------------- |
| Windows installer   | `Paperwing-Setup-*-x64.exe`        |
| Windows portable    | `Paperwing-Portable-*-win-x64.zip` |
| macOS Apple Silicon | `Paperwing-*-mac-arm64.dmg`        |
| macOS Intel         | `Paperwing-*-mac-x64.dmg`          |

These builds aren't code-signed yet. On Windows choose **More info ▸ Run anyway**; on macOS
right-click the app and choose **Open** the first time. Full instructions:
[docs/INSTALL.md](https://github.com/rohanvijaykumar/paperwing/blob/main/docs/INSTALL.md).
Checksums are in `SHA256SUMS.txt`.

Thanks to Alam and the BentoPDF contributors — Paperwing wouldn't exist without their engine.
