/**
 * Timestamps (RFC 3161) for signatures: a timestamp server signs the time
 * together with a digest of the signature value, which proves the signature
 * existed then (Acrobat shows "Signature is timestamped"). Requests go out
 * through `Fetcher`: in the desktop app, the main process (timestamp
 * servers don't accept requests from web pages).
 */
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { digest, sameBytes, type HashName } from './cms';

export interface FetchInit {
  method: 'GET' | 'POST';
  contentType?: string;
  body?: Uint8Array;
}

export interface FetchResult {
  status: number;
  contentType?: string;
  body: Uint8Array;
}

export type Fetcher = (url: string, init: FetchInit) => Promise<FetchResult>;

const TST_INFO = '1.2.840.113549.1.9.16.1.4';
const HASH_OID: Record<HashName, string> = {
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
};

export class TimestampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimestampError';
  }
}

export interface Timestamp {
  /** The TimeStampToken (CMS ContentInfo), exactly as the server sent it */
  token: Uint8Array;
  time: Date;
}

/** A TimeStampReq for this digest, asking for the server's certificate */
export function timestampRequest(
  imprint: Uint8Array,
  hash: HashName,
  nonce: Uint8Array
): Uint8Array {
  return new Uint8Array(
    new asn1js.Sequence({
      value: [
        new asn1js.Integer({ value: 1 }),
        new asn1js.Sequence({
          value: [
            new asn1js.Sequence({
              value: [
                new asn1js.ObjectIdentifier({ value: HASH_OID[hash] }),
                new asn1js.Null(),
              ],
            }),
            new asn1js.OctetString({ valueHex: imprint.slice().buffer }),
          ],
        }),
        new asn1js.Integer({ valueHex: nonce.slice().buffer }),
        new asn1js.Boolean({ value: true }),
      ],
    }).toBER()
  );
}

/** Checks a TimeStampResp and returns its token: granted, for this very
 *  digest and nonce */
export function readTimestampResponse(
  body: Uint8Array,
  imprint: Uint8Array,
  nonce: Uint8Array
): Timestamp {
  const parsed = asn1js.fromBER(body.slice());
  const resp = parsed.result as asn1js.Sequence;
  if (parsed.offset === -1 || !(resp instanceof asn1js.Sequence))
    throw new TimestampError('The timestamp server sent something else.');
  const [statusInfo, tokenBlock] = resp.valueBlock.value as asn1js.Sequence[];
  const status = (statusInfo?.valueBlock.value[0] as asn1js.Integer)
    ?.valueBlock.valueDec;
  if (status !== 0 && status !== 1)
    throw new TimestampError(
      `The timestamp server refused the request (status ${status ?? 'unknown'}).`
    );
  if (!tokenBlock)
    throw new TimestampError('The timestamp server sent no timestamp.');
  const token = new Uint8Array(tokenBlock.valueBeforeDecodeView);

  const info = pkijs.ContentInfo.fromBER(token.slice());
  const signed = new pkijs.SignedData({ schema: info.content });
  if (signed.encapContentInfo.eContentType !== TST_INFO)
    throw new TimestampError('The timestamp server sent something else.');
  const content = signed.encapContentInfo.eContent;
  if (!content)
    throw new TimestampError('The timestamp server sent an empty timestamp.');
  const tst = pkijs.TSTInfo.fromBER(
    new Uint8Array(content.getValue()).slice()
  );
  if (
    !sameBytes(
      new Uint8Array(tst.messageImprint.hashedMessage.valueBlock.valueHexView),
      imprint
    )
  )
    throw new TimestampError(
      'The timestamp server stamped something else. Try another server.'
    );
  if (
    tst.nonce &&
    !sameBytes(
      stripZeros(new Uint8Array(tst.nonce.valueBlock.valueHexView)),
      stripZeros(nonce)
    )
  )
    throw new TimestampError(
      'The timestamp server’s reply doesn’t match the request. Try again.'
    );
  return { token, time: tst.genTime };
}

const stripZeros = (b: Uint8Array) => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
};

/** A timestamp over these bytes (a signature value) from this server */
export async function requestTimestamp(
  url: string,
  data: Uint8Array,
  fetcher: Fetcher,
  hash: HashName = 'sha256'
): Promise<Timestamp> {
  const imprint = await digest(hash, data);
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  nonce[0] &= 0x7f;
  let res: FetchResult;
  try {
    res = await fetcher(url, {
      method: 'POST',
      contentType: 'application/timestamp-query',
      body: timestampRequest(imprint, hash, nonce),
    });
  } catch {
    throw new TimestampError(
      `Couldn’t reach the timestamp server (${new URL(url).host}). Check your internet connection, or choose another server.`
    );
  }
  if (res.status < 200 || res.status >= 300)
    throw new TimestampError(
      `The timestamp server (${new URL(url).host}) answered with an error (${res.status}). Try another server.`
    );
  return readTimestampResponse(res.body, imprint, nonce);
}
