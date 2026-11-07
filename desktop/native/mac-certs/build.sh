#!/bin/bash
# Builds paperwing-certs, Paperwing's certificate helper for macOS (signing
# with Digital IDs in the Keychain and on smart cards; see
# PaperwingCerts.swift), universal: Apple silicon and Intel, macOS 12 and later.
#
#   desktop/native/mac-certs/build.sh [--test]
#
# Output: desktop/native/mac-certs/out/paperwing-certs. The packaging
# (scripts/after-pack.cjs) puts it in the app's Resources/certs. --test runs
# it: `list` must print a certs line, and an unknown ID must be refused.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/out"
mkdir -p "$out"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12.0" -framework Security \
    -o "$out/paperwing-certs-$arch" "$here/PaperwingCerts.swift"
done
lipo -create -output "$out/paperwing-certs" "$out/paperwing-certs-arm64" "$out/paperwing-certs-x86_64"
rm "$out/paperwing-certs-arm64" "$out/paperwing-certs-x86_64"
# Ad-hoc signed, as the app is (Apple silicon won't run unsigned code)
codesign --force --sign - "$out/paperwing-certs"
lipo -info "$out/paperwing-certs"

if [[ "${1:-}" == "--test" ]]; then
  listed="$("$out/paperwing-certs" list)"
  echo "$listed" | head -c 300; echo
  echo "$listed" | grep -q '^{"type":"certs"' || { echo "list printed no certs line"; exit 1; }
  set +e
  "$out/paperwing-certs" sign -Id kc:0000000000000000000000000000000000000000 -Hash AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= -Alg sha256 > "$out/sign.txt"
  code=$?
  set -e
  cat "$out/sign.txt"
  grep -q '"code":"key-unusable"' "$out/sign.txt" || { echo "an unknown ID wasn't refused"; exit 1; }
  [[ $code -eq 2 ]] || { echo "exit code $code, not 2"; exit 1; }
  rm "$out/sign.txt"
  echo "certificate helper ok"
fi
