/**
 * Build-time patches to zgapdfsigner (timestamps and digital signatures),
 * applied by vite-plugin-reskin.ts the way the viewer's are: each one checks
 * that the code it replaces is there exactly as expected (and how many
 * times), and is skipped with a warning otherwise. The unit tests load
 * zgapdfsigner with these same patches (src/tests/helpers/zga-patched.ts),
 * so a dependency update that moves the code fails them.
 */
export interface CodePatch {
  name: string;
  edits: [from: string, to: string, count: number][];
}

/** lib/zgafetch.js */
export const FETCH_PATCHES: CodePatch[] = [
  {
    // zgapdfsigner decides whether it runs in a browser with
    // `this === globalThis.self` inside a plain function, which is never
    // true once bundled into a module (`this` is undefined). Thinking it's
    // elsewhere, it doesn't use fetch and refuses timestamp servers whose
    // address isn't http(s), as through the desktop app's relay. In a page,
    // `self` with a fetch is the browser.
    name: 'signer browser check',
    edits: [
      [
        'z.isBrowser = function(){return this === globalThis.self;}();',
        'z.isBrowser = typeof globalThis.self !== "undefined" && typeof globalThis.self.fetch === "function";',
        1,
      ],
    ],
  },
];

/**
 * lib/zgapdfsigner.js: signing with a key held elsewhere (the Windows
 * certificate store, the Keychain, a smart card). zgapdfsigner only signs
 * with a key it has read from a .pfx; with `pwExternal` in its options it
 * keeps doing everything else (the signature field and its appearance, the
 * byte range, adding to an already signed PDF, the DSS for long-term
 * validation) but asks `pwExternal.cms` for the signature: Paperwing's CMS
 * builder (src/acro/certs/cms.ts), which has the key's owner sign.
 * Without `pwExternal` nothing changes (BentoPDF's tools in the browser).
 *
 *   pwExternal: {
 *     chain,      // isSelfSignedCert(), prepareDSSInf(crlOnly) for the DSS
 *     sigLen,     // hex digits reserved for the signature
 *     cms,        // async (bytes covered, as a binary string) => DER
 *     subFilter,  // "ETSI.CAdES.detached" or "adbe.pkcs7.detached"
 *     appName,    // the signing app, in the signature's build properties
 *     lock,       // lock the document after signing (Acrobat's option)
 *   }
 */
