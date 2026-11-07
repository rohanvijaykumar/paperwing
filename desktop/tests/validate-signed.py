"""Independent check of PDFs Paperwing signed: pyHanko validates every
signature in each file (the signer's own certificate is trusted, as the test
IDs are self-signed). Fails unless each one is intact, cryptographically
valid, trusted, uses the expected profile, and the last one covers the whole
file. Used by CI (and locally) after the signing tests.

    python desktop/tests/validate-signed.py <dir-or-pdf>...
"""
import glob
import os
import sys

from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko.sign.validation.status import SignatureCoverageLevel
from pyhanko_certvalidator import ValidationContext


def files(args):
    for a in args:
        if os.path.isdir(a):
            yield from sorted(glob.glob(os.path.join(a, '*.pdf')))
        else:
            yield a


def main(args):
    failures = 0
    count = 0
    for path in files(args):
        with open(path, 'rb') as f:
            reader = PdfFileReader(f)
            sigs = reader.embedded_signatures
            if not sigs:
                print(f'FAIL {path}: no signatures')
                failures += 1
                continue
            for i, sig in enumerate(sigs):
                count += 1
                cert = sig.signer_cert
                context = ValidationContext(
                    trust_roots=[cert], allow_fetching=False
                )
                status = validate_pdf_signature(sig, context)
                sub_filter = sig.sig_object.get('/SubFilter')
                last = i == len(sigs) - 1
                coverage_ok = (
                    status.coverage == SignatureCoverageLevel.ENTIRE_FILE
                    if last
                    else status.coverage
                    in (
                        SignatureCoverageLevel.ENTIRE_REVISION,
                        SignatureCoverageLevel.ENTIRE_FILE,
                    )
                )
                ok = (
                    status.intact
                    and status.valid
                    and status.trusted
                    and coverage_ok
                    and sub_filter
                    in ('/ETSI.CAdES.detached', '/adbe.pkcs7.detached')
                )
                ts = ''
                if status.timestamp_validity is not None:
                    ts = f', timestamped {status.timestamp_validity.timestamp}'
                print(
                    f"{'ok  ' if ok else 'FAIL'} {os.path.basename(path)} "
                    f'#{i + 1} {sig.field_name}: {sub_filter}, '
                    f'{status.md_algorithm}/{status.pkcs7_signature_mechanism}, '
                    f'intact={status.intact} valid={status.valid} '
                    f'trusted={status.trusted} coverage={status.coverage.name}'
                    f'{ts} signer="{cert.subject.human_friendly}"'
                )
                if not ok:
                    failures += 1
    print(f'{count} signature(s) checked, {failures} failed')
    return 1 if failures or not count else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
