import forge from 'node-forge';

export interface SignatureValidationResult {
  signatureIndex: number;
  isValid: boolean;
  signerName: string;
  signerOrg?: string;
  signerEmail?: string;
  issuer: string;
  issuerOrg?: string;
  signatureDate?: Date;
  validFrom: Date;
  validTo: Date;
  isExpired: boolean;
  isSelfSigned: boolean;
  isTrusted: boolean;
  algorithms: {
    digest: string;
    signature: string;
  };
  serialNumber: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  byteRange?: number[];
  coverageStatus: 'full' | 'partial' | 'unknown';
  errorMessage?: string;
  cryptoVerified?: boolean;
  cryptoVerificationStatus?: 'verified' | 'failed' | 'unsupported';
  unsupportedAlgorithmReason?: string;
  usesInsecureDigest?: boolean;
  /** The certificate has expired by now (isExpired: it wasn't valid when
   *  signed, by the timestamp, or now if there's none) */
  expiredNow?: boolean;
  /** The signature's own timestamp */
  timestamp?: {
    time: Date;
    authority: string;
    valid: boolean;
    problem?: string;
  };
  /** What changed after this signature (when it covers an earlier revision):
   *  only signing (later signatures, timestamps) or the document itself */
  laterChanges?: 'none' | 'signing' | 'other';
  laterChangeDetails?: string[];
}

/** A document timestamp (Add a timestamp) */
export interface DocTimestampResult {
  index: number;
  valid: boolean;
  time?: Date;
  authority: string;
  coverageStatus: 'full' | 'partial' | 'unknown';
  isTrusted: boolean;
  problem?: string;
  laterChanges?: 'none' | 'signing' | 'other';
  laterChangeDetails?: string[];
}

export interface ExtractedSignature {
  index: number;
  contents: Uint8Array;
  byteRange: number[];
  reason?: string;
  location?: string;
  contactInfo?: string;
  name?: string;
  signingTime?: string;
}

export interface ValidateSignatureState {
  pdfFile: File | null;
  pdfBytes: Uint8Array | null;
  results: SignatureValidationResult[];
  trustedCertFile: File | null;
  trustedCert: forge.pki.Certificate | null;
}
