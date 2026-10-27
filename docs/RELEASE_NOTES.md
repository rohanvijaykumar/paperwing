## Paperwing 1.2.2

A fix for opening files that changed, and smoother work with many PDFs open at once.

### Fixed

- **Opening a file shows its latest version.** If a PDF was already open in a tab and another app
  saved a new version of it (a resume regenerated under the same name, say), opening it again
  showed the old version until Paperwing was restarted. Paperwing now loads the new version in
  place, keeping your page and zoom, and asks first if the tab has unsaved changes.

### Better

- **Same-named files told apart.** Tabs and Home's Recent list show which folder each file is in
  when two have the same name, and hovering a tab shows its full path.
- **Know when a file changes.** When another app saves a PDF you have open, Paperwing says so, with
  **Reload** to show the new version or **Dismiss** to keep working on yours.
- **No accidental overwrites.** Saving asks first if another app saved a newer version since you
  opened it: replace it, save yours as a copy, or cancel.
- **Tab menu.** Right-click a tab to close it, close the others or those to its right, show the
  file in File Explorer or Finder, copy its path, or reopen a document you closed.
- **The window remembers its place.** Paperwing opens at the size and position you left it,
  maximized if it was.

Everything new in 1.2 (Acrobat-style toolbar menus, page actions on thumbnails, recovery of unsaved
edits, offline engines and OCR) is in the [1.2.0 release](https://github.com/rohanvijaykumar/paperwing/releases/tag/v1.2.0).

On Windows, Paperwing 1.1 and later update themselves: open Paperwing and choose **Help ▸ Check
for updates** if it hasn't offered 1.2.2 yet. On macOS and the portable build, download it below
and install it over the old version. Full list of changes: [CHANGELOG.md](https://github.com/rohanvijaykumar/paperwing/blob/main/CHANGELOG.md).

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
