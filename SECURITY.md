# Security policy

## Supported versions

Security fixes are released for the latest version of Paperwing. Please keep your copy up to date —
the app tells you when a new release is available.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Instead, report them privately through
GitHub: go to the repository's **Security** tab and choose
**[Report a vulnerability](https://github.com/rohanvijaykumar/paperwing/security/advisories/new)**,
or email [security@paperwingapp.com](mailto:security@paperwingapp.com).

Include a description of the issue, steps to reproduce (a sample PDF if relevant), the Paperwing
version and your operating system. You can expect an acknowledgement within a few days.

If the vulnerability is in BentoPDF's tool code or one of its libraries (such as PDFium, PDF.js or
qpdf), we'll coordinate with the upstream maintainers.

## Security model

- All documents are processed locally. Paperwing has no servers, accounts or telemetry.
- The app's pages are served from private `app://` origins with cross-origin isolation; the renderer
  runs sandboxed with context isolation, and only a small, explicit file bridge is exposed to it
  (`desktop/preload.cjs`). The bridge handles PDF files only, and only writes back to files the
  user opened or saved through Paperwing (via a temporary file, so a crash can't corrupt them).
- Only the workspace page (`app://paperwing`) gets the bridge. BentoPDF's tool pages run in frames
  on a separate origin (`app://tools`), so the same-origin policy keeps them — and anything a
  crafted PDF might inject into them — away from the workspace and the bridge. Files and results
  are exchanged with `postMessage`, and both sides check the origin and sender of every message.
  The workspace origin serves no other pages, and frames can't be navigated to it.
- Permission requests (camera, microphone, location, notifications…) are denied.
- Links to websites open in your default browser, never inside the app, and neither the app nor
  its tool frames can navigate away from it.
- Network access is limited to the optional update check and on-demand engine downloads described
  in the [README](README.md#privacy). Downloaded engine files are checked against SHA-256 hashes
  built into the app before they're used.
- The Windows installer downloads updates over HTTPS from this repository's releases and checks
  each one against the SHA-512 listed in the release before installing it. The builds aren't
  code-signed yet, so that check guards against corrupted downloads, not against a compromised
  release.
