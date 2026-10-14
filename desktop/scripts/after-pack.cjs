/**
 * electron-builder afterPack hook, before the installers are made:
 *
 * - removes Chromium files Paperwing never uses
 *   - dxcompiler.dll / dxil.dll: DirectX shader compiler for WebGPU (~30 MB)
 *   - LICENSES.chromium.html is kept: Chromium's licence requires it.
 * - Windows: adds the File Explorer thumbnail provider built by
 *   native/win-thumbnails/build.ps1 (registered by build/installer.nsh).
 *   Release builds set PAPERWING_REQUIRE_THUMBNAILS=1 so it can't be left out.
 */
const { cpSync, existsSync, mkdirSync, rmSync, statSync } = require('node:fs');
const { join } = require('node:path');

const THUMBNAILS = join(__dirname, '..', 'native', 'win-thumbnails', 'out');

function addThumbnailProvider(appOutDir) {
  const files = ['PaperwingThumbnails.dll', 'pdfium.dll'];
  if (!files.every((f) => existsSync(join(THUMBNAILS, f)))) {
    const msg =
      'Explorer thumbnail provider not built (run native/win-thumbnails/build.ps1)';
    if (process.env.PAPERWING_REQUIRE_THUMBNAILS) throw new Error(msg);
    console.warn(`  • ${msg}; packaging without it`);
    return;
  }
  const dest = join(appOutDir, 'resources', 'thumbnails');
  mkdirSync(dest, { recursive: true });
  for (const f of [...files, 'pdfium-LICENSE.txt']) {
    if (existsSync(join(THUMBNAILS, f)))
      cpSync(join(THUMBNAILS, f), join(dest, f));
  }
  console.log('  • added the File Explorer thumbnail provider');
}

const UNUSED = {
  win32: ['dxcompiler.dll', 'dxil.dll'],
};

exports.default = async function afterPack({
  appOutDir,
  electronPlatformName,
}) {
  if (electronPlatformName === 'win32') addThumbnailProvider(appOutDir);
  let saved = 0;
  for (const name of UNUSED[electronPlatformName] ?? []) {
    const p = join(appOutDir, name);
    if (!existsSync(p)) continue;
    saved += statSync(p).size;
    rmSync(p);
  }
  if (saved)
    console.log(
      `  • afterPack removed ${(saved / 1048576).toFixed(1)} MB of unused Chromium files`
    );
};
