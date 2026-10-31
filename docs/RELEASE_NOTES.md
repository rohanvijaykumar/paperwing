## Paperwing 1.2.4

Fill in forms right on the page, form scripts that run, and a print dialog and full screen like
Acrobat's.

### New

- **Fill in forms on the page.** Click a field and type, tick checkboxes, choose radio buttons,
  pick from dropdowns and lists, and Tab from field to field, onto the next page too. The fields are
  Firefox's own, so they respond at once, and text in any script works (Cyrillic, Chinese, Hindi…).
  Fields fill in with the Hand tool too, as in Acrobat. A Form fields panel lists the same fields,
  always in step with the page; Ctrl+Z takes back a change. Filled-in forms stay forms when saved. Old Adobe XFA forms, which only Acrobat can fill
  in, say so. Thanks to [@austinwilkerson](https://github.com/austinwilkerson) for reporting it
  ([#26](https://github.com/rohanvijaykumar/paperwing/issues/26)).
- **Form scripts run.** Totals are worked out as you fill in, numbers and dates are formatted,
  entries are checked, and a document's messages show as Paperwing's own dialog. Scripts run
  sandboxed, in the same engine Firefox uses: they can't reach your files or the internet, or send
  the form anywhere. Preferences ▸ Run form scripts turns them off. Thanks to
  [@austinwilkerson](https://github.com/austinwilkerson)
  ([#27](https://github.com/rohanvijaykumar/paperwing/issues/27)).
- **A print dialog like Acrobat's**, with a preview of exactly what will print: printer, copies,
  color or black and white, two-sided, page ranges, odd or even pages, paper size and orientation,
  fit or actual size, several pages to a sheet, booklets, and whether comments print. Text stays
  text. Printing in Fill a form, Fill & Sign and Add Stamps prints what you filled in, signed or
  stamped there. Thanks to [@austinwilkerson](https://github.com/austinwilkerson), whose
  [#24](https://github.com/rohanvijaykumar/paperwing/pull/24) showed the way.
- **Full screen, as in Acrobat.** Ctrl+L shows one page at a time, as big as the screen allows, on
  black. The arrow keys, Space, the mouse wheel or a click turn the page, and Esc leaves. Read mode
  (Ctrl+H) still hides the toolbars inside the window.
- **What's new.** After an update, Paperwing offers these notes once; Help ▸ What's new shows them
  any time.

### Better

- **Every tool looks like Paperwing**, in light and dark, and carries its name throughout.
- **Open remembers your folder.** Ctrl+O starts where you last opened or saved a PDF, and Save As
  starts in the document's own folder, as in Acrobat.
- **Dialogs fit the window** and only scroll when it's too small.

### Fixed

- **File Explorer's previews of forms** show their fields and what was filled in (Windows).
- **Dropping PDFs from File Explorer** opens them. Thanks to [@Lehnemann](https://github.com/Lehnemann) for reporting it ([#30](https://github.com/rohanvijaykumar/paperwing/issues/30)).
- **Shortcuts follow your keyboard layout:** on Colemak, Dvorak, AZERTY or QWERTZ, Ctrl+Z is the key
  marked Z. Thanks to [@Lehnemann](https://github.com/Lehnemann) ([#29](https://github.com/rohanvijaykumar/paperwing/issues/29)).
- **Saved form values show** in the viewer. Thanks to
  [@austinwilkerson](https://github.com/austinwilkerson)
  ([#25](https://github.com/rohanvijaykumar/paperwing/pull/25)).
- **Printing works** from the desktop app on Windows.
- A tool's own **Close** (Organize pages) no longer shows a website page inside the tool, and Edit a
  PDF no longer goes blank after Export.
- Messages under a tool's main button are no longer hidden behind it.
- Saving, printing or opening a tool that fails now says why; Escape closes only the top dialog;
  page changes in a background tab stay in that tab; saving twice quickly can't mix the two.

<!-- end of the notes shown in the app -->

On Windows, Paperwing 1.1 and later update themselves: open Paperwing and choose **Help ▸ Check
for updates** if it hasn't offered 1.2.4 yet. On macOS and the portable build, download it below
and install it over the old version. Full list of changes: [CHANGELOG.md](https://github.com/rohanvijaykumar/paperwing/blob/main/CHANGELOG.md).
