/**
 * What Validate signatures tells the user about each signature and document
 * timestamp: a status (valid, a warning, invalid), a title, and a plain
 * explanation of what it means and what to do, like Acrobat's signature
 * panel. Kept apart from the page so each case can be tested.
 */
import type { DocTimestampResult, SignatureValidationResult } from '@/types';
import { trText } from '../i18n/i18n.js';

export interface Verdict {
  level: 'valid' | 'warning' | 'invalid';
  title: string;
  explanation: string;
  /** More facts worth knowing (timestamp, later signatures) */
  notes: string[];
}

const when = (d: Date) =>
  d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const day = (d: Date) =>
  d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

function changes(details: string[] | undefined): string {
  return details?.length ? details.join('; ') : trText('it was edited');
}

export function signatureVerdict(
  r: SignatureValidationResult,
  trusting: boolean
): Verdict {
  const notes: string[] = [];
  if (r.timestamp?.valid)
    notes.push(
      trText('Timestamped by {{authority}} on {{time}}.', {
        authority: r.timestamp.authority,
        time: when(r.timestamp.time),
      })
    );
  if (r.laterChanges === 'signing')
    notes.push(
      trText(
        'More signatures or timestamps were added after this one; nothing else changed.'
      )
    );

  if (r.cryptoVerificationStatus === 'unsupported')
    return {
      level: 'warning',
      title: trText('Couldn’t check this signature'),
      explanation: trText(
        'It uses a kind of signature Paperwing can’t check yet ({{reason}}). Open the document in another app that checks signatures.',
        { reason: r.unsupportedAlgorithmReason ?? trText('unknown') }
      ),
      notes,
    };
  if (r.cryptoVerified !== true) {
    const changed = /hash|modified/i.test(r.errorMessage ?? '');
    return {
      level: 'invalid',
      title: changed
        ? trText('Invalid: the document was changed after it was signed')
        : trText('Invalid signature'),
      explanation: changed
        ? trText(
            'What was signed no longer matches the signature: the file was changed after it was signed, or it’s damaged. Don’t rely on this document; ask the sender for the original.'
          )
        : trText(
            'This signature doesn’t check out ({{error}}). The file may have been tampered with or damaged. Don’t rely on this document.',
            { error: r.errorMessage ?? trText('unknown problem') }
          ),
      notes,
    };
  }
  if (r.coverageStatus === 'partial' && r.laterChanges === 'other')
    return {
      level: 'warning',
      title: trText('Changed after signing'),
      explanation: trText(
        'What was signed is intact, but the document was changed afterwards: {{changes}}. What you see now isn’t exactly what was signed.',
        { changes: changes(r.laterChangeDetails) }
      ),
      notes,
    };
  if (r.coverageStatus !== 'full' && r.coverageStatus !== 'partial')
    return {
      level: 'invalid',
      title: trText('Invalid signature'),
      explanation: trText(
        'Paperwing couldn’t tell which part of the document this signature covers.'
      ),
      notes,
    };
  if (r.usesInsecureDigest)
    return {
      level: 'invalid',
      title: trText('Insecure Digest (MD5 / SHA-1)'),
      explanation: trText(
        'It was made with an old method (MD5 or SHA-1) that can be forged. Ask the signer to sign again with a current app.'
      ),
      notes,
    };
  if (r.timestamp && !r.timestamp.valid)
    notes.push(
      trText('Its timestamp can’t be relied on: {{problem}}', {
        problem: r.timestamp.problem ?? trText('unknown problem'),
      })
    );
  if (r.isExpired)
    return {
      level: 'warning',
      title: trText('Certificate Expired'),
      explanation: r.timestamp?.valid
        ? trText(
            'Nothing has changed since it was signed, but the signer’s certificate wasn’t valid when it was timestamped ({{time}}): it’s valid from {{from}} until {{to}}.',
            {
              time: when(r.timestamp.time),
              from: day(r.validFrom),
              to: day(r.validTo),
            }
          )
        : r.expiredNow
          ? trText(
              'Nothing has changed since it was signed, but the signer’s certificate expired on {{to}}, and there’s no timestamp to prove the signature was made before then.',
              { to: day(r.validTo) }
            )
          : trText(
              'Nothing has changed since it was signed, but the signer’s certificate isn’t valid until {{from}}.',
              { from: day(r.validFrom) }
            ),
      notes,
    };
  if (r.expiredNow && r.timestamp?.valid)
    notes.push(
      trText(
        'The certificate has expired since, but the timestamp proves it was signed while the certificate was valid.'
      )
    );
  if (!r.isTrusted)
    return {
      level: 'warning',
      title: r.isSelfSigned
        ? trText('Self-Signed: Signer Identity Not Verified')
        : trText('Signature Intact: Signer Identity Not Verified'),
      explanation: r.isSelfSigned
        ? trText(
            'Nothing has changed since it was signed. But the signer made this certificate themselves (it’s self-signed), so anyone could make one with the same name. Trust it only if you know the certificate is theirs, for example by comparing its fingerprint with them.'
          )
        : trusting
          ? trText(
              'Nothing has changed since it was signed, but the certificate was issued by {{issuer}}, which doesn’t lead to a certificate you trust.',
              { issuer: r.issuer }
            )
          : trText(
              'Nothing has changed since it was signed. The certificate was issued by {{issuer}}; to check that it’s trustworthy, trust the root certificates in your system’s certificate store, or choose your organization’s certificate, above.',
              { issuer: r.issuer }
            ),
      notes,
    };
  if (r.timestamp && !r.timestamp.valid)
    return {
      level: 'warning',
      title: trText('Signature valid, timestamp not'),
      explanation: trText(
        'Nothing has changed since it was signed, and the signer’s certificate leads to a certificate you trust, but its timestamp can’t be relied on.'
      ),
      notes,
    };
  return {
    level: 'valid',
    title: trText('Valid Signature'),
    explanation: trText(
      'Nothing has changed since it was signed, and the signer’s certificate leads to a certificate you trust.'
    ),
    notes,
  };
}

export function timestampVerdict(r: DocTimestampResult): Verdict {
  const notes: string[] = [];
  if (r.laterChanges === 'signing')
    notes.push(
      trText(
        'More signatures or timestamps were added after it; nothing else changed.'
      )
    );
  if (!r.time || r.problem || r.coverageStatus === 'unknown')
    return {
      level: 'invalid',
      title: trText('Invalid timestamp'),
      explanation: trText(
        'This timestamp doesn’t check out: {{problem}} Don’t rely on it.',
        { problem: r.problem ?? trText('it can’t be read.') }
      ),
      notes,
    };
  if (r.laterChanges === 'other')
    return {
      level: 'warning',
      title: trText('Changed after the timestamp'),
      explanation: trText(
        'The timestamp proves the document existed on {{time}}, but it was changed afterwards: {{changes}}.',
        { time: when(r.time), changes: changes(r.laterChangeDetails) }
      ),
      notes,
    };
  if (!r.isTrusted)
    return {
      level: 'warning',
      title: trText('Timestamp intact: authority not verified'),
      explanation: trText(
        '{{authority}} says the document existed in this form on {{time}}, and nothing has changed since. To confirm {{authority}} is a trusted timestamp authority, trust the root certificates in your system’s certificate store above.',
        { authority: r.authority, time: when(r.time) }
      ),
      notes,
    };
  return {
    level: 'valid',
    title: trText('Valid timestamp'),
    explanation: trText(
      '{{authority}}, a timestamp authority you trust, confirms the document existed in this form on {{time}}, and nothing has changed since.',
      { authority: r.authority, time: when(r.time) }
    ),
    notes,
  };
}
