// The Digital ID dialogs (src/acro/certs/sign-dialog.ts) with a stand-in
// certificate bridge: Acrobat's filters in the list, Show all certificates,
// errors in plain words (wrong PIN, locked card, card removed), a cancelled
// PIN prompt coming back quietly, and Save As. The signing itself is stood
// in for (paperwing-pdf-sign.test.ts covers it).
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CertsBridge, InstalledCert } from '../acro/desktop';

const signing = vi.hoisted(() => ({
  calls: [] as unknown[],
  result: null as null | (() => Promise<Uint8Array>),
}));
vi.mock('../acro/certs/pdf-sign', () => ({
  signPdf: async (req: { sign: (r: unknown) => Promise<Uint8Array> }) => {
    signing.calls.push(req);
    // Ask for the signature, as the real one does
    await req.sign({
      data: new Uint8Array([0x31]),
      digest: new Uint8Array(32),
      hash: 'sha256',
    });
    return signing.result ? signing.result() : new Uint8Array([1, 2, 3]);
  },
}));
vi.mock('../acro/certs/appearance', async (orig) => ({
  ...(await orig<typeof import('../acro/certs/appearance')>()),
  drawAppearance: async () => {},
  appearancePng: async () => new Uint8Array([0x89]),
}));

import { digitallySign, type SignContext } from '../acro/certs/sign-dialog';
import { createSelfSignedId } from '../acro/certs/x509';
import { toBase64 } from '../acro/certs/ids';
import { errorMessage } from '../acro/certs/ids';

let good: string;
let expired: string;
let login: string;

beforeAll(async () => {
  good = toBase64(
    (await createSelfSignedId({ name: 'Jana Nováková', keyType: 'ec' })).certDer
  );
  expired = toBase64(
    (
      await createSelfSignedId({
        name: 'Old ID',
        keyType: 'rsa',
        from: new Date('2015-01-01'),
        years: 1,
      })
    ).certDer
  );
  // A certificate without a private key stands in for one Acrobat hides
  login = toBase64(
    (await createSelfSignedId({ name: 'No Key', keyType: 'rsa' })).certDer
  );
});

function cert(
  id: string,
  der: string,
  over: Partial<InstalledCert> = {}
): InstalledCert {
  return {
    id,
    source: 'smart-card',
    provider: 'Microsoft Smart Card Key Storage Provider',
    certDer: der,
    chainDer: [],
    hasPrivateKey: true,
    keyAlg: 'ec',
    keyBits: 256,
    curve: 'P-256',
    ...over,
  };
}

