/**
 * Validate signatures in the desktop app: Acrobat's option to trust the
 * root certificates the computer trusts (the Windows certificate store,
 * the macOS Keychain), so certificates a company issues itself show as
 * trusted. Off by default. The tool page can't reach the desktop bridge;
 * the workspace asks the certificate helper for it (app.ts,
 * acro:system-roots).
 */
import { SHELL_ORIGIN, shellOrigin } from './origins';

const KEY = 'paperwing:trustSystemRoots';
const mac = /Mac/.test(navigator.platform);

/** Only inside the desktop app's workspace */
export function systemTrustAvailable(): boolean {
  return shellOrigin() === SHELL_ORIGIN;
}

export function systemTrustOn(): boolean {
  if (!systemTrustAvailable()) return false;
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let cached: Promise<Uint8Array[]> | null = null;

/** The system's root certificates (DER), asked for once */
export function systemRoots(): Promise<Uint8Array[]> {
  const shell = shellOrigin();
  if (!shell || shell !== SHELL_ORIGIN) return Promise.resolve([]);
  cached ??= new Promise((resolve) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      cached = null;
      resolve([]);
    }, 30000);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== shell || e.source !== window.parent) return;
      if (e.data?.type !== 'acro:system-roots' || e.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      const certs = Array.isArray(e.data.certs)
        ? (e.data.certs as unknown[]).filter(
            (c): c is Uint8Array => c instanceof Uint8Array
          )
        : [];
      if (!certs.length) cached = null;
      resolve(certs);
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'acro:system-roots', id }, shell);
  });
  return cached;
}

/**
 * Adds the option to the page, inside `container`; `onChange` runs when
 * it's switched (validate again)
 */
export function mountSystemTrustOption(
  container: HTMLElement | null,
  onChange: () => void
): void {
  if (!container || !systemTrustAvailable()) return;
  const store = mac ? 'the Keychain' : 'the Windows certificate store';
  const wrap = document.createElement('div');
  wrap.className = 'mt-4 p-3 rounded-lg border border-gray-600';
  wrap.id = 'system-trust';
  const label = document.createElement('label');
  label.className = 'flex items-center gap-2 cursor-pointer text-sm';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = 'system-trust-check';
  box.className = 'w-4 h-4';
  box.checked = systemTrustOn();
  label.append(
    box,
    document.createTextNode(`Trust root certificates in ${store}`)
  );
  const caution = document.createElement('p');
  caution.className = 'text-xs text-gray-400 mt-2';
  caution.textContent =
    `Signatures whose certificates lead to a root certificate in ${store} will show as trusted. ` +
    'Any root certificate added to this computer (by you, your organization or other software) ' +
    'is then trusted to vouch for signers, so turn this on only if you trust them all.';
  wrap.append(label, caution);
  container.append(wrap);
  box.addEventListener('change', () => {
    try {
      localStorage.setItem(KEY, box.checked ? '1' : '0');
    } catch {
      /* (this time only) */
    }
    onChange();
  });
}
