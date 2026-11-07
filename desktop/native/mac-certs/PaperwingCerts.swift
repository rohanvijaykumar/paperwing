// paperwing-certs: signs with Digital IDs in the macOS Keychain, smart cards
// included (CryptoTokenKit). Paperwing's main process runs one command per
// process and reads one JSON line from stdout (the same contract as the
// Windows helper, native/win-certs):
//
//   list   -> {"type":"certs","certs":[...]}  never uses a private key, so
//             listing never asks for a PIN or Keychain password
//   sign -Id <id> -Hash <base64 digest> -Alg sha256|sha384
//          -> {"type":"signature","sig":"<base64>"}  RSA PKCS#1 v1.5, ECDSA
//             DER (X9.62). The key never leaves the Keychain or the card:
//             macOS signs the digest and asks for the PIN itself.
//   roots  -> {"type":"roots","certs":[...]}  certificates macOS trusts as
//             roots (Validate signatures can trust them)
//
// Errors: {"type":"error","code":...} (cancelled, wrong-pin, pin-blocked,
// card-removed, key-unusable, failed) and exit code 2.
import CryptoKit
import Foundation
import Security

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func fail(_ code: String, _ detail: String = "") -> Never {
    emit(["type": "error", "code": code, "detail": detail])
    exit(2)
}

func sha1Hex(_ data: Data) -> String {
    Insecure.SHA1.hash(data: data).map { String(format: "%02X", $0) }.joined()
}

struct Found {
    let identity: SecIdentity
    let certificate: SecCertificate
    let der: Data
    let onToken: Bool
}

/// The Keychain's identities (a certificate with its private key), from the
/// user's keychains and from smart cards (CryptoTokenKit), each once
func identities() -> [Found] {
    var out: [Found] = []
    var seen = Set<String>()
    func search(token: Bool) {
        var query: [String: Any] = [
            kSecClass as String: kSecClassIdentity,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnRef as String: true,
        ]
        if token { query[kSecAttrAccessGroup as String] = kSecAttrAccessGroupToken }
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [Any] else { return }
        for item in items {
            let identity = item as! SecIdentity
            var cert: SecCertificate?
            guard SecIdentityCopyCertificate(identity, &cert) == errSecSuccess, let cert else { continue }
            let der = SecCertificateCopyData(cert) as Data
            let key = sha1Hex(der)
            if seen.contains(key) { continue }
            seen.insert(key)
            out.append(Found(identity: identity, certificate: cert, der: der, onToken: token))
        }
    }
    // Smart cards first: a card's certificate may also be in a keychain
    search(token: true)
    search(token: false)
    return out
}

func keyInfo(_ cert: SecCertificate) -> (alg: String?, bits: Int, curve: String?) {
    guard let pub = SecCertificateCopyKey(cert),
          let attrs = SecKeyCopyAttributes(pub) as? [String: Any] else { return (nil, 0, nil) }
    let type = attrs[kSecAttrKeyType as String] as? String
    let bits = (attrs[kSecAttrKeySizeInBits as String] as? NSNumber)?.intValue ?? 0
    if type == (kSecAttrKeyTypeRSA as String) { return ("rsa", bits, nil) }
    if type == (kSecAttrKeyTypeECSECPrimeRandom as String) {
        let curve: String? = bits == 256 ? "P-256" : bits == 384 ? "P-384" : bits == 521 ? "P-521" : nil
        return ("ec", bits, curve)
    }
    return (nil, bits, nil)
}

/// The issuers up to the root, as macOS finds them (no network)
func chain(_ cert: SecCertificate) -> [String] {
    var trust: SecTrust?
    guard SecTrustCreateWithCertificates(cert, SecPolicyCreateBasicX509(), &trust) == errSecSuccess,
          let trust else { return [] }
    SecTrustSetNetworkFetchAllowed(trust, false)
    _ = SecTrustEvaluateWithError(trust, nil)
    guard let certs = SecTrustCopyCertificateChain(trust) as? [SecCertificate] else { return [] }
    return certs.dropFirst().map { (SecCertificateCopyData($0) as Data).base64EncodedString() }
}

func list() {
    let certs: [[String: Any]] = identities().map { f in
        let k = keyInfo(f.certificate)
        return [
            "id": "kc:" + sha1Hex(f.der),
            "source": f.onToken ? "smart-card" : "keychain",
            "provider": f.onToken ? "CryptoTokenKit" : "Keychain",
            "certDer": f.der.base64EncodedString(),
            "chainDer": chain(f.certificate),
            "hasPrivateKey": true,
            "keyAlg": k.alg ?? NSNull(),
            "keyBits": k.bits,
            "curve": k.curve ?? NSNull(),
        ]
    }
    emit(["type": "certs", "certs": certs])
}

