/**
 * Digitally sign, steps 2 and 3 (Acrobat's flow, Paperwing's look):
 *
 *  - Sign with a Digital ID: the IDs on this computer (Windows store, smart
 *    cards and tokens, the Keychain) and ID files added, filtered the way
 *    Acrobat filters them (Show all certificates lists the rest, with why
 *    they can't sign), with View details, Refresh and Configure New Digital
 *    ID (use a file, or create a self-signed ID).
 *  - Sign as …: the appearance (made and edited here), reason, location,
 *    Lock document after signing, a timestamp server, then Sign and Save As.
 *
 * Installed IDs sign through the system, which asks for the PIN itself;
 * cancelling it comes back here quietly.
 */
import type { CertsBridge } from '../desktop';
import { icon } from '../icons';
import { showModal } from '../modal';
import { TIMESTAMP_TSA_PRESETS } from '../../js/config/timestamp-tsa';
import {
  allAppearances,
  deleteAppearance,
  drawAppearance,
  appearancePng,
  lastAppearanceId,
  rememberAppearance,
  saveAppearance,
  STANDARD,
  type Appearance,
  type AppearanceValues,
} from './appearance';
import { makePfx, readIdFile, PasswordError, FileIdError } from './file-id';
import {
  CertSignError,
  SOURCE_LABELS,
  errorMessage,
  fileIdEntry,
  installedIds,
  sortIds,
  type DigitalId,
} from './ids';
import { RevokedError } from './ltv';
import { signPdf } from './pdf-sign';
import type { DrawnBox } from './sign-area';
import { TimestampError, type Fetcher } from './tsa';
import {
  createSelfSignedId,
  extKeyUsageLabels,
  formatDate,
  keyUsageLabels,
} from './x509';

export interface SignContext {
  bridge?: CertsBridge;
  mac: boolean;
  docName: string;
  box: DrawnBox;
  /** The document as shown now */
  getPdf(): Promise<Uint8Array | null>;
  /** Save As for the signed document; true once it's saved */
  save(signed: Uint8Array, suggestedName: string): Promise<boolean>;
  /** Choose an ID file (.pfx, .p12, .pem) */
  pickIdFile(): Promise<{ name: string; data: Uint8Array } | null>;
  /** Save a new ID file where the user chooses; true once saved */
  saveIdFile(name: string, data: Uint8Array): Promise<boolean>;
}

/** ID files added this session (their keys stay in memory only) */
const fileIds: DigitalId[] = [];

const TSA_KEY = 'paperwing:signTimestamp';
const LOCK_KEY = 'paperwing:signLock';

const REASONS = [
  'I am the author of this document',
  'I have reviewed this document',
  'I am approving this document',
  'I attest to the accuracy and integrity of this document',
  'I agree to the terms defined by the placement of my signature',
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...(children.filter(Boolean) as (Node | string)[]));
  return e;
}

function button(
  cls: string,
  label: string,
  onClick: () => void,
  id?: string
): HTMLButtonElement {
  const b = el('button', { type: 'button', class: cls }, label);
  if (id) b.id = id;
  b.addEventListener('click', onClick);
  return b;
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* (not remembered) */
  }
}

interface Frame {
  backdrop: HTMLElement;
  dialog: HTMLElement;
  body: HTMLElement;
  status: HTMLElement;
  actions: HTMLElement;
  close(): void;
  /** Escape and the close button do this (unless busy) */
  onDismiss(fn: () => void): void;
  busy(on: boolean): void;
}

/** A dialog in Paperwing's style (print.ts's): title, body, status line,
 *  actions; modal, Escape closes it */
