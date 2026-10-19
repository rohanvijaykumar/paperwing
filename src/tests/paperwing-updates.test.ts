/**
 * Updates for builds that don't update themselves (macOS, Windows portable):
 * the file to download, and the newer version remembered across restarts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).__PAPERWING_VERSION__ = '1.2.0';
(globalThis as any).__PAPERWING_REPO__ = 'owner/paperwing';

// The desktop app's bridge: a Mac build, which doesn't update itself
vi.mock('../acro/desktop', () => ({
  desktop: {
    checkUpdate: async () => ({
      auto: false,
      platform: 'darwin',
      arch: 'arm64',
    }),
  },
}));

import {
  checkForUpdates,
  knownUpdate,
  onUpdateAvailable,
  pickAsset,
} from '../acro/updates';

const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/owner/paperwing/releases/download/v1.3.0/${name}`,
});
const ASSETS = [
  asset('Paperwing-Setup-1.3.0-x64.exe'),
  asset('Paperwing-Setup-1.3.0-x64.exe.blockmap'),
  asset('Paperwing-Portable-1.3.0-win-x64.zip'),
  asset('Paperwing-1.3.0-mac-arm64.dmg'),
  asset('Paperwing-1.3.0-mac-x64.dmg'),
  asset('latest.yml'),
];

describe('pickAsset', () => {
  it('picks the DMG for the Mac’s chip', () => {
    expect(pickAsset(ASSETS, { platform: 'darwin', arch: 'arm64' })).toMatch(
      /mac-arm64\.dmg$/
    );
    expect(pickAsset(ASSETS, { platform: 'darwin', arch: 'x64' })).toMatch(
      /mac-x64\.dmg$/
    );
  });
  it('picks the portable zip for the portable build, the installer otherwise', () => {
    expect(
      pickAsset(ASSETS, { platform: 'win32', arch: 'x64', portable: true })
    ).toMatch(/Portable-1\.3\.0-win-x64\.zip$/);
    expect(pickAsset(ASSETS, { platform: 'win32', arch: 'x64' })).toMatch(
      /Setup-1\.3\.0-x64\.exe$/
    );
  });
  it('gives nothing for a platform without a file (the release page instead)', () => {
    expect(pickAsset(ASSETS, { platform: 'linux', arch: 'x64' })).toBeNull();
    expect(pickAsset(ASSETS, {})).toBeNull();
    expect(pickAsset([], { platform: 'darwin', arch: 'arm64' })).toBeNull();
  });
});

describe('a newer version is remembered until this build is updated', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('announces a newer release with the file for this platform, and keeps it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v1.3.0',
          html_url: 'https://github.com/owner/paperwing/releases/tag/v1.3.0',
          assets: ASSETS,
        })
      )
    );
    const seen: Array<[string, boolean, string | null]> = [];
    const stop = onUpdateAvailable((u, fresh) =>
      seen.push([u.version, fresh, u.download])
    );
    await checkForUpdates(() => {});
    stop();
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe('1.3.0');
    expect(seen[0][1]).toBe(true);
    expect(knownUpdate()?.version).toBe('1.3.0');

    // After a restart: the marker comes back without a notice
    const again: boolean[] = [];
    onUpdateAvailable((_u, fresh) => again.push(fresh))();
    expect(again).toEqual([false]);
  });

  it('forgets a version this build has reached', () => {
    localStorage.setItem(
      'paperwing:availableUpdate',
      JSON.stringify({ version: '1.2.0', page: 'x', download: null })
    );
    expect(knownUpdate()).toBeNull();
    expect(localStorage.getItem('paperwing:availableUpdate')).toBeNull();
  });
});
