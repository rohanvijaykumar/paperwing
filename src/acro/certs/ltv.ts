/**
 * Long-term validation: the certificate checks a validator would make
 * (OCSP replies, else certificate revocation lists, and the issuers'
 * certificates) gathered when signing and stored in the PDF's DSS, so the
 * signature can still be checked after the certificates expire or the
 * servers are gone (Acrobat's "LTV enabled"). Best effort: a server that
 * can't be reached leaves that check out; it never stops the signing.
 *
 * zgapdfsigner writes the DSS (see reskin/signer-patches.ts); this is the
 * "chain" it asks for the contents.
 */
import * as pkijs from 'pkijs';
import { certParts, sameBytes } from './cms';
import type { Fetcher } from './tsa';

const AIA = '1.3.6.1.5.5.7.1.1';
const OCSP = '1.3.6.1.5.5.7.48.1';
const CA_ISSUERS = '1.3.6.1.5.5.7.48.2';
const CRL_DP = '2.5.29.31';
const BASIC_OCSP = '1.3.6.1.5.5.7.48.1.1';

export interface DssInfo {
  certs: { pwDer: string }[];
  ocsps: Uint8Array[];
  crls: Uint8Array[];
}

/** The chain zgapdfsigner is given in place of its own (pwExternal.chain) */
export interface ChainForDss {
  isSelfSignedCert(): boolean;
  prepareDSSInf(crlOnly?: boolean): Promise<DssInfo | null>;
}

export class RevokedError extends Error {
  constructor() {
    super(
      'Your certificate has been revoked by whoever issued it, so signatures made with it aren’t valid.'
    );
    this.name = 'RevokedError';
  }
}

const binary = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000)
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};