let signReplies: { ok: boolean; sig?: string; error?: string }[];
let signCalls: unknown[][];
/** While set, the bridge's sign waits for it (the user at the PIN prompt) */
let gate: Promise<void> | null = null;
function bridge(): CertsBridge {
  return {
    list: async () => ({
      ok: true,
      certs: [
        cert('cu:GOOD', good),
        cert('cu:OLD', expired, { source: 'windows-store', keyAlg: 'rsa' }),
        cert('cu:NOKEY', login, { hasPrivateKey: false }),
      ],
    }),
    sign: async (...args: unknown[]) => {
      signCalls.push(args);
      if (gate) await gate;
      return (signReplies.shift() ?? { ok: true, sig: 'AAAA' }) as never;
    },
    roots: async () => ({ ok: true, certs: [] }),
    fetch: async () => ({ status: 200, body: new Uint8Array() }),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function until<T>(fn: () => T, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end)
      throw new Error(`timed out: ${document.body.innerHTML.slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s);
const rows = () =>
  [...document.querySelectorAll('#cid-dialog .cid-row')].map((r) => ({
    name: r.querySelector('.cid-name b')!.textContent,
    disabled: r.classList.contains('is-disabled'),
    meta: r.querySelector('.cid-meta')!.textContent,
    badge: r.querySelector('.cid-badge')!.textContent,
  }));

let saved: { data: Uint8Array; name: string }[];
let saveResult: boolean;
function context(): SignContext {
  return {
    bridge: bridge(),
    mac: false,
    docName: 'Smlouva.pdf',
    box: {
      page: 0,
      box: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 },
      pixels: { width: 600, height: 800 },
    },
    getPdf: async () => new Uint8Array([9]),
    save: async (data, name) => {
      saved.push({ data, name });
      return saveResult;
    },
    pickIdFile: async () => null,
    saveIdFile: async () => false,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  signReplies = [];
  signCalls = [];
  gate = null;
  signing.calls = [];
  signing.result = null;
  saved = [];
  saveResult = true;
  localStorage.clear();
});

/** Opens the dialogs; resolves (with the flow's outcome still pending)
 *  once the list shows */
async function toSignAs(): Promise<{ done: Promise<string> }> {
  const done = digitallySign(context());
  await until(() => $('#cid-dialog .cid-row'));
  return { done };
}

describe('Sign with a Digital ID', () => {
  it('lists IDs the way Acrobat filters them', async () => {
    const { done } = await toSignAs();
    const list = rows();
    expect(list.map((r) => r.name)).toEqual(['Jana Nováková', 'Old ID']);
    expect(list[0]).toMatchObject({ disabled: false, badge: 'Smart card' });
    expect(list[0].meta).toMatch(/^Issued by Jana Nováková · Valid until/);
    expect(list[1]).toMatchObject({ disabled: true, badge: 'Windows' });
    expect(list[1].meta).toMatch(/expired/);
    expect($<HTMLButtonElement>('#cid-continue')!.disabled).toBe(false);

    // Show all certificates: the one without a private key, and why
    $<HTMLInputElement>('#cid-show-all')!.click();
    const all = rows();
    expect(all.map((r) => r.name)).toContain('No Key');
    expect(all.find((r) => r.name === 'No Key')!.meta).toMatch(
      /private key isn’t on this computer/
    );
    $<HTMLButtonElement>('#cid-dialog .quiet-btn')!.click();
    expect(await done).toBe('cancelled');
  });

  it('View details shows the certificate', async () => {
    const { done } = await toSignAs();
    $<HTMLButtonElement>('#cid-details')!.click();
    const details = $('#cert-details-dialog')!.textContent!;
    expect(details).toMatch(/Jana Nováková/);
    expect(details).toMatch(/ECDSA P-256/);
    expect(details).toMatch(
      /Smart card \(Microsoft Smart Card Key Storage Provider\)/
    );
    expect(details).toMatch(/SHA-256 fingerprint/);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect($('#cert-details-dialog')).toBeNull();
    expect($('#cid-dialog')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await done).toBe('cancelled');
  });
});

describe('Sign as', () => {
  async function signAs(): Promise<{ done: Promise<string> }> {
    const opened = await toSignAs();
    $<HTMLButtonElement>('#cid-continue')!.click();
    await until(() => $('#sas-dialog'));
    return opened;
  }
  const status = () => $('#sas-dialog .cs-status')!.textContent;
  const sign = async () => {
    $<HTMLButtonElement>('#sas-sign')!.click();
    await flush();
  };

  it('signs through the bridge, says it waits for the PIN, then saves', async () => {
    const { done } = await signAs();
    expect($('#sas-dialog h2')!.textContent).toBe('Sign as “Jana Nováková”');
    const reason = $<HTMLInputElement>('#sas-reason')!;
    reason.value = 'Souhlasím';
    $<HTMLInputElement>('#sas-location')!.value = 'Brno';
    $<HTMLInputElement>('#sas-lock')!.checked = true;
    let release: () => void = () => {};
    gate = new Promise<void>((r) => (release = r));
    await sign();
    // At the PIN prompt: the dialog says so and can't be used meanwhile
    await until(() =>
      /Waiting for your PIN or confirmation/.test(status() ?? '')
    );
    expect($<HTMLButtonElement>('#sas-sign')!.disabled).toBe(true);
    release();
    expect(await done).toBe('signed');
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('Smlouva (signed).pdf');
    const req = signing.calls[0] as Record<string, unknown>;
    expect(req).toMatchObject({
      reason: 'Souhlasím',
      location: 'Brno',
      lock: true,
      keyAlg: 'ec',
      curve: 'P-256',
    });
    expect(signCalls[0][0]).toBe('cu:GOOD');
    expect(signCalls[0][2]).toBe('sha256');
    // Remembered for next time
    expect(localStorage.getItem('paperwing:signLock')).toBe('1');
  });

  for (const [code, message] of [
    ['wrong-pin', 'Wrong PIN. Try again.'],
    ['pin-blocked', 'Your card is locked. Contact whoever issued it.'],
    ['card-removed', 'Insert your card and select Refresh.'],
  ]) {
    it(`${code}: says so in plain words and stays open`, async () => {
      const { done } = await signAs();
      signReplies = [{ ok: false, error: code }];
      await sign();
      await until(() => status() === message);
      expect($<HTMLButtonElement>('#sas-sign')!.disabled).toBe(false);
      expect(saved).toHaveLength(0);
      // Next try works
      await sign();
      expect(await done).toBe('signed');
    });
  }

  it('a cancelled PIN prompt comes back quietly', async () => {
    const { done } = await signAs();
    signReplies = [{ ok: false, error: 'cancelled' }];
    await sign();
    await until(() => !$<HTMLButtonElement>('#sas-sign')!.disabled);
    expect(status()).toBe('');
    expect($('#sas-dialog')).not.toBeNull();
    $<HTMLButtonElement>('#sas-back')!.click();
    await until(() => $('#cid-dialog'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await done).toBe('cancelled');
  });

  it('Save As cancelled: not signed, and it says so', async () => {
    const { done } = await signAs();
    saveResult = false;
    await sign();
    await until(() => /wasn’t saved/.test(status() ?? ''));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await done).toBe('cancelled');
  });
});

describe('error messages', () => {
  it('names the system', () => {
    expect(errorMessage('key-unusable', true)).toMatch(/^macOS/);
    expect(errorMessage('key-unusable', false)).toMatch(/^Windows/);
    expect(errorMessage('cancelled', false)).toBeNull();
    expect(errorMessage('timeout', false)).toMatch(/too long/);
    expect(errorMessage('no-helper', false)).toMatch(/Reinstall/);
    expect(errorMessage('failed', false)).toMatch(/didn’t work/);
  });
});

describe('signature appearance text', async () => {
  const { detailLines, signatureDate, STANDARD } = await vi.importActual<
    typeof import('../acro/certs/appearance')
  >('../acro/certs/appearance');
  const values = {
    name: 'Jana Nováková',
    dn: 'CN=Jana Nováková, C=CZ',
    date: new Date(2026, 10, 6, 18, 30, 5),
    reason: 'Souhlasím',
    location: 'Brno',
  };

  it('Acrobat’s date format, with the time zone', () => {
    const s = signatureDate(values.date);
    expect(s).toMatch(/^2026\.11\.06 18:30:05 [+-]\d\d'\d\d'$/);
  });

  it('with labels; what isn’t filled in is left out', () => {
    expect(detailLines(STANDARD, values)).toEqual([
      'Digitally signed by Jana Nováková',
      'Reason: Souhlasím',
      'Location: Brno',
      `Date: ${signatureDate(values.date)}`,
    ]);
    expect(
      detailLines(STANDARD, { ...values, reason: undefined, location: '' })
    ).toEqual([
      'Digitally signed by Jana Nováková',
      `Date: ${signatureDate(values.date)}`,
    ]);
  });

  it('without labels, with the distinguished name', () => {
    const a = {
      ...STANDARD,
      show: { ...STANDARD.show, labels: false, dn: true, reason: false },
    };
    expect(detailLines(a, values)).toEqual([
      'Jana Nováková',
      'CN=Jana Nováková, C=CZ',
      'Brno',
      signatureDate(values.date),
    ]);
  });
});
