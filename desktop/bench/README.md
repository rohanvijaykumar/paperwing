# Desktop benchmarks

Scripts that drive the real Electron app (unpackaged, serving `../dist`) with a
throwaway profile, so they never touch your own recent files or settings.
Build the web app first (`npm run build:web`). Windows open and close while
they run.

| Script                                                                   | Measures                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startup.mjs [runs]`                                                     | Time until the window is shown, plus renderer paint timings                                                                                                                                                           |
| `interact.mjs <pdf> [runs] [session pdfs…]`                              | Launch with a file, opening while running, session restore, scrolling (frame times and unrendered area), jumping, Home, opening a tool. `BENCH_ONLY=open,scroll,…` picks scenarios                                    |
| `check-open-running.mjs`                                                 | Opening PDFs from the OS while the app runs: each comes to the front, already-open files switch, a file changed on disk reloads (asks first if there are unsaved edits), saving doesn't count as a change (pass/fail) |
| `check-qol.mjs`                                                          | Same-named files show their folder, the tab right-click menu, the notice when another app saves an open file, asking before saving over a newer version, the window coming back at its size and place (pass/fail)     |
| `check-print.mjs [pdf…]`                                                 | Printing in real Electron: the PDF viewer reports documents loaded (twice in one session), the OS default printer is found and preselected, a web page becomes a PDF. Prints nothing (pass/fail)                      |
| `check-branding.mjs`                                                     | BentoPDF's name only where Paperwing credits it, in the built tool pages, interface strings and code (pass/fail)                                                                                                      |
| `capture-tools.mjs <out-dir> [filter…]`                                  | Every tool in the light and dark theme, scrolled through, with its settings sections opened, for reviewing how they look                                                                                              |
| `wheel-zoom.mjs <pdf>`                                                   | Ctrl+mouse-wheel zoom steps (pass/fail)                                                                                                                                                                               |
| `profile.mjs <pdf>` / `profile-scroll.mjs <pdf>`                         | CPU profile (top functions) while opening / scrolling                                                                                                                                                                 |
| `network.mjs <pdf…>`                                                     | Every request that leaves the machine                                                                                                                                                                                 |
| `screens.mjs <out-dir> <pdf…>`                                           | Screenshots of the main screens                                                                                                                                                                                       |
| `make-fixture.mjs <out> [pages]` / `make-scan-fixture.mjs <out> [pages]` | Heavy test PDFs (text and vector / scanned pages)                                                                                                                                                                     |

Set `BENCH_TMP` to keep profiles and Chromium's temp files off the system drive.
Timings vary with what else the machine is doing: compare medians over several
runs, before and after a change.
