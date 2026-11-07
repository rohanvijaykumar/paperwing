#!/bin/bash
# macOS CI: a pretend AirScan (eSCL) scanner on this Mac, announced through
# Bonjour with dns-sd, the way a real scanner announces itself.
#
#   (a) escl.cjs must find it over multicast DNS and scan from it;
#   (b) the Swift helper (ImageCaptureCore, as Image Capture) is asked to list
#       and scan it too. If Image Capture doesn't offer it, the evidence is
#       printed (and the run isn't failed for that); if it does, scanning
#       through it must work.
#
#   bash desktop/tests/mac-network-scanner.sh   (after native/mac-scanner/build.sh)
set -uo pipefail
cd "$(dirname "$0")/.."
out="${BENCH_TMP:-/tmp}/airscan"
rm -rf "$out"
mkdir -p "$out"
name="Paperwing CI Scanner"
uuid="6f1c2a52-8a51-4c43-9d2e-3f0c7c1e0b11"
port=8090
failed=0

node tests/fake-escl.mjs --port $port --adf 3 --duplex --slow 300 --log --name "$name" --uuid $uuid \
  > "$out/fake.log" 2>&1 &
fake=$!
reg=
trap 'kill $fake $reg 2>/dev/null' EXIT
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$port/eSCL/ScannerCapabilities" > /dev/null && break
  sleep 1
done

dns-sd -R "$name" _uscan._tcp local $port txtvers=1 vers=2.63 rs=eSCL "ty=$name" \
  "UUID=$uuid" pdl=image/jpeg,image/png cs=color,grayscale,binary is=platen,adf duplex=T \
  "representation=http://127.0.0.1:$port/icon.png" > "$out/dns-sd.log" 2>&1 &
reg=$!
sleep 3
echo "--- Bonjour sees:"
(dns-sd -B _uscan._tcp local & b=$!; sleep 3; kill $b) 2>&1
(dns-sd -L "$name" _uscan._tcp local & b=$!; sleep 3; kill $b) 2>&1

echo "--- (a) escl.cjs finds and scans it"
ESCL_LIVE_NAME="$name" node --test --test-name-pattern="live" tests/escl.test.mjs || failed=1

echo "--- (b) Image Capture (the Swift helper)"
helper=native/mac-scanner/out/paperwing-scan
"$helper" list -Wait 20 | tee "$out/list.json"
id=$(node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
  const list = JSON.parse(lines.pop() || "{}");
  const s = (list.scanners || []).find((x) => /Paperwing CI/.test(x.name));
  process.stdout.write(s ? s.id : "");
' "$out/list.json")

b64() { printf '%s' "$1" | base64; }
expect() { # file, pattern, what
  if grep -q "$2" "$1"; then echo "ok: $3"; else echo "::error::$3"; failed=1; fi
}

if [ -z "$id" ]; then
  echo "::warning::Image Capture didn't list the AirScan scanner announced through Bonjour"
  echo "--- Evidence: what the scanner was asked (nothing from Image Capture means it never connected)"
  cat "$out/fake.log"
  echo "--- Image Capture's device modules"
  ls -la "/System/Library/Image Capture/Devices" 2>&1 || true
  echo "--- Image Capture's log, last 3 minutes"
  log show --last 3m --style compact --predicate \
    'process CONTAINS[c] "ImageCapture" OR process CONTAINS[c] "icdd" OR process CONTAINS[c] "AirScan" OR subsystem CONTAINS[c] "imagecapture"' \
    2>&1 | tail -150 || true
else
  echo "Image Capture lists it as $id"
  "$helper" caps -Id "$id" | tee "$out/caps.json"
  expect "$out/caps.json" '"type":"caps"' "capabilities"
  "$helper" preview -Id "$id" -OutDir "$out/preview" -Options "$(b64 '{}')" | tee "$out/preview.json"
  expect "$out/preview.json" '"type":"page"' "a preview page"
  mkdir -p "$out/scan"
  "$helper" scan -Id "$id" -OutDir "$out/scan" \
    -Options "$(b64 '{"source":"flatbed","color":"gray","dpi":150,"area":{"x":0,"y":0,"width":4,"height":5}}')" \
    | tee "$out/scan.json"
  expect "$out/scan.json" '"type":"page"' "a flatbed page"
  expect "$out/scan.json" '"type":"done"' "the scan finishing"
  mkdir -p "$out/feeder"
  "$helper" scan -Id "$id" -OutDir "$out/feeder" \
    -Options "$(b64 '{"source":"feeder","duplex":true,"dpi":150}')" | tee "$out/feeder.json"
  expect "$out/feeder.json" '"side":"back"' "both sides from the feeder"
  mkdir -p "$out/cancel"
  (sleep 1; echo cancel; sleep 15) | "$helper" scan -Id "$id" -OutDir "$out/cancel" \
    -Options "$(b64 '{"source":"flatbed","dpi":300}')" | tee "$out/cancel.json"
  expect "$out/cancel.json" '"cancelled":true' "cancelling"
  echo "--- What the scanner was asked"
  cat "$out/fake.log"
fi
exit $failed
