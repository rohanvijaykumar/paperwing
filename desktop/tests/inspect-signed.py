"""pyHanko's view of a signed PDF, as JSON, for the signing benches
(desktop/bench/signed-pdf.mjs): every signature and document timestamp,
whether it's intact and valid, what it covers, what changed after it,
DocMDP/FieldMDP, its timestamp. Each signer's own certificate is trusted
(test IDs are self-signed) unless certificates are given with --trust.

    python desktop/tests/inspect-signed.py <pdf> [--trust <cert>]...
"""
import json
import logging
import sys

from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.general import load_cert_from_pemder
from pyhanko.sign.validation import validate_pdf_signature, validate_pdf_timestamp
from pyhanko_certvalidator import ValidationContext

logging.disable(logging.CRITICAL)


def main(argv):
    path = argv[0]
    trust = [load_cert_from_pemder(argv[i + 1])
             for i, a in enumerate(argv) if a == '--trust']
    out = {'signatures': []}
    with open(path, 'rb') as f:
        reader = PdfFileReader(f)
        out['revisions'] = reader.xrefs.total_revisions
        root = reader.root
        if '/DSS' in root:
            dss = root['/DSS']
            out['dss'] = {k[1:]: len(dss[k])
                          for k in ('/Certs', '/OCSPs', '/CRLs') if k in dss}
        for sig in reader.embedded_signatures:
            so = sig.sig_object
            entry = {
                'field': sig.field_name,
                'type': str(so.get('/Type', '/Sig')),
                'subFilter': str(so.get('/SubFilter')),
                'signer': sig.signer_cert.subject.human_friendly,
            }
            roots = trust or [sig.signer_cert]
            context = ValidationContext(trust_roots=roots, allow_fetching=False)
            try:
                if entry['type'] == '/DocTimeStamp':
                    st = validate_pdf_timestamp(sig, validation_context=context)
                    entry['time'] = st.timestamp.isoformat()
                else:
                    st = validate_pdf_signature(sig, context)
                    entry['modification'] = (
                        st.modification_level.name
                        if st.modification_level else None)
                    entry['docmdpOk'] = st.docmdp_ok
                    entry['mechanism'] = st.pkcs7_signature_mechanism
                    entry['digest'] = st.md_algorithm
                    if st.timestamp_validity is not None:
                        tv = st.timestamp_validity
                        entry['timestamp'] = {
                            'time': tv.timestamp.isoformat(),
                            'intact': tv.intact,
                            'valid': tv.valid,
                            'authority': tv.signing_cert.subject.human_friendly,
                        }
                entry.update({
                    'intact': st.intact,
                    'valid': st.valid,
                    'trusted': st.trusted,
                    'coverage': st.coverage.name if st.coverage else None,
                })
            except Exception as e:  # noqa: BLE001 (reported, not hidden)
                entry['error'] = f'{type(e).__name__}: {e}'
            out['signatures'].append(entry)
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main(sys.argv[1:])
