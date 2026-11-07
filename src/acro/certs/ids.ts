/**
 * The digital IDs the Sign with a Digital ID dialog lists: certificates the
 * system has (Windows certificate store, smart cards and tokens, the
 * Keychain), through the certificate helper, and ID files added this
 * session. Each can sign: installed ones by asking the helper (the system
 * signs, asking for a PIN if the key needs one), files with their key in
 * memory.
 */
import type { CertError, CertsBridge, InstalledCert } from '../desktop';
import type { Curve, KeyAlg, Signer } from './cms';
import type { FileId } from './file-id';
import { certInfo, idStatus, type CertInfo, type IdStatus } from './x509';

export type IdSource = InstalledCert['source'] | 'file';

export interface DigitalId {
  /** Unique in the list */
  key: string;
  source: IdSource;
  certDer: Uint8Array;
  chainDer: Uint8Array[];
  keyAlg: KeyAlg | null;
  curve: Curve | null;
  info: CertInfo;
  status: IdStatus;
  /** Key provider (installed IDs) or file name */
  where: string;
  sign: Signer;
}

export const SOURCE_LABELS: Record<IdSource, string> = {
  'windows-store': 'Windows',
  'smart-card': 'Smart card',
  keychain: 'Keychain',
  token: 'USB token',
  file: 'File',
};

/** The helper refused to sign: the reason (see errorMessage) */
export class CertSignError extends Error {
  constructor(readonly code: CertError) {
    super(code);
    this.name = 'CertSignError';
  }
}

export const fromBase64 = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000)
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** What to tell the user, in plain words; null when they cancelled (the
 *  dialog just stays open) */
export function errorMessage(code: CertError, mac: boolean): string | null {
  switch (code) {
    case 'cancelled':
      return null;
    case 'wrong-pin':
      return 'Wrong PIN. Try again.';
    case 'pin-blocked':
      return 'Your card is locked. Contact whoever issued it.';
    case 'card-removed':
      return 'Insert your card and select Refresh.';
    case 'key-unusable':
      return `${mac ? 'macOS' : 'Windows'} couldn’t use this ID’s private key to sign. If it’s on a card or token, check it’s inserted, then select Refresh.`;
    case 'timeout':
      return 'Signing took too long. Try again.';
    case 'no-helper':
      return 'Paperwing’s certificate helper is missing. Reinstall Paperwing to sign with installed IDs.';
    default:
      return 'Signing didn’t work. Try again, or choose another ID.';
  }
}

/** A signer that asks the helper (the system holds the key) */
export function installedSigner(bridge: CertsBridge, id: string): Signer {
  return async ({ digest, hash }) => {
    const res = await bridge.sign(id, toBase64(digest), hash);
    if (!res.ok || !res.sig) throw new CertSignError(res.error ?? 'failed');
    return fromBase64(res.sig);
  };
}

export async function installedIds(
  bridge: CertsBridge
): Promise<{ ids: DigitalId[]; error?: CertError }> {
  const res = await bridge.list().catch(() => ({
    ok: false,
    error: 'failed' as CertError,
    certs: [] as InstalledCert[],
  }));
  const ids: DigitalId[] = [];
  for (const c of res.certs) {
    try {
      const certDer = fromBase64(c.certDer);
      const info = await certInfo(certDer);
      ids.push({
        key: `installed:${c.id}`,
        source: c.source,
        certDer,
        chainDer: c.chainDer.map(fromBase64),
        keyAlg: info.keyAlg,
        curve: info.curve,
        info,
        status: idStatus(info, c.hasPrivateKey),
        where: c.provider,
        sign: installedSigner(bridge, c.id),
      });
    } catch {
      // (a certificate that can't be read isn't listed)
    }
  }
  return { ids, error: res.ok ? undefined : res.error };
}

export async function fileIdEntry(
  id: FileId,
  name: string
): Promise<DigitalId> {
  const info = await certInfo(id.certDer);
  return {
    key: `file:${info.sha256}`,
    source: 'file',
    certDer: id.certDer,
    chainDer: id.chainDer,
    keyAlg: id.keyAlg,
    curve: id.curve,
    info,
    status: idStatus(info, true),
    where: name,
    sign: id.sign,
  };
}

/** Usable IDs first (by name), then the ones that can't sign */
export function sortIds(ids: DigitalId[]): DigitalId[] {
  return [...ids].sort(
    (a, b) =>
      Number(b.status.usable) - Number(a.status.usable) ||
      a.info.name.localeCompare(b.info.name)
  );
}
