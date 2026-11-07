/**
 * Digitally sign (desktop app), loaded when first used: drawing the box,
 * the Digital ID dialogs, and choosing an ID file.
 */
export { drawSignatureBox } from './sign-area';
export { digitallySign } from './sign-dialog';
export { lockedBySignature, pageRotation } from './pdf-sign';
import { combineIdFiles } from './file-id';

/** Choose an ID file with the system's file dialog: a .pfx/.p12, or PEM
 *  files (a certificate and its key can be in separate files, chosen
 *  together) */
export function pickIdFile(): Promise<{
  name: string;
  data: Uint8Array;
} | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pfx,.p12,.pem,.crt,.cer,.key';
    input.multiple = true;
    input.hidden = true;
    let settled = false;
    const finish = (v: { name: string; data: Uint8Array } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', async () => {
      const files = [...(input.files ?? [])];
      const read = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          data: new Uint8Array(await f.arrayBuffer()),
        }))
      );
      finish(combineIdFiles(read));
    });
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}