function frame(title: string, cls: string, id: string): Frame {
  let dismiss = () => {};
  let isBusy = false;
  const closeBtn = el('button', {
    type: 'button',
    class: 'tb-btn',
    title: 'Close',
    'aria-label': 'Close',
  });
  closeBtn.append(icon('close'));
  closeBtn.addEventListener('click', () => !isBusy && dismiss());
  const body = el('div', { class: 'dlg-body' });
  const status = el('p', {
    class: 'muted pd-status cs-status',
    role: 'status',
  });
  const actions = el('div', { class: 'dlg-actions' });
  const heading = el('h2', { id: `${id}-title` }, title);
  const dialog = el(
    'div',
    {
      class: `dlg ${cls}`,
      role: 'dialog',
      id,
      'aria-labelledby': `${id}-title`,
    },
    el('div', { class: 'dlg-head' }, heading, closeBtn),
    body
  );
  body.append(status, actions);
  const backdrop = el('div', { class: 'dlg-backdrop' }, dialog);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const all = document.querySelectorAll('.dlg-backdrop');
    if (all[all.length - 1] !== backdrop) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!isBusy) dismiss();
  };
  document.addEventListener('keydown', onKey, true);
  showModal(backdrop);
  return {
    backdrop,
    dialog,
    body,
    status,
    actions,
    close() {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
    },
    onDismiss(fn) {
      dismiss = fn;
    },
    busy(on) {
      isBusy = on;
      closeBtn.disabled = on;
    },
  };
}

/** Adds content above the status line */
function fill(f: Frame, ...nodes: (Node | false | null)[]) {
  f.status.before(...(nodes.filter(Boolean) as Node[]));
}

/* ------------------------------------------------------------------ */
/* The flow                                                            */
/* ------------------------------------------------------------------ */

/** Runs the dialogs; resolves once the signed document is saved, or the
 *  user gave up */
export async function digitallySign(
  ctx: SignContext
): Promise<'signed' | 'cancelled'> {
  let chosen: string | undefined;
  for (;;) {
    const id = await chooseId(ctx, chosen);
    if (!id) return 'cancelled';
    chosen = id.key;
    const outcome = await signAs(ctx, id);
    if (outcome === 'signed') return 'signed';
    if (outcome === 'cancelled') return 'cancelled';
  }
}

/* ------------------------------------------------------------------ */
/* Sign with a Digital ID                                              */
/* ------------------------------------------------------------------ */

