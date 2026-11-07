#!/bin/bash
# Test Digital IDs for the macOS certificate helper (CI): a keychain of its
# own, added to the user's search list, holding self-signed identities like
# the Windows ones (native/win-certs/test-certs.ps1). Writes what it made to
# a JSON file; `remove` deletes the keychain.
#
#   desktop/native/mac-certs/test-keychain.sh create <certs.json>
#   desktop/native/mac-certs/test-keychain.sh remove <certs.json>
set -euo pipefail
cmd="${1:?create or remove}"
out="${2:?output json}"
work="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pw-test-ids"
keychain="$work/paperwing-test.keychain-db"
kcpass="paperwing-ci"
# OpenSSL 3 (Homebrew's) for the expired certificate's dates
openssl="$(brew --prefix openssl@3 2>/dev/null)/bin/openssl"
[[ -x "$openssl" ]] || openssl=openssl

if [[ "$cmd" == "remove" ]]; then
  if [[ -f "$keychain" ]]; then
    security delete-keychain "$keychain" || true
  fi
  rm -rf "$work" "$out"
  exit 0
fi

rm -rf "$work"
mkdir -p "$work"
security create-keychain -p "$kcpass" "$keychain"
security set-keychain-settings "$keychain"
security unlock-keychain -p "$kcpass" "$keychain"
# Searched along with the login keychain (as an installed ID would be)
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')

entries=()
make() {
  local label="$1" keyalg="$2" curve="$3" expect="$4" eku="$5" dates="$6"
  local name="Paperwing Test $(echo "$label" | tr '[:lower:]' '[:upper:]')"
  local dir="$work/$label"
  mkdir -p "$dir"
  if [[ "$keyalg" == "rsa" ]]; then
    "$openssl" genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$dir/key.pem" 2>/dev/null
  else
    "$openssl" genpkey -algorithm EC -pkeyopt "ec_paramgen_curve:$curve" -out "$dir/key.pem" 2>/dev/null
  fi
  cat > "$dir/ext.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $name
O = Paperwing CI
[ext]
keyUsage = critical, digitalSignature, nonRepudiation
extendedKeyUsage = $eku
EOF
  # shellcheck disable=SC2086
  "$openssl" req -new -x509 -key "$dir/key.pem" -config "$dir/ext.cnf" -extensions ext \
    -sha256 $dates -out "$dir/cert.pem"
  "$openssl" pkcs12 -export -inkey "$dir/key.pem" -in "$dir/cert.pem" -name "$name" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
    -passout pass:test -out "$dir/id.p12"
  # -A: any app may use the key without asking (a CI keychain only)
  security import "$dir/id.p12" -k "$keychain" -P test -A >/dev/null
  local sha1
  sha1="$("$openssl" x509 -in "$dir/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' | tr '[:lower:]' '[:upper:]')"
  local c="null"
  [[ -n "$curve" ]] && c="\"$curve\""
  entries+=("{\"label\":\"$label\",\"id\":\"kc:$sha1\",\"keyAlg\":\"$keyalg\",\"curve\":$c,\"expect\":\"$expect\",\"name\":\"$name\"}")
  echo "made $label: kc:$sha1"
}

make rsa rsa "" usable emailProtection "-days 365"
make p256 ec P-256 usable emailProtection "-days 365"
make p384 ec P-384 usable emailProtection "-days 365"
make login rsa "" hidden clientAuth "-days 365"
make expired rsa "" expired emailProtection "-not_before 20200101000000Z -not_after 20210101000000Z"

# Signing without a Keychain prompt (apps, Apple's tools, unsigned tools)
security set-key-partition-list -S apple-tool:,apple:,unsigned: -s -k "$kcpass" "$keychain" >/dev/null

(IFS=,; echo "[${entries[*]}]") > "$out"
cat "$out"