function urlsOf(cert: pkijs.Certificate, method: string): string[] {
  const aia = cert.extensions?.find((e) => e.extnID === AIA)?.parsedValue as
    | pkijs.InfoAccess
    | undefined;
  return (aia?.accessDescriptions ?? [])
    .filter((d) => d.accessMethod === method && d.accessLocation.type === 6)
    .map((d) => String(d.accessLocation.value))
    .filter((u) => /^https?:\/\//i.test(u));
}

function crlUrls(cert: pkijs.Certificate): string[] {
  const dp = cert.extensions?.find((e) => e.extnID === CRL_DP)?.parsedValue as
    | pkijs.CRLDistributionPoints
    | undefined;
  const out: string[] = [];
  for (const p of dp?.distributionPoints ?? []) {
    const names = Array.isArray(p.distributionPoint)
      ? (p.distributionPoint as pkijs.GeneralName[])
      : [];
    for (const n of names)
      if (n.type === 6 && /^https?:\/\//i.test(String(n.value)))
        out.push(String(n.value));
  }
  return out;
}

const parse = (der: Uint8Array) => pkijs.Certificate.fromBER(der.slice());

/**
 * The chain to gather checks for: the signer's certificate and its issuers
 * (fetching a missing issuer from the address its certificate gives, as
 * validators do). Self-signed certificates need none.
 */
export function chainForDss(
  certDer: Uint8Array,
  chainDer: Uint8Array[],
  fetcher: Fetcher
): ChainForDss {
  const self = (() => {
    try {
      const p = certParts(certDer);
      return sameBytes(p.issuer, p.subject);
    } catch {
      return true;
    }
  })();
  return {
    isSelfSignedCert: () => self,
    prepareDSSInf: () => gatherChecks(certDer, chainDer, fetcher),
  };
}

async function fetchBytes(
  fetcher: Fetcher,
  url: string,
  body?: Uint8Array,
  contentType?: string
): Promise<Uint8Array | null> {
  try {
    const res = await fetcher(url, {
      method: body ? 'POST' : 'GET',
      contentType,
      body,
    });
    return res.status >= 200 && res.status < 300 && res.body.length
      ? res.body
      : null;
  } catch {
    return null;
  }
}

/** The issuer of `cert` among `pool`, else from its CA issuers address */
async function issuerOf(
  der: Uint8Array,
  pool: Uint8Array[],
  fetcher: Fetcher
): Promise<Uint8Array | null> {
  const { issuer, subject } = certParts(der);
  if (sameBytes(issuer, subject)) return null;
  const found = pool.find((c) => sameBytes(certParts(c).subject, issuer));
  if (found) return found;
  for (const url of urlsOf(parse(der), CA_ISSUERS)) {
    const got = await fetchBytes(fetcher, url);
    if (!got) continue;
    try {
      // A certificate, or a PKCS#7 bundle of them (.p7c)
      const certs = [got];
      if (!looksLikeCert(got)) {
        const ci = pkijs.ContentInfo.fromBER(got.slice());
        const sd = new pkijs.SignedData({ schema: ci.content });
        certs.splice(
          0,
          1,
          ...(sd.certificates ?? [])
            .filter(
              (c): c is pkijs.Certificate => c instanceof pkijs.Certificate
            )
            .map((c) => new Uint8Array(c.toSchema().toBER()))
        );
      }
      const match = certs.find((c) => sameBytes(certParts(c).subject, issuer));
      if (match) return match;
    } catch {
      // (not a certificate)
    }
  }
  return null;
}

function looksLikeCert(der: Uint8Array): boolean {
  try {
    certParts(der);
    return true;
  } catch {
    return false;
  }
}

async function ocspCheck(
  der: Uint8Array,
  issuerDer: Uint8Array,
  fetcher: Fetcher
): Promise<{ response: Uint8Array; certs: Uint8Array[] } | null> {
  const cert = parse(der);
  const issuer = parse(issuerDer);
  for (const url of urlsOf(cert, OCSP)) {
    try {
      const req = new pkijs.OCSPRequest();
      await req.createForCertificate(cert, {
        hashAlgorithm: 'SHA-1',
        issuerCertificate: issuer,
      });
      const body = await fetchBytes(
        fetcher,
        url,
        new Uint8Array(req.toSchema(true).toBER()),
        'application/ocsp-request'
      );
      if (!body) continue;
      const resp = pkijs.OCSPResponse.fromBER(body.slice());
      if (resp.responseStatus.valueBlock.valueDec !== 0 || !resp.responseBytes)
        continue;
      if (resp.responseBytes.responseType !== BASIC_OCSP) continue;
      const basic = pkijs.BasicOCSPResponse.fromBER(
        resp.responseBytes.response.valueBlock.valueHexView.slice()
      );
      if (!(await basic.verify({ trustedCerts: [issuer] }).catch(() => false)))
        continue;
      const status = await basic.getCertificateStatus(cert, issuer);
      if (!status.isForCertificate) continue;
      if (status.status === 1) throw new RevokedError();
      if (status.status !== 0) continue;
      return {
        response: body,
        certs: (basic.certs ?? []).map(
          (c) => new Uint8Array(c.toSchema().toBER())
        ),
      };
    } catch (e) {
      if (e instanceof RevokedError) throw e;
    }
  }
  return null;
}

async function crlCheck(
  der: Uint8Array,
  issuerDer: Uint8Array,
  fetcher: Fetcher
): Promise<Uint8Array | null> {
  const cert = parse(der);
  const issuer = parse(issuerDer);
  for (const url of crlUrls(cert)) {
    const body = await fetchBytes(fetcher, url);
    if (!body) continue;
    try {
      const crl = pkijs.CertificateRevocationList.fromBER(body.slice());
      if (!(await crl.verify({ issuerCertificate: issuer }).catch(() => false)))
        continue;
      if (crl.isCertificateRevoked(cert)) throw new RevokedError();
      return body;
    } catch (e) {
      if (e instanceof RevokedError) throw e;
    }
  }
  return null;
}

async function gatherChecks(
  certDer: Uint8Array,
  chainDer: Uint8Array[],
  fetcher: Fetcher
): Promise<DssInfo | null> {
  const certs: Uint8Array[] = [];
  const ocsps: Uint8Array[] = [];
  const crls: Uint8Array[] = [];
  const add = (c: Uint8Array) => {
    if (!certs.some((d) => sameBytes(c, d))) certs.push(c);
  };
  let current: Uint8Array | null = certDer;
  for (let depth = 0; current && depth < 8; depth++) {
    add(current);
    const issuer = await issuerOf(current, chainDer, fetcher);
    if (!issuer) break;
    const ocsp = await ocspCheck(current, issuer, fetcher);
    if (ocsp) {
      ocsps.push(ocsp.response);
      ocsp.certs.forEach(add);
    } else {
      const crl = await crlCheck(current, issuer, fetcher);
      if (crl) crls.push(crl);
    }
    current = issuer;
  }
  if (!ocsps.length && !crls.length) return null;
  return {
    certs: certs.map((c) => ({ pwDer: binary(c) })),
    ocsps,
    crls,
  };
}