function chooseId(
  ctx: SignContext,
  preselect?: string
): Promise<DigitalId | null> {
  return new Promise((resolve) => {
    const f = frame('Sign with a Digital ID', 'dlg-certs', 'cid-dialog');
    let ids: DigitalId[] = [];
    let error: string | null = null;
    let selected = preselect;
    let loading = true;
    const intro = el('p', {}, 'Choose the Digital ID you want to sign with:');
    const list = el('div', {
      class: 'cid-list',
      role: 'radiogroup',
      'aria-label': 'Digital IDs',
    });
    const showAll = el('input', { type: 'checkbox', id: 'cid-show-all' });
    const tools = el(
      'div',
      { class: 'cid-tools' },
      button('pill-btn', 'View details', () => details(), 'cid-details'),
      button('pill-btn', 'Refresh', () => void load(), 'cid-refresh'),
      el('span', { class: 'cid-spacer' }),
      button(
        'pill-btn',
        'Configure New Digital ID…',
        () => void configure(),
        'cid-configure'
      )
    );
    const showAllRow = el(
      'label',
      { class: 'pd-check' },
      showAll,
      'Show all certificates'
    );
    fill(f, intro, list, tools, showAllRow);
    const cancelBtn = button('quiet-btn', 'Cancel', () => done(null));
    const continueBtn = button(
      'accent-btn',
      'Continue',
      () => done(current() ?? null),
      'cid-continue'
    );
    f.actions.append(cancelBtn, continueBtn);
    f.onDismiss(() => done(null));
    showAll.addEventListener('change', render);

    function current(): DigitalId | undefined {
      const id = [...ids, ...fileIds].find((i) => i.key === selected);
      return id?.status.usable ? id : undefined;
    }

    function done(id: DigitalId | null) {
      f.close();
      resolve(id);
    }

    function render() {
      const all = sortIds([...fileIds, ...ids]);
      const visible = showAll.checked
        ? all
        : all.filter((i) => !i.status.hidden);
      list.replaceChildren();
      if (loading) {
        list.append(
          el('p', { class: 'cid-empty' }, 'Looking for your Digital IDs…')
        );
      } else if (!visible.length) {
        list.append(
          el(
            'p',
            { class: 'cid-empty' },
            error ??
              (all.length
                ? 'None of the certificates on this computer can sign documents. Select Show all certificates to see why, or configure a new Digital ID.'
                : 'No Digital IDs were found on this computer. If yours is on a smart card or USB token, insert it and select Refresh. You can also use an ID file, or create a new ID.')
          )
        );
      }
      if (!visible.some((i) => i.key === selected && i.status.usable))
        selected = visible.find((i) => i.status.usable)?.key ?? selected;
      for (const id of visible) {
        const radio = el('input', {
          type: 'radio',
          name: 'cid',
          value: id.key,
        });
        radio.checked = id.key === selected;
        radio.disabled = !id.status.usable;
        radio.addEventListener('change', () => {
          selected = id.key;
          enable();
        });
        const meta = id.status.usable
          ? `Issued by ${id.info.issuerName} · Valid until ${formatDate(id.info.notAfter)}`
          : (id.status.reason ?? '');
        const row = el(
          'label',
          {
            class: `cid-row${id.status.usable ? '' : ' is-disabled'}`,
            'data-key': id.key,
          },
          radio,
          el(
            'span',
            { class: 'cid-main' },
            el(
              'span',
              { class: 'cid-name' },
              el('b', {}, id.info.name),
              el(
                'span',
                { class: `cid-badge is-${id.source}` },
                SOURCE_LABELS[id.source]
              )
            ),
            el('small', { class: 'cid-meta' }, meta)
          )
        );
        row.addEventListener('click', () => {
          selected = id.key;
          enable();
        });
        row.addEventListener('dblclick', () => {
          if (id.status.usable) done(id);
        });
        list.append(row);
      }
      enable();
    }

    function enable() {
      continueBtn.disabled = !current();
      (f.dialog.querySelector('#cid-details') as HTMLButtonElement).disabled =
        ![...ids, ...fileIds].some((i) => i.key === selected);
    }

    async function load() {
      loading = true;
      error = null;
      render();
      if (ctx.bridge) {
        const res = await installedIds(ctx.bridge);
        ids = res.ids;
        if (res.error)
          error =
            res.error === 'no-helper'
              ? errorMessage('no-helper', ctx.mac)
              : 'Paperwing couldn’t read the certificates on this computer. Select Refresh to try again.';
      }
      loading = false;
      render();
    }

    function details() {
      const id = [...ids, ...fileIds].find((i) => i.key === selected);
      if (id) showDetails(id);
    }

    async function configure() {
      const added = await configureNewId(ctx);
      if (added) {
        if (!fileIds.some((i) => i.key === added.key)) fileIds.push(added);
        selected = added.key;
        render();
      }
    }

    void load();
  });
}

function showDetails(id: DigitalId) {
  const f = frame(
    'Certificate details',
    'dlg-cert-details',
    'cert-details-dialog'
  );
  const i = id.info;
  const key =
    i.keyAlg === 'rsa'
      ? `RSA ${i.keyBits}-bit`
      : i.keyAlg === 'ec'
        ? `ECDSA ${i.curve ?? 'unknown curve'}`
        : 'Not supported';
  const rows: [string, string][] = [
    ['Name', i.name],
    ['Email', i.email ?? ''],
    ['Organization', i.org ?? ''],
    [
      'Issued by',
      i.selfSigned ? `${i.issuerName} (self-signed)` : i.issuerName,
    ],
    ['Valid from', formatDate(i.notBefore)],
    ['Valid until', formatDate(i.notAfter)],
    ['Key', key],
    ['Key usage', i.keyUsage ? keyUsageLabels(i.keyUsage).join(', ') : 'Any'],
    [
      'Intended for',
      i.extKeyUsage
        ? extKeyUsageLabels(i.extKeyUsage).join(', ')
        : 'Any purpose',
    ],
    [
      'Stored in',
      `${SOURCE_LABELS[id.source]}${id.where ? ` (${id.where})` : ''}`,
    ],
    ['Can sign', id.status.usable ? 'Yes' : `No. ${id.status.reason ?? ''}`],
    ['Subject', i.subjectDn],
    ['Issuer', i.issuerDn],
    ['Serial number', i.serial],
    ['SHA-256 fingerprint', i.sha256],
    ['SHA-1 fingerprint', i.sha1],
  ];
  const table = el('table', { class: 'props-table' });
  for (const [k, v] of rows)
    if (v) table.append(el('tr', {}, el('th', {}, k), el('td', {}, v)));
  fill(f, table);
  const ok = button('accent-btn', 'Close', () => f.close());
  f.actions.append(ok);
  f.onDismiss(() => f.close());
  ok.focus();
}

