## Paperwing 1.2.0

Works like you'd expect, everywhere: smarter toolbars, page actions on thumbnails, and every
tool offline.

### New

- **Toolbar buttons that remember.** Click the small arrow on Highlight, Draw, Comment, Text or
  Select (or right-click it) to pick a related tool: Underline, Rectangle, Arrow, Callout, Hand
  and more. The tool you pick stays on the button.
- **Tooltips** on every button, with its keyboard shortcut.
- **Page actions in the thumbnails.** Right-click a page to rotate, insert, extract, move or
  delete it, or drag it to a new place. Ctrl+click or Shift+click to work on several pages at
  once, and drop a PDF onto the thumbnails to insert its pages there. Ctrl+Z undoes it.
- **Your edits survive a crash.** Unsaved changes are kept safe every few seconds and come back
  when Paperwing reopens.
- **No more lost work in tools.** Closing Edit a PDF, Prepare a form or Organize pages with
  unsaved changes asks first.
- **Recent files in the taskbar and Dock.** Right-click Paperwing's icon to reopen them.
- **Updates you won't miss (macOS and portable).** The notice stays until you act on it, Help
  shows a dot until you've updated, and Download fetches the right file for your Mac or PC.
- **Truer fonts.** PDFs that rely on standard fonts they don't include (Times, Arial,
  Courier, Calibri, Cambria…) now keep their look and spacing.

### Better

- **Advanced tools work offline.** The engines for PDF to Word, PDF/A, Font to Outline, OCR (in
  English) and the other advanced tools now come with the app instead of downloading on first
  use.
- **Cleaner tools.** No more duplicate Download buttons, second upload boxes or leftover website
  text: each tool shows just what it needs.
- **Crisper icon** in the Windows taskbar, the same size as other apps'.

### Fixed

- Tools no longer flash their upload screen before your document appears.
- Copying text from some PDFs gave tabs instead of spaces, and search missed phrases in them.
- The side rail and tool list didn't respond while a full-page tool was open.
- Edit a PDF: changing a font now works, System fonts no longer shows an error, and exported text
  keeps its lines.
- Fill & Sign, Fill a form and Timestamp work again.

Paperwing will tell you about this update (it checks once a day). Download it below and install
it over the old version; if you have 1.1 on Windows, it updates itself. Full list of changes: [CHANGELOG.md](https://github.com/rohanvijaykumar/paperwing/blob/main/CHANGELOG.md).

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
