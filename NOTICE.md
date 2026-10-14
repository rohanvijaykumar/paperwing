# Notices and credits

Paperwing is a desktop PDF application built on top of **[BentoPDF](https://github.com/alam00000/bentopdf)**.

## BentoPDF — what Paperwing is built on

All PDF processing in Paperwing (the 100+ tools, the viewer integration, the
WebAssembly engines and their configuration) comes from BentoPDF.

- Project: <https://github.com/alam00000/bentopdf>
- Copyright © BentoPDF contributors
- License: GNU Affero General Public License v3.0 (AGPL-3.0-only)

Paperwing adds a desktop interface (`src/acro/`), a light theme and frame
integration for the tool pages (`src/reskin/`, `reskin/`), and the Electron
application (`desktop/`). These additions are released under the same
AGPL-3.0 license. BentoPDF's own application source is included unmodified
apart from a two-line change in `vite.config.ts` that registers the Paperwing
plugin and a few security fixes, all listed in
[`docs/UPSTREAM-PATCHES.md`](docs/UPSTREAM-PATCHES.md). Repository-level files were adapted for this project: the README
(BentoPDF's original is kept in `docs/BENTOPDF.md`), CONTRIBUTING, SECURITY,
CODE_OF_CONDUCT, the issue and pull request templates and the GitHub workflows.
BentoPDF's web-hosting files (Docker, nginx, Helm, Cloudflare and Unraid
configurations, the air-gap bundle) and its documentation website were removed,
as they don't apply to a desktop app; they remain available in the BentoPDF
repository.

BentoPDF's original README is preserved in [`docs/BENTOPDF.md`](docs/BENTOPDF.md).
If you find Paperwing useful, please consider
[sponsoring BentoPDF's author](https://github.com/sponsors/alam00000).

## Open-source components

Paperwing includes or loads the following projects (via BentoPDF unless noted).
Each remains under its own license.

| Component                                                                                     | Purpose                                          | License                                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| [EmbedPDF](https://github.com/embedpdf/embed-pdf-viewer)                                      | Document viewer & annotations                    | MIT                                                  |
| [PDFium](https://pdfium.googlesource.com/pdfium/)                                             | PDF rendering & editing core (WebAssembly)       | BSD-3-Clause / Apache-2.0                            |
| [pdf-lib](https://pdf-lib.js.org/)                                                            | PDF manipulation                                 | MIT                                                  |
| [PDF.js](https://mozilla.github.io/pdf.js/)                                                   | PDF rendering                                    | Apache-2.0                                           |
| [PDFKit](https://pdfkit.org/)                                                                 | PDF generation                                   | MIT                                                  |
| [qpdf](https://github.com/qpdf/qpdf) / [qpdf-wasm](https://github.com/neslinesli93/qpdf-wasm) | Repair, encryption, linearisation                | Apache-2.0                                           |
| [LibreOffice](https://www.libreoffice.org/) (WebAssembly build)                               | Office document conversion                       | MPL-2.0                                              |
| [wasm-vips](https://github.com/kleisauke/wasm-vips)                                           | Image encoding                                   | MIT / LGPL-2.1 (libvips)                             |
| [CoherentPDF (cpdf)](https://www.coherentpdf.com/)                                            | Content-preserving operations (loaded on demand) | AGPL-3.0                                             |
| [PyMuPDF](https://github.com/pymupdf/PyMuPDF)                                                 | Extraction & conversion (loaded on demand)       | AGPL-3.0                                             |
| [Ghostscript](https://github.com/ArtifexSoftware/ghostpdl)                                    | PDF/A & font outlining (loaded on demand)        | AGPL-3.0                                             |
| [Electron](https://www.electronjs.org/)                                                       | Desktop runtime (Paperwing)                      | MIT                                                  |
| [Lucide](https://lucide.dev/)                                                                 | Interface icons                                  | ISC                                                  |
| [Phosphor Icons](https://phosphoricons.com/)                                                  | Tool icons                                       | MIT                                                  |
| [Source Sans 3](https://github.com/adobe-fonts/source-sans)                                   | Interface typeface (Paperwing)                   | SIL OFL 1.1 — see `src/reskin/fonts/OFL-LICENSE.txt` |

The complete dependency list is in [`package.json`](package.json) and
[`desktop/package.json`](desktop/package.json).

## Added by Paperwing

| Component                                                       | Purpose                                                                            | License                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [Noto Sans](https://notofonts.github.io/) (Regular)             | Fallback font for text in fonts a PDF doesn't embed (`src/acro/fonts/`)            | SIL Open Font License 1.1 (`src/acro/fonts/OFL.txt`)                  |
| [PDFium binaries](https://github.com/bblanchon/pdfium-binaries) | Windows only: renders File Explorer thumbnails (`resources/thumbnails/pdfium.dll`) | BSD-3-Clause / Apache-2.0 (`resources/thumbnails/pdfium-LICENSE.txt`) |

## Trademarks

Adobe and Acrobat are trademarks of Adobe Inc. Paperwing is an independent
open-source project and is not affiliated with, endorsed by or sponsored by
Adobe Inc. References to Acrobat describe the kind of software Paperwing is an
alternative to. Paperwing does not use Adobe's logos, icons, fonts or code.

"BentoPDF" is the name of the upstream project and is used here only to credit it.