/* ------------------------------------------------------------------ */
/* Configure New Digital ID                                            */
/* ------------------------------------------------------------------ */

async function configureNewId(ctx: SignContext): Promise<DigitalId | null> {
  const choice = await new Promise<'file' | 'create' | null>((resolve) => {
    const f = frame('Configure a Digital ID', 'dlg-certs-small', 'cfg-dialog');
    const option = (value: string, label: string, hint: string) => {
      const input = el('input', { type: 'radio', name: 'cfg', value });
      return {
        input,
        row: el(
          'label',
          { class: 'cid-row cfg-row' },
          input,
          el(
            'span',
            { class: 'cid-main' },
            el('b', {}, label),
            el('small', { class: 'cid-meta' }, hint)
          )
        ),
      };
    };
    const file = option(
      'file',
      'Use a Digital ID from a file',
      'A .pfx or .p12 file (or PEM) with your certificate and private key, protected by its password.'
    );
    const create = option(
      'create',
      'Create a new Digital ID',
      'A self-signed ID, saved as a password-protected .pfx file. Others can’t confirm who made it, so it’s best for testing or among people who trust each other.'
    );
    file.input.checked = true;
    fill(f, el('div', { class: 'cid-list cfg-list' }, file.row, create.row));
    const done = (v: 'file' | 'create' | null) => {
      f.close();
      resolve(v);
    };
    f.actions.append(
      button('quiet-btn', 'Cancel', () => done(null)),
      button(
        'accent-btn',
        'Continue',
        () => done(create.input.checked ? 'create' : 'file'),
        'cfg-continue'
      )
    );
    f.onDismiss(() => done(null));
  });
  if (choice === 'file') return addIdFile(ctx);
  if (choice === 'create') return createId(ctx);
  return null;
}

function field(
  label: string,
  input: HTMLInputElement | HTMLSelectElement,
  hint?: string
) {
  return el(
    'label',
    { class: 'cs-field' },
    el('span', {}, label),
    input,
    hint ? el('small', { class: 'pd-hint' }, hint) : null
  );
}

function addIdFile(ctx: SignContext): Promise<DigitalId | null> {
  return new Promise((resolve) => {
    const f = frame(
      'Use a Digital ID from a file',
      'dlg-certs-small',
      'idfile-dialog'
    );
    let picked: { name: string; data: Uint8Array } | null = null;
    const fileName = el('span', { class: 'idf-name muted' }, 'No file chosen');
    const browse = button(
      'pill-btn',
      'Browse…',
      () => void choose(),
      'idfile-browse'
    );
    const password = el('input', {
      type: 'password',
      class: 'dlg-input',
      id: 'idfile-password',
      autocomplete: 'off',
    });
    fill(
      f,
      el(
        'p',
        {},
        'Choose the file with your Digital ID and enter its password. The private key stays in memory and isn’t saved anywhere.'
      ),
      el('div', { class: 'idf-pick' }, browse, fileName),
      field('Password', password)
    );
    const add = button('accent-btn', 'Add', () => void submit(), 'idfile-add');
    f.actions.append(
      button('quiet-btn', 'Back', () => done(null)),
      add
    );
    f.onDismiss(() => done(null));
    password.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit();
    });
    const done = (id: DigitalId | null) => {
      f.close();
      resolve(id);
    };
    async function choose() {
      const got = await ctx.pickIdFile();
      if (!got) return;
      picked = got;
      fileName.textContent = got.name;
      f.status.textContent = '';
      password.focus();
    }
    async function submit() {
      if (!picked) {
        f.status.textContent = 'Choose a Digital ID file first.';
        return;
      }
      f.busy(true);
      add.disabled = true;
      f.status.textContent = 'Opening…';
      try {
        const id = await readIdFile(picked.name, picked.data, password.value);
        done(await fileIdEntry(id, picked.name));
      } catch (e) {
        f.status.textContent =
          e instanceof PasswordError
            ? password.value
              ? 'The password is incorrect.'
              : 'Enter the password for this file.'
            : e instanceof FileIdError
              ? e.message
              : 'This file isn’t a Digital ID Paperwing can read.';
        password.select();
      } finally {
        f.busy(false);
        add.disabled = false;
      }
    }
    void choose();
  });
}

