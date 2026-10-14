# Patches to BentoPDF code

Paperwing keeps BentoPDF's code unmodified wherever possible, so new BentoPDF releases merge in
cleanly. The exceptions are listed here. When merging a BentoPDF release, check whether upstream
has fixed each one; if it has, take upstream's version and remove the entry.

| File                                     | Change                                                                                                            | Why                                                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vite.config.ts`                         | Two lines registering `reskin/vite-plugin-reskin.ts`                                                              | Injects Paperwing's integration layer at build time                                                                                                                              |
| `src/js/editcore/streamsplice.js`        | The `TJ` array pattern in `showOperators` no longer lets a backslash match two ways                               | Catastrophic regex backtracking (ReDoS) on crafted PDF content streams (CodeQL `js/redos`)                                                                                       |
| `src/js/editcore/type3surgery.js`        | The array branch of `TOKEN_RE` no longer lets `(` and `<` match both as string/hex starts and as plain characters | Same ReDoS class (CodeQL `js/redos`)                                                                                                                                             |
| `src/js/editcore/app.js`                 | The `?demo=` parameter only loads same-origin files                                                               | A crafted link could make the editor fetch a document from any server (CodeQL `js/client-side-request-forgery`)                                                                  |
| `src/js/utils/markdown-editor.ts`        | Mermaid's SVG output is re-sanitized with DOMPurify using Mermaid's strict settings (labels are kept)             | Defence in depth before `innerHTML` (CodeQL `js/xss-through-dom`)                                                                                                                |
| `src/js/logic/validate-signature-pdf.ts` | RSA PKCS#1 v1.5 signatures are verified with Web Crypto only, not node-forge                                      | node-forge accepts malformed DigestInfo, so forged signatures could validate ([GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)); no fixed release exists |
| `scripts/security-patterns-check.mjs`    | File-name filter rewritten without an ambiguous regex                                                             | CodeQL `js/regex/missing-regexp-anchor` (behaviour unchanged)                                                                                                                    |

Upstream commits cherry-picked ahead of a full merge:

- `46bf0fb` Enforce file origin check in annotation PDF viewer

## Patches to the viewer package

The EmbedPDF viewer (`bentopdf-viewer`, a BentoPDF dependency) is patched while
building, by `reskin/vite-plugin-reskin.ts`; the package itself isn't changed.
Each patch checks that the code it replaces is there exactly as expected and is
skipped with a warning otherwise (for example after a viewer update).
`PAPERWING_VIEWER_PATCHES=0` builds without them.

| Patch          | Why                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State snapshot | The viewer's store copied its whole state on every read, once per listener on every change: half of the main thread while scrolling. One snapshot per change now |
| Wheel zoom     | Ctrl+mouse wheel zoomed out to the minimum in one notch (and doubled per notch in). About 15% per notch now, eased; trackpad pinches unchanged                   |