/// macOS's errors from signing, as the cases Paperwing tells apart
func errorCode(_ error: Error) -> String {
    let e = error as NSError
    switch (e.domain, e.code) {
    case (NSOSStatusErrorDomain, Int(errSecUserCanceled)): return "cancelled"
    case (NSOSStatusErrorDomain, Int(errSecAuthFailed)): return "wrong-pin"
    case (NSOSStatusErrorDomain, Int(errSecItemNotFound)),
         (NSOSStatusErrorDomain, Int(errSecInteractionNotAllowed)),
         (NSOSStatusErrorDomain, Int(errSecMissingEntitlement)),
         (NSOSStatusErrorDomain, Int(errSecNoAccessForItem)),
         (NSOSStatusErrorDomain, Int(errSecUnimplemented)),
         (NSOSStatusErrorDomain, Int(errSecParam)): return "key-unusable"
    // CryptoTokenKit (TKError.Code)
    case ("CryptoTokenKit", -4): return "cancelled"
    case ("CryptoTokenKit", -5): return "wrong-pin"
    case ("CryptoTokenKit", -7): return "card-removed"
    case ("CryptoTokenKit", -6), ("CryptoTokenKit", -1), ("CryptoTokenKit", -8): return "key-unusable"
    // LocalAuthentication: the user cancelled the prompt
    case ("com.apple.LocalAuthentication", -2), ("com.apple.LocalAuthentication", -4): return "cancelled"
    default: break
    }
    if let underlying = e.userInfo[NSUnderlyingErrorKey] as? Error { return errorCode(underlying) }
    return "failed"
}

func sign(id: String, hash: Data, alg: String) {
    guard id.hasPrefix("kc:") else { fail("failed") }
    guard let found = identities().first(where: { "kc:" + sha1Hex($0.der) == id }) else {
        fail("key-unusable", "not found")
    }
    var keyRef: SecKey?
    let status = SecIdentityCopyPrivateKey(found.identity, &keyRef)
    guard status == errSecSuccess, let key = keyRef else {
        fail(errorCode(NSError(domain: NSOSStatusErrorDomain, code: Int(status))), "\(status)")
    }
    let info = keyInfo(found.certificate)
    let algorithm: SecKeyAlgorithm
    switch (info.alg, alg) {
    case ("rsa", "sha256"): algorithm = .rsaSignatureDigestPKCS1v15SHA256
    case ("rsa", "sha384"): algorithm = .rsaSignatureDigestPKCS1v15SHA384
    case ("ec", "sha256"): algorithm = .ecdsaSignatureDigestX962SHA256
    case ("ec", "sha384"): algorithm = .ecdsaSignatureDigestX962SHA384
    default: fail("key-unusable", "algorithm")
    }
    guard SecKeyIsAlgorithmSupported(key, .sign, algorithm) else { fail("key-unusable", "unsupported") }
    var error: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(key, algorithm, hash as CFData, &error) as Data? else {
        let err = error?.takeRetainedValue() as Error?
        fail(err.map(errorCode) ?? "failed", err.map { "\(($0 as NSError).domain) \(($0 as NSError).code)" } ?? "")
    }
    emit(["type": "signature", "sig": sig.base64EncodedString()])
}

func roots() {
    var out: [String] = []
    var seen = Set<String>()
    func add(_ certs: [SecCertificate]) {
        for c in certs {
            let der = SecCertificateCopyData(c) as Data
            if seen.insert(sha1Hex(der)).inserted { out.append(der.base64EncodedString()) }
        }
    }
    var anchors: CFArray?
    if SecTrustCopyAnchorCertificates(&anchors) == errSecSuccess, let a = anchors as? [SecCertificate] {
        add(a)
    }
    // Roots added by the user or the organisation (trust settings)
    for domain in [SecTrustSettingsDomain.user, .admin] {
        var certs: CFArray?
        if SecTrustSettingsCopyCertificates(domain, &certs) == errSecSuccess, let c = certs as? [SecCertificate] {
            add(c)
        }
    }
    emit(["type": "roots", "certs": out])
}

// Arguments: a command, then -Name value pairs
let args = Array(CommandLine.arguments.dropFirst())
var options: [String: String] = [:]
var i = 1
while i + 1 < args.count {
    options[args[i].trimmingCharacters(in: CharacterSet(charactersIn: "-")).lowercased()] = args[i + 1]
    i += 2
}

switch args.first {
case "list":
    list()
case "roots":
    roots()
case "sign":
    let alg = options["alg"] ?? "sha256"
    guard let b64 = options["hash"], let hash = Data(base64Encoded: b64),
          hash.count == (alg == "sha384" ? 48 : alg == "sha256" ? 32 : -1),
          let id = options["id"] else { fail("failed", "arguments") }
    sign(id: id, hash: hash, alg: alg)
default:
    FileHandle.standardError.write("usage: paperwing-certs list | sign -Id <id> -Hash <base64> -Alg sha256|sha384 | roots\n".data(using: .utf8)!)
    fail("failed", "usage")
}
