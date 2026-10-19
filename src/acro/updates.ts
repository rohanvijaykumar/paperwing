/**
 * Update check against the project's GitHub Releases.
 *
 * The Windows installer updates itself (desktop/main.cjs): the check starts
 * a background download, and the app offers a restart once it's ready. Other
 * builds (portable, macOS, the browser) are told a new version exists: the
 * workspace shows a notice that stays, and a marker until they've updated
 * (onUpdateAvailable), and Download fetches the file for their platform.
 */
import { desktop } from './desktop';

declare const __PAPERWING_VERSION__: string;
declare const __PAPERWING_REPO__: string;

type Toast = (
  msg: string,
  action?: { label: string; onClick: () => void }
) => void;

const LAST_CHECK_KEY = 'paperwing:lastUpdateCheck';
/** The newer version last seen, so the marker survives restarts */
const AVAILABLE_KEY = 'paperwing:availableUpdate';
const DAY = 24 * 60 * 60 * 1000;

/** A newer version than this one, for builds that don't update themselves */
export interface AvailableUpdate {
  version: string;
  /** The release page */
  page: string;
  /** The file for this platform, when the release has one */
  download: string | null;
}

/** What the desktop app says about itself (main.cjs) */
export interface BuildInfo {
  platform?: string;
  arch?: string;
  portable?: boolean;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

/** The release file for this build: the DMG for the Mac's chip, or the
 *  portable zip. Null when there isn't one (the release page instead) */
export function pickAsset(
  assets: ReleaseAsset[],
  build: BuildInfo
): string | null {
  const find = (re: RegExp) =>
    assets.find((a) => re.test(a.name))?.browser_download_url ?? null;
  if (build.platform === 'darwin')
    return find(
      build.arch === 'arm64' ? /-mac-arm64\.dmg$/i : /-mac-x64\.dmg$/i
    );
  if (build.platform === 'win32')
    return build.portable
      ? find(/-Portable-.*-win-x64\.zip$/i)
      : find(/-Setup-.*-x64\.exe$/i);
  return null;
}

type UpdateListener = (update: AvailableUpdate, fresh: boolean) => void;
const listeners = new Set<UpdateListener>();

/** The newer version found by an earlier check, if this one is still older */
export function knownUpdate(): AvailableUpdate | null {
  try {
    const raw = localStorage.getItem(AVAILABLE_KEY);
    const update = raw ? (JSON.parse(raw) as AvailableUpdate) : null;
    if (update?.version && isNewer(update.version, __PAPERWING_VERSION__))
      return update;
    if (raw) localStorage.removeItem(AVAILABLE_KEY);
  } catch {
    /* storage unavailable */
  }
  return null;
}

/**
 * Calls `fn` for each newer version found (`fresh`), and once now with the
 * one an earlier check found, if there is one (not fresh)
 */
export function onUpdateAvailable(fn: UpdateListener): () => void {
  listeners.add(fn);
  const known = knownUpdate();
  if (known) fn(known, false);
  return () => listeners.delete(fn);
}

function announce(update: AvailableUpdate) {
  try {
    localStorage.setItem(AVAILABLE_KEY, JSON.stringify(update));
  } catch {
    /* storage unavailable */
  }
  for (const fn of listeners) fn(update, true);
}

/** True if release tag `latest` is a higher version than `current` */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export async function checkForUpdates(
  toast: Toast,
  manual = false
): Promise<void> {
  const auto = await desktop?.checkUpdate?.().catch((): null => null);
  if (auto?.auto) {
    markChecked();
    if (!manual) return; // a downloaded update announces itself
    if (auto.error) toast("Couldn't check for updates. Are you online?");
    else if (auto.ready)
      return; // its restart notice is showing
    else if (auto.available)
      toast(
        `Downloading Paperwing ${auto.version}. You'll be asked to restart when it's ready.`
      );
    else toast(`You're up to date (version ${__PAPERWING_VERSION__})`);
    return;
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${__PAPERWING_REPO__}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const release = (await res.json()) as {
      tag_name: string;
      html_url: string;
      assets?: ReleaseAsset[];
    };
    markChecked();
    if (isNewer(release.tag_name, __PAPERWING_VERSION__)) {
      announce({
        version: release.tag_name.replace(/^v/, ''),
        page: release.html_url,
        download: pickAsset(release.assets ?? [], auto ?? {}),
      });
    } else if (manual) {
      toast(`You're up to date (version ${__PAPERWING_VERSION__})`);
    }
  } catch {
    if (manual) toast("Couldn't check for updates. Are you online?");
  }
}

function markChecked() {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    /* storage unavailable */
  }
}

/** Check quietly at most once a day, a few seconds after startup */
export function scheduleUpdateCheck(toast: Toast) {
  let last = 0;
  try {
    last = Number(localStorage.getItem(LAST_CHECK_KEY)) || 0;
  } catch {
    /* storage unavailable */
  }
  if (Date.now() - last < DAY) return;
  setTimeout(() => void checkForUpdates(toast), 8000);
}
