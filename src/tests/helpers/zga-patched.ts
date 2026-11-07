/**
 * zgapdfsigner as the app gets it: its files with Paperwing's build-time
 * patches applied (reskin/signer-patches.ts), loaded the way its Node entry
 * point (lib/zganode.js) loads them. Throws if a patch no longer fits.
 *
 *   vi.mock('zgapdfsigner', () => loadPatchedZga());
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { applyPatches, signerPatchesFor } from '../../../reskin/signer-patches';

export function loadPatchedZga(): Record<string, unknown> {
  const require = createRequire(import.meta.url);
  const lib = dirname(require.resolve('zgapdfsigner/lib/zganode.js'));
  const z = require(join(lib, 'zgaindex.js'));
  z.forge = require('node-forge');
  z.PDFLib = require('pdf-lib');
  z.fontkit = require('pdf-fontkit');
  z.pako = require('pako');
  for (const name of [
    'zgafetch.js',
    'zgacertsutil.js',
    'zgapdfcryptor.js',
    'zgapdfsigner.js',
  ]) {
    const file = join(lib, name).replace(/\\/g, '/');
    let code = readFileSync(file, 'utf8');
    const patches = signerPatchesFor(file);
    if (patches) {
      const result = applyPatches(code, patches);
      if (result.missed.length || result.applied.length !== patches.length)
        throw new Error(
          `zgapdfsigner patches don't fit ${name}: ${result.missed.join(', ') || 'not found'}`
        );
      code = result.code;
    }
    const module = { exports: {} as unknown };
    new Function('module', 'exports', 'require', code)(
      module,
      module.exports,
      require
    );
    (module.exports as (z: unknown) => void)(z);
  }
  return z;
}
