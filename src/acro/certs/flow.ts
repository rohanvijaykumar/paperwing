/**
 * Digitally sign (desktop app), loaded when first used: drawing the box,
 * the Digital ID dialogs, and choosing an ID file.
 */
export { drawSignatureBox } from './sign-area';
export { digitallySign } from './sign-dialog';
export { lockedBySignature } from './pdf-sign';

/** Choose an ID file with the system's file dialog */
export function pickIdFile(): Promise<{
  name: string;
  data: Uint8Array;
} | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pfx,.p12,.pem,.crt,.cer,.key';
    input.hidden = true;
    let settled = false;
    const finish = (v: { name: string; data: Uint8Array } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      finish(
        file
          ? { name: file.name, data: new Uint8Array(await file.arrayBuffer()) }
          : null
      );
    });
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}
