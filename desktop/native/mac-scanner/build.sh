#!/bin/bash
# Builds paperwing-scan, Paperwing's scanner helper for macOS (see
# PaperwingScan.swift), universal: Apple silicon and Intel, macOS 12 and later.
#
#   desktop/native/mac-scanner/build.sh [--test]
#
# Output: desktop/native/mac-scanner/out/paperwing-scan. The packaging
# (scripts/after-pack.cjs) puts it in the app's Resources/scanner. --test runs
# it: with no scanner attached, it must list none and exit cleanly.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/out"
mkdir -p "$out"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12.0" -framework ImageCaptureCore \
    -o "$out/paperwing-scan-$arch" "$here/PaperwingScan.swift"
done
lipo -create -output "$out/paperwing-scan" "$out/paperwing-scan-arm64" "$out/paperwing-scan-x86_64"
rm "$out/paperwing-scan-arm64" "$out/paperwing-scan-x86_64"
# Ad-hoc signed, as the app is (Apple silicon won't run unsigned code)
codesign --force --sign - "$out/paperwing-scan"
lipo -info "$out/paperwing-scan"

if [[ "${1:-}" == "--test" ]]; then
  listed="$("$out/paperwing-scan" list)"
  echo "$listed"
  echo "$listed" | grep -q '"type":"scanners"' || { echo "list printed no scanners line"; exit 1; }
  set +e
  "$out/paperwing-scan" caps -Id not-a-scanner > "$out/caps.txt"
  code=$?
  set -e
  cat "$out/caps.txt"
  grep -q '"code":"no-scanner"' "$out/caps.txt" || { echo "an unknown scanner wasn't reported"; exit 1; }
  [[ $code -eq 2 ]] || { echo "exit code $code, not 2"; exit 1; }
  rm "$out/caps.txt"
  echo "scanner helper ok"
fi
