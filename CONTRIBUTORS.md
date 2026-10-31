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

## Bug reports

People whose bug reports led to a fix.

- [@Lehnemann](https://github.com/Lehnemann): Select from the floating bar stayed in Hand mode
  ([#20](https://github.com/rohanvijaykumar/paperwing/issues/20), 1.2.3); PDFs dragged in from File
  Explorer didn't open ([#30](https://github.com/rohanvijaykumar/paperwing/issues/30), 1.2.4); shortcuts didn't follow the keyboard layout ([#29](https://github.com/rohanvijaykumar/paperwing/issues/29),
  1.2.4)
- [@austinwilkerson](https://github.com/austinwilkerson): form fields couldn't be filled in
  ([#26](https://github.com/rohanvijaykumar/paperwing/issues/26), 1.2.4), and form scripts'
  messages didn't appear ([#27](https://github.com/rohanvijaykumar/paperwing/issues/27), 1.2.4)

To list everyone with commits in Paperwing (leaving out BentoPDF's commits and bots) and everyone
whose bug report was fixed, run `node desktop/scripts/contributors.mjs`.