export const SIGNER_PATCHES: CodePatch[] = [
  {
    name: 'external signer',
    edits: [
      // No certificate file: the chain comes from the caller
      [
        '}else if(_this.tsaFetcher){\n\t\t\tz.log("No certificate is specified, so only add a document timestamp.")',
        '}else if(_this.opt.pwExternal){\n\t\t\t_this.cchain = _this.opt.pwExternal.chain;\n\t\t}else if(_this.tsaFetcher){\n\t\t\tz.log("No certificate is specified, so only add a document timestamp.")',
        1,
      ],
      // Room for the signature, sized by the caller: a second try with a
      // larger placeholder would mean a second PIN prompt
      [
        '_this.siglen = /** @type {number} */(_this.tsaFetcher ? _this.tsaFetcher.len : 3322);',
        '_this.siglen = /** @type {number} */(_this.opt.pwExternal ? _this.opt.pwExternal.sigLen : _this.tsaFetcher ? _this.tsaFetcher.len : 3322);',
        1,
      ],
      [
        '"SubFilter": "adbe.pkcs7.detached",',
        '"SubFilter": (_this.opt.pwExternal && _this.opt.pwExternal.subFilter) || "adbe.pkcs7.detached",',
        1,
      ],
      [
        '"Name": "ZgaPdfSinger",',
        '"Name": (_this.opt.pwExternal && _this.opt.pwExternal.appName) || "ZgaPdfSinger",',
        1,
      ],
      // Lock document after signing: a FieldMDP reference locking every
      // field, and the field's lock with no further changes allowed (P 1)
      [
        '/** @type {PDFLib.PDFRef} */\n\t\tvar signatureDictRef = pdfcont.register(pdfcont.obj(signObj));',
        'if(_this.opt.pwExternal && _this.opt.pwExternal.lock && !docMdp){\n\t\t\tsignObj["Reference"] = [pdfcont.obj({\n\t\t\t\t"Type": "SigRef",\n\t\t\t\t"TransformMethod": "FieldMDP",\n\t\t\t\t"TransformParams": pdfcont.obj({\n\t\t\t\t\t"Type": "TransformParams",\n\t\t\t\t\t"Action": "All",\n\t\t\t\t\t"P": 1,\n\t\t\t\t\t"V": "1.2",\n\t\t\t\t}),\n\t\t\t\t"Data": pdfcont.trailerInfo.Root,\n\t\t\t})];\n\t\t}\n\t\t/** @type {PDFLib.PDFRef} */\n\t\tvar signatureDictRef = pdfcont.register(pdfcont.obj(signObj));',
        1,
      ],
      [
        '/** @type {PDFLib.PDFRef} */\n\t\tvar widgetDictRef = pdfcont.register(pdfcont.obj(widgetObj));',
        'if(_this.opt.pwExternal && _this.opt.pwExternal.lock && !docMdp){\n\t\t\twidgetObj["Lock"] = pdfcont.obj({\n\t\t\t\t"Type": "SigFieldLock",\n\t\t\t\t"Action": "All",\n\t\t\t\t"P": 1,\n\t\t\t});\n\t\t}\n\t\t/** @type {PDFLib.PDFRef} */\n\t\tvar widgetDictRef = pdfcont.register(pdfcont.obj(widgetObj));',
        1,
      ],
      // The field's rectangle with its corners in order (on a rotated page
      // they came out swapped, and PDFium then doesn't draw the appearance)
      [
        '"Rect": signcrt.getSignRect(),',
        '"Rect": _this.opt.pwExternal ? (function(r){return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];})(signcrt.getSignRect()) : signcrt.getSignRect(),',
        1,
      ],
      // The signature itself, from the caller's CMS builder
      [
        'var asn1sig = null;\n\t\tif(_this.cchain){',
        'var asn1sig = null;\n\t\tif(_this.opt.pwExternal){\n\t\t\tasn1sig = {pwDer: z.u8arrToRaw(await _this.opt.pwExternal.cms(pdfstr))};\n\t\t}else if(_this.cchain){',
        1,
      ],
      // …placed as it is (not re-encoded)
      [
        'var sigbuf = forge.asn1.toDer(asn1sig);',
        'var sigbuf = asn1sig.pwDer ? forge.util.createBuffer(asn1sig.pwDer) : forge.asn1.toDer(asn1sig);',
        1,
      ],
      // The DSS's certificates, as they are
      [
        'var a_asn1Cert = forge.pki.certificateToAsn1(a_cert);',
        'var a_asn1Cert = a_cert.pwDer ? forge.asn1.fromDer(a_cert.pwDer) : forge.pki.certificateToAsn1(a_cert);',
        1,
      ],
    ],
  },
];

/** Which patches a dependency file gets (by its path, / separators) */
export function signerPatchesFor(file: string): CodePatch[] | null {
  if (file.includes('/zgapdfsigner/lib/zgafetch.js')) return FETCH_PATCHES;
  if (file.includes('/zgapdfsigner/lib/zgapdfsigner.js')) return SIGNER_PATCHES;
  return null;
}

/**
 * Applies the patches that fit. Returns the patched code and the names of
 * patches that didn't fit (the code they replace isn't there as expected).
 */
export function applyPatches(
  code: string,
  patches: CodePatch[],
  skip: string[] = []
): { code: string; applied: string[]; missed: string[] } {
  let out = code;
  const applied: string[] = [];
  const missed: string[] = [];
  for (const patch of patches) {
    if (skip.includes(patch.name)) continue;
    const fits = patch.edits.every(
      ([from, , count]) => out.split(from).length - 1 === count
    );
    if (!fits) {
      if (patch.edits.some(([from]) => out.includes(from)))
        missed.push(patch.name);
      continue;
    }
    out = patch.edits.reduce((c, [from, to]) => c.split(from).join(to), out);
    applied.push(patch.name);
  }
  return { code: out, applied, missed };
}
