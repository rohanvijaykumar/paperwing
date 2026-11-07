/**
 * electron-builder afterPack hook, before the installers are made:
 *
 * - removes Chromium files Paperwing never uses
 *   - dxcompiler.dll / dxil.dll: DirectX shader compiler for WebGPU (~30 MB)
 *   - LICENSES.chromium.html is kept: Chromium's licence requires it.
 * - Windows: adds the File Explorer thumbnail provider built by
 *   native/win-thumbnails/build.ps1 (registered by build/installer.nsh).
 *   Release builds set PAPERWING_REQUIRE_THUMBNAILS=1 so it can't be left out.
 * - macOS: adds the scanner helper built by native/mac-scanner/build.sh.
 * - Windows: checks the scanner helpers built by native/win-scanner/build.mjs
 *   are in resources/scanner (electron-builder.yml copies them).
 *   Release builds set PAPERWING_REQUIRE_SCANNER=1 so neither can be left out.
 */
const {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} = require('node:fs');
const { join } = require('node:path');

const THUMBNAILS = join(__dirname, '..', 'native', 'win-thumbnails', 'out');
const SCANNER = join(__dirname, '..', 'native', 'mac-scanner', 'out');

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

function addScannerHelper(appOutDir, productName) {
  const helper = join(SCANNER, 'paperwing-scan');
  if (!existsSync(helper)) {
    const msg = 'Scanner helper not built (run native/mac-scanner/build.sh)';
    if (process.env.PAPERWING_REQUIRE_SCANNER) throw new Error(msg);
    console.warn(`  • ${msg}; packaging without it`);
    return;
  }
  const dest = join(
    appOutDir,
    `${productName}.app`,
    'Contents',
    'Resources',
    'scanner'
  );
  mkdirSync(dest, { recursive: true });
  cpSync(helper, join(dest, 'paperwing-scan'));
  chmodSync(join(dest, 'paperwing-scan'), 0o755);
  console.log('  • added the scanner helper');
}

function checkWindowsScanner(appOutDir) {
  const dir = join(appOutDir, 'resources', 'scanner');
  const files = [
    'paperwing-scan.exe',
    'paperwing-twain32.exe',
    'NAPS2.Wia.dll',
    'NTwain.dll',
  ];
  const missing = files.filter((f) => !existsSync(join(dir, f)));
  if (!missing.length) {
    console.log('  • added the scanner helpers');
    return;
  }
  const msg = `Scanner helpers not built (run native/win-scanner/build.mjs): missing ${missing.join(', ')}`;
  if (process.env.PAPERWING_REQUIRE_SCANNER) throw new Error(msg);
  console.warn(`  • ${msg}; packaging without them`);
}

const UNUSED = {
  win32: ['dxcompiler.dll', 'dxil.dll'],
};

exports.default = async function afterPack({
  appOutDir,
  electronPlatformName,
  packager,
}) {
  if (electronPlatformName === 'win32') {
    addThumbnailProvider(appOutDir);
    checkWindowsScanner(appOutDir);
  }
  if (electronPlatformName === 'darwin')
    addScannerHelper(appOutDir, packager.appInfo.productFilename);
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
