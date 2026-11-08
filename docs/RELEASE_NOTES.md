## Paperwing 1.3.0

Scan straight into a PDF, sign with the Digital IDs already on your computer, and a new look for
Home and About.

### New

- **Create a PDF from a scanner.** Create ▸ Scanner (also in All tools ▸ Scan & OCR, Insert pages ▸
  From scanner, and the main menu's presets) opens a dialog like the print dialog. Every scanner is
  listed once: WIA and TWAIN on Windows, Image Capture on the Mac, and network scanners that need no
  driver (AirScan, eSCL, Mopria), found on their own or added by IP address. Preview on a flatbed
  and drag the box to scan just the document; presets for documents and photos; both sides, paper
  sizes, color mode, brightness and contrast, shown on the preview as you change them; clean-up
  (deskew, auto-crop, background and blank-page removal, and more); a small file or high quality.
  After each pass, rotate, reorder, rescan or delete pages, then scan more. The pages open as a new
  document, are added to an open one or any PDF, or are saved as several files, with text
  recognition (OCR) if you like. For scanners that only work with their own app (ScanSnap), Import
  from a scanner app picks up what it saves. Thanks to [@Lehnemann](https://github.com/Lehnemann)
  for suggesting it ([#35](https://github.com/rohanvijaykumar/paperwing/issues/35)).
- **Enhance scanned pages** (All tools ▸ Scan & OCR) runs the same clean-up on a PDF that's
  already scanned.
- **Sign with a certificate installed on your computer.** All tools ▸ Use a certificate ▸
  Digitally sign: drag a box on the page, choose a Digital ID from the Windows certificate store or
  the macOS Keychain (smart cards and USB tokens included), choose how the signature looks, and
  Sign. Your private key never leaves Windows, the Keychain or the card: the system signs, and asks
  for your PIN itself. You can also use a .pfx or .p12 file or create a self-signed ID, lock the
  document after signing, and add a timestamp. Thanks to u/dwbmb on Reddit for asking for it.
- **Validate signatures** reads ECDSA signatures, shows a signature's timestamp, lists document
  timestamps, and in the desktop app can trust the root certificates in the Windows certificate
  store or the Keychain (off by default).

### Better

- **A new look for Home and About.** Home has a soft, pearly sheen in the light theme and a deep,
  iridescent glow in the dark one. About Paperwing shows a flowing ribbon of colour, with the
  details on frosted glass.
- **No more "upload" and "download".** The tools came from a website and said "Upload
  certificate" or "Runs entirely in your browser", as if files went to a server. They never did:
  the tools now say Choose a file and Save, on your computer, and the Download button is now
  **Save a copy**. Thanks to u/dwbmb on Reddit for pointing it out.
- **BentoPDF 2.8.11** ([release notes](https://github.com/alam00000/bentopdf/releases/tag/v2.8.11)):
  measuring distances, perimeters and areas in Edit a PDF, a redesigned PDF Multi Tool that handles
  very large documents, and Compress on a new engine, Hyper Compress.
- **Electron 45.2.1**, the latest update of the framework Paperwing runs on.

### Fixed

- **Highlighted text can be copied.** With a highlight selected, Ctrl+C (⌘C on macOS) copies the
  text it marks, and its menu has Copy text; the same for underline, strikethrough and squiggly.
  Thanks to u/WildAd9195 on Reddit for reporting it
  ([#38](https://github.com/rohanvijaykumar/paperwing/issues/38)).
- **Signatures stay valid.** Saving a document with no changes writes it exactly as it was, and
  saving or signing a signed document you've changed asks first, offering to save a copy instead.
- **Validate signatures** is right about documents signed by several people, changed after
  signing, or timestamped, and says what each result means.
- **Dialogs work with the keyboard and screen readers:** a dialog takes focus when it opens, Tab
  stays inside it, and closing it returns focus to where you were. By
  [@BronzeKnuckles](https://github.com/BronzeKnuckles)
  ([#33](https://github.com/rohanvijaykumar/paperwing/pull/33)).
- In a browser, a save that fails no longer marks the document saved. By
  [@Rian199](https://github.com/Rian199)
  ([#36](https://github.com/rohanvijaykumar/paperwing/pull/36)).
- Form fields on rotated pages show in the right place, and signatures on rotated or cropped pages
  land where the box was drawn.

<!-- end of the notes shown in the app -->

On Windows, Paperwing 1.1 and later update themselves: open Paperwing and choose **Help ▸ Check
for updates** if it hasn't offered 1.3.0 yet. On macOS and the portable build, download it below
and install it over the old version. Full list of changes: [CHANGELOG.md](https://github.com/rohanvijaykumar/paperwing/blob/main/CHANGELOG.md).
