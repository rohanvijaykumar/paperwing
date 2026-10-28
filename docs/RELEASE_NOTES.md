## Paperwing 1.2.3

Updates are noticed sooner, a touchscreen fix, and fixes from BentoPDF.

### Better

- **Updates found on every launch.** Paperwing now checks each time it starts, and every two hours
  while it's open, so a new version shows up right away. **Later** holds the notice back for a day.
- **Taskbar Recent list keeps every file.** On Windows, files with the same name used to replace each
  other in the taskbar's Recent list. Paperwing now keeps its own list of your last 10 files, showing
  the folder when names match.
- **Built on Electron 45.**

### Fixed

- **Select works on touchscreens.** On touchscreen Windows computers, Select could leave the viewer
  in Hand mode, so text couldn't be selected or copied. Thanks to
  [@austinwilkerson](https://github.com/austinwilkerson) for the fix.
- **Long paths in tooltips** wrap and stay inside the window.
- **From BentoPDF:** Validate Signature detects more signatures, XPS to PDF converts XPS files from
  scanners, and Merge PDF and Markdown to PDF are fixed.

Everything new in 1.2 (Acrobat-style toolbar menus, page actions on thumbnails, recovery of unsaved
edits, offline engines and OCR) is in the [1.2.0 release](https://github.com/rohanvijaykumar/paperwing/releases/tag/v1.2.0).

On Windows, Paperwing 1.1 and later update themselves: open Paperwing and choose **Help ▸ Check
for updates** if it hasn't offered 1.2.3 yet. On macOS and the portable build, download it below
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
