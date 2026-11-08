# Paperwing contributors

People who have worked on Paperwing itself: the desktop app, its interface and its releases.

Paperwing is built on [BentoPDF](https://github.com/alam00000/bentopdf), and keeps BentoPDF's history so
new BentoPDF versions can be merged in. That's why GitHub's contributor list for this repository also
shows BentoPDF's contributors. They're credited in BentoPDF's repository and in [NOTICE.md](NOTICE.md).

## Code

- [Rohan Vijaykumar](https://github.com/rohanvijaykumar): creator and maintainer
- [@austinwilkerson](https://github.com/austinwilkerson): Select works on touchscreen computers
  ([#19](https://github.com/rohanvijaykumar/paperwing/pull/19), 1.2.3); saved form values show in
  the viewer ([#25](https://github.com/rohanvijaykumar/paperwing/pull/25), 1.2.4); how printing
  works in the desktop app ([#24](https://github.com/rohanvijaykumar/paperwing/pull/24), 1.2.4)
- [@BronzeKnuckles](https://github.com/BronzeKnuckles): dialogs take and keep keyboard focus, for
  keyboard and screen-reader users ([#33](https://github.com/rohanvijaykumar/paperwing/pull/33),
  1.3.0); lint in CI ([#32](https://github.com/rohanvijaykumar/paperwing/pull/32), 1.3.0)
- [@Rian199](https://github.com/Rian199): a failed save in the browser no longer counts as saved
  ([#36](https://github.com/rohanvijaykumar/paperwing/pull/36), 1.3.0)

## Bug reports

People whose bug reports led to a fix, or whose suggestions became a feature.

- [@Lehnemann](https://github.com/Lehnemann): Select from the floating bar stayed in Hand mode
  ([#20](https://github.com/rohanvijaykumar/paperwing/issues/20), 1.2.3); PDFs dragged in from File
  Explorer didn't open ([#30](https://github.com/rohanvijaykumar/paperwing/issues/30), 1.2.4);
  shortcuts didn't follow the keyboard layout
  ([#29](https://github.com/rohanvijaykumar/paperwing/issues/29), 1.2.4); suggested scanning
  ([#35](https://github.com/rohanvijaykumar/paperwing/issues/35), 1.3.0)
- [@austinwilkerson](https://github.com/austinwilkerson): form fields couldn't be filled in
  ([#26](https://github.com/rohanvijaykumar/paperwing/issues/26), 1.2.4), and form scripts'
  messages didn't appear ([#27](https://github.com/rohanvijaykumar/paperwing/issues/27), 1.2.4)
- u/WildAd9195 (on Reddit): highlighted text couldn't be copied
  ([#38](https://github.com/rohanvijaykumar/paperwing/issues/38), 1.3.0)
- u/dwbmb (on Reddit): the tools said "upload" and "download", as if files went to a server
  (1.3.0), and asked for signing with the certificates installed on the computer (1.3.0)

To list everyone with commits in Paperwing (leaving out BentoPDF's commits and bots) and everyone
whose bug report was fixed, run `node desktop/scripts/contributors.mjs`.