function createId(ctx: SignContext): Promise<DigitalId | null> {
  return new Promise((resolve) => {
    const f = frame(
      'Create a new Digital ID',
      'dlg-certs-small',
      'newid-dialog'
    );
    const input = (
      id: string,
      type = 'text',
      extra: Record<string, string> = {}
    ) => el('input', { type, class: 'dlg-input', id, ...extra });
    const name = input('newid-name', 'text', { autocomplete: 'name' });
    const unit = input('newid-unit');
    const org = input('newid-org', 'text', { autocomplete: 'organization' });
    const email = input('newid-email', 'email', { autocomplete: 'email' });
    const country = input('newid-country', 'text', {
      maxlength: '2',
      placeholder: 'e.g. CZ',
    });
    const keyType = el('select', { class: 'pref-select', id: 'newid-key' });
    keyType.append(
      el('option', { value: 'rsa' }, '2048-bit RSA'),
      el('option', { value: 'ec' }, '256-bit ECDSA (P-256)')
    );
    const pw = input('newid-password', 'password', {
      autocomplete: 'new-password',
    });
    const pw2 = input('newid-password2', 'password', {
      autocomplete: 'new-password',
    });
    fill(
      f,
      el(
        'div',
        { class: 'cs-grid' },
        field('Name', name),
        field('Email address', email),
        field('Organization', org),
        field('Organizational unit', unit),
        field('Country or region', country),
        field('Key algorithm', keyType),
        field(
          'Password',
          pw,
          'At least 6 characters. You’ll need it each time you use this ID.'
        ),
        field('Confirm password', pw2)
      )
    );
    const save = button(
      'accent-btn',
      'Save…',
      () => void submit(),
      'newid-save'
    );
    f.actions.append(
      button('quiet-btn', 'Back', () => done(null)),
      save
    );
    f.onDismiss(() => done(null));
    queueMicrotask(() => name.focus());
    const done = (id: DigitalId | null) => {
      f.close();
      resolve(id);
    };
    async function submit() {
      const problem = !name.value.trim()
        ? 'Enter your name.'
        : country.value && !/^[A-Za-z]{2}$/.test(country.value)
          ? 'Enter the country as a two-letter code, like CZ or US.'
          : pw.value.length < 6
            ? 'The password needs at least 6 characters.'
            : pw.value !== pw2.value
              ? 'The passwords don’t match.'
              : null;
      if (problem) {
        f.status.textContent = problem;
        return;
      }
      f.busy(true);
      save.disabled = true;
      f.status.textContent = 'Creating your Digital ID…';
      try {
        const made = await createSelfSignedId({
          name: name.value,
          org: org.value,
          orgUnit: unit.value,
          email: email.value,
          country: country.value,
          keyType: keyType.value === 'ec' ? 'ec' : 'rsa',
        });
        const pfx = makePfx(
          made.keyDer,
          [made.certDer],
          pw.value,
          name.value.trim()
        );
        const fileName = `${name.value.trim().replace(/[\\/:*?"<>|]+/g, '')}.pfx`;
        f.status.textContent = 'Choose where to save it…';
        if (!(await ctx.saveIdFile(fileName, pfx))) {
          f.status.textContent =
            'The Digital ID wasn’t saved. Select Save to choose a place for it.';
          return;
        }
        const id = await readIdFile(fileName, pfx, pw.value);
        done(await fileIdEntry(id, fileName));
      } catch (e) {
        f.status.textContent = `Couldn’t create the Digital ID: ${(e as Error)?.message ?? e}`;
      } finally {
        f.busy(false);
        save.disabled = false;
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* Sign as …                                                           */
/* ------------------------------------------------------------------ */

function bridgeFetcher(bridge: CertsBridge): Fetcher {
  return async (url, init) => {
    const res = await bridge.fetch(url, init);
    if (res.error) throw new Error(res.error);
    return {
      status: res.status,
      contentType: res.contentType,
      body: new Uint8Array(res.body ?? []),
    };
  };
}

function signAs(
  ctx: SignContext,
  id: DigitalId
): Promise<'signed' | 'back' | 'cancelled'> {
  return new Promise((resolve) => {
    const f = frame(`Sign as “${id.info.name}”`, 'dlg-sign-as', 'sas-dialog');
    const { box } = ctx;
    const aspect =
      (box.box.width * box.pixels.width) / (box.box.height * box.pixels.height);
    const previewW = 300;
    const previewH = Math.max(40, Math.min(220, previewW / aspect));
    const canvas = el('canvas', {
      class: 'sas-preview',
      role: 'img',
      'aria-label': 'How the signature will look',
    });

    const appearance = el('select', {
      class: 'pref-select',
      id: 'sas-appearance',
      'aria-label': 'Appearance',
    });
    const fillAppearances = (select: string) => {
      appearance.replaceChildren(
        ...allAppearances().map((a) => el('option', { value: a.id }, a.title))
      );
      appearance.value = allAppearances().some((a) => a.id === select)
        ? select
        : STANDARD.id;
    };
    fillAppearances(lastAppearanceId());
    const editBtn = button(
      'pill-btn',
      'Edit',
      () => void edit(false),
      'sas-edit'
    );
    const createBtn = button(
      'pill-btn',
      'Create',
      () => void edit(true),
      'sas-create'
    );

    const reason = el('input', {
      class: 'dlg-input',
      id: 'sas-reason',
      list: 'sas-reasons',
      placeholder: 'Optional',
    });
    const reasons = el('datalist', { id: 'sas-reasons' });
    reasons.append(...REASONS.map((r) => el('option', { value: r })));
    const location = el('input', {
      class: 'dlg-input',
      id: 'sas-location',
      placeholder: 'Optional',
    });
    const lock = el('input', { type: 'checkbox', id: 'sas-lock' });
    lock.checked = stored(LOCK_KEY) === '1';
    const tsa = el('select', {
      class: 'pref-select',
      id: 'sas-tsa',
      'aria-label': 'Timestamp server',
    });
    tsa.append(
      el('option', { value: '' }, 'None'),
      ...TIMESTAMP_TSA_PRESETS.map((p) =>
        el('option', { value: p.url }, `${p.label} (${new URL(p.url).host})`)
      )
    );
    const savedTsa = stored(TSA_KEY) ?? '';
    tsa.value = TIMESTAMP_TSA_PRESETS.some((p) => p.url === savedTsa)
      ? savedTsa
      : '';
    tsa.disabled = !ctx.bridge;

    const settings = el(
      'div',
      { class: 'sas-settings' },
      el(
        'div',
        { class: 'cs-field' },
        el('span', {}, 'Appearance'),
        el(
          'div',
          { class: 'sas-appearance-row' },
          appearance,
          createBtn,
          editBtn
        )
      ),
      field('Reason', reason),
      reasons,
      field('Location', location),
      el('label', { class: 'pd-check' }, lock, 'Lock document after signing'),
      field(
        'Timestamp server',
        tsa,
        'A timestamp proves when you signed, even after your certificate expires. Needs an internet connection.'
      ),
      el(
        'p',
        { class: 'pd-hint sas-id' },
        `${SOURCE_LABELS[id.source]} ID issued by ${id.info.issuerName}, valid until ${formatDate(id.info.notAfter)}.`
      )
    );
    fill(
      f,
      el(
        'div',
        { class: 'sas-layout' },
        el('div', { class: 'sas-preview-wrap' }, canvas),
        settings
      )
    );
    const backBtn = button('quiet-btn', 'Back', () => done('back'), 'sas-back');
    const signBtn = button('accent-btn', 'Sign', () => void sign(), 'sas-sign');
    f.actions.append(backBtn, signBtn);
    f.onDismiss(() => done('cancelled'));

    const values = (): AppearanceValues => ({
      name: id.info.name,
      dn: id.info.subjectDn,
      date: new Date(),
      reason: reason.value.trim() || undefined,
      location: location.value.trim() || undefined,
    });
    const chosenAppearance = (): Appearance =>
      allAppearances().find((a) => a.id === appearance.value) ?? STANDARD;
    const redraw = () => {
      editBtn.disabled = chosenAppearance().id === STANDARD.id;
      void drawAppearance(
        canvas,
        chosenAppearance(),
        values(),
        previewW * 2,
        previewH * 2
      );
      canvas.style.width = `${previewW}px`;
      canvas.style.height = `${previewH}px`;
    };
    for (const c of [reason, location]) c.addEventListener('input', redraw);
    appearance.addEventListener('change', () => {
      rememberAppearance(appearance.value);
      redraw();
    });
    const clock = setInterval(redraw, 1000);
    redraw();
    queueMicrotask(() => signBtn.focus());

    function done(outcome: 'signed' | 'back' | 'cancelled') {
      clearInterval(clock);
      f.close();
      resolve(outcome);
    }

    async function edit(create: boolean) {
      const base = create
        ? { ...STANDARD, id: '', title: '' }
        : chosenAppearance();
      const result = await editAppearance(base, values(), aspect);
      if (result === 'deleted') fillAppearances(STANDARD.id);
      else if (result) fillAppearances(result.id);
      rememberAppearance(appearance.value);
      redraw();
    }

    function setBusy(on: boolean) {
      f.busy(on);
      for (const c of [
        signBtn,
        backBtn,
        appearance,
        editBtn,
        createBtn,
        reason,
        location,
        lock,
        tsa,
      ])
        (c as HTMLInputElement).disabled = on;
      if (!on) {
        tsa.disabled = !ctx.bridge;
        editBtn.disabled = chosenAppearance().id === STANDARD.id;
      }
    }

    async function sign() {
      if (!id.keyAlg) return;
      store(TSA_KEY, tsa.value);
      store(LOCK_KEY, lock.checked ? '1' : '0');
      setBusy(true);
      f.status.textContent =
        id.source === 'file'
          ? 'Signing…'
          : 'Waiting for your PIN or confirmation…';
      try {
        const pdf = await ctx.getPdf();
        if (!pdf) {
          f.status.textContent = 'Couldn’t read the document to sign it.';
          return;
        }
        const png = await appearancePng(
          chosenAppearance(),
          values(),
          box.box.width * box.pixels.width,
          box.box.height * box.pixels.height
        );
        const signed = await signPdf({
          pdf,
          certDer: id.certDer,
          chainDer: id.chainDer,
          keyAlg: id.keyAlg,
          curve: id.curve,
          sign: id.sign,
          reason: reason.value.trim() || undefined,
          location: location.value.trim() || undefined,
          appearance: { page: box.page, box: box.box, png },
          lock: lock.checked,
          tsaUrl: tsa.value || undefined,
          ltv: !!ctx.bridge,
          fetcher: ctx.bridge ? bridgeFetcher(ctx.bridge) : undefined,
        });
        f.status.textContent = 'Signed. Choose where to save it…';
        const stem = ctx.docName.replace(/\.pdf$/i, '');
        if (await ctx.save(signed, `${stem} (signed).pdf`)) {
          done('signed');
          return;
        }
        f.status.textContent =
          'The signed document wasn’t saved, so it isn’t signed. Select Sign to try again.';
      } catch (e) {
        if (e instanceof CertSignError) {
          f.status.textContent = errorMessage(e.code, ctx.mac) ?? '';
        } else if (e instanceof TimestampError || e instanceof RevokedError) {
          f.status.textContent = e.message;
        } else {
          console.error(e);
          f.status.textContent = `Couldn’t sign: ${(e as Error)?.message ?? e}`;
        }
      } finally {
        if (f.backdrop.isConnected) setBusy(false);
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* Appearance: create and edit                                         */
/* ------------------------------------------------------------------ */

function editAppearance(
  base: Appearance,
  sample: AppearanceValues,
  aspect: number
): Promise<Appearance | 'deleted' | null> {
  return new Promise((resolve) => {
    const isNew = !base.id;
    const f = frame(
      isNew ? 'Create a signature appearance' : 'Edit signature appearance',
      'dlg-appearance',
      'app-dialog'
    );
    let image = base.image;
    const title = el('input', {
      class: 'dlg-input',
      id: 'app-title',
      value: base.title,
      placeholder: 'e.g. With logo',
    });
    const graphic = (value: Appearance['graphic'], label: string) => {
      const input = el('input', { type: 'radio', name: 'app-graphic', value });
      input.checked = base.graphic === value;
      input.addEventListener('change', redraw);
      return { input, row: el('label', { class: 'pd-radio' }, input, label) };
    };
    const gName = graphic('name', 'Name');
    const gImage = graphic('image', 'Image');
    const gNone = graphic('none', 'No graphic');
    const imageBtn = button('pill-btn', 'Choose image…', () =>
      imageInput.click()
    );
    const imageInput = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg',
      hidden: '',
    });
    imageInput.addEventListener('change', () => {
      const file = imageInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        image = String(reader.result);
        gImage.input.checked = true;
        redraw();
      };
      reader.readAsDataURL(file);
    });
    const check = (key: keyof Appearance['show'], label: string) => {
      const input = el('input', { type: 'checkbox', 'data-show': key });
      input.checked = base.show[key];
      input.addEventListener('change', redraw);
      return {
        key,
        input,
        row: el('label', { class: 'pd-check' }, input, label),
      };
    };
    const checks = [
      check('name', 'Name'),
      check('date', 'Date'),
      check('reason', 'Reason'),
      check('location', 'Location'),
      check('dn', 'Distinguished name'),
      check('labels', 'Labels'),
    ];
    const canvas = el('canvas', { class: 'sas-preview' });
    const pw = 320;
    const ph = Math.max(40, Math.min(220, pw / aspect));
    canvas.style.width = `${pw}px`;
    canvas.style.height = `${ph}px`;
    fill(
      f,
      el('div', { class: 'sas-preview-wrap' }, canvas),
      field('Title', title),
      el(
        'div',
        { class: 'app-columns' },
        el(
          'fieldset',
          { class: 'app-set' },
          el('legend', {}, 'Graphic'),
          gName.row,
          el('div', { class: 'app-image' }, gImage.row, imageBtn, imageInput),
          gNone.row
        ),
        el(
          'fieldset',
          { class: 'app-set' },
          el('legend', {}, 'Text'),
          ...checks.map((c) => c.row)
        )
      )
    );
    const read = (): Appearance => ({
      id: base.id || `a${Date.now().toString(36)}`,
      title: title.value.trim() || 'My appearance',
      graphic: gImage.input.checked
        ? 'image'
        : gNone.input.checked
          ? 'none'
          : 'name',
      image,
      show: Object.fromEntries(
        checks.map((c) => [c.key, c.input.checked])
      ) as Appearance['show'],
    });
    function redraw() {
      void drawAppearance(canvas, read(), sample, pw * 2, ph * 2);
    }
    redraw();
    const done = (v: Appearance | 'deleted' | null) => {
      f.close();
      resolve(v);
    };
    if (!isNew)
      f.actions.append(
        button('quiet-btn', 'Delete', () => {
          deleteAppearance(base.id);
          done('deleted');
        })
      );
    else f.actions.append(button('quiet-btn', 'Cancel', () => done(null)));
    if (!isNew)
      f.actions.append(button('pill-btn', 'Cancel', () => done(null)));
    f.actions.append(
      button(
        'accent-btn',
        'Save',
        () => {
          const a = read();
          if (a.graphic === 'image' && !a.image) {
            f.status.textContent = 'Choose an image, or pick another graphic.';
            return;
          }
          saveAppearance(a);
          done(a);
        },
        'app-save'
      )
    );
    f.onDismiss(() => done(null));
    queueMicrotask(() => title.focus());
  });
}
