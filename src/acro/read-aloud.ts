/**
 * Read aloud (#60): the computer's own voices read the document, page by
 * page, and the word being read is highlighted on the page, in a colour the
 * reader picks. Only voices installed on the computer are offered (Windows,
 * macOS and Linux's speech engines, through the Web Speech API), so the text
 * never leaves the computer.
 *
 * Pausing stops the voice and remembers the word; going on starts again
 * from that word (pausing a voice in place doesn't work on every system).
 * The text is spoken a sentence at a time, so a change of voice or speed
 * takes effect at once, from the word being read.
 */
import type { Viewer } from './viewer';
import { findPages } from './form-layer';
import { icon } from './icons';
import { getPrefs, setPrefs } from './prefs';

export interface ReadAloudHost {
  viewer: Viewer;
  /** Shows a page (1-based); full screen turns its own pages */
  turnTo(tabId: string, page: number): void;
  /** Full screen: the page is fitted and fixed, never scrolled */
  presenting(): boolean;
  toast(message: string, action?: { label: string; onClick: () => void }): void;
  /** Recognize text (OCR) on the document */
  recognizeText(tabId: string): void;
  menu(
    anchor: HTMLElement,
    items: {
      label: string;
      icon?: Node;
      checked?: boolean;
      divider?: boolean;
      onClick?: () => void;
    }[]
  ): void;
  /** Shortcut shown next to a control, e.g. "Shift+Ctrl+C" */
  shortcut(id: string): string;
}

export interface ReadAloudPrefs {
  /** The voice's voiceURI ('' = the system's default voice) */
  voice: string;
  rate: number;
  /** Highlight colour ('' = no highlight) */
  color: string;
}

export const READ_ALOUD_DEFAULTS: ReadAloudPrefs = {
  voice: '',
  rate: 1,
  color: '#ffd400',
};

export const HIGHLIGHT_COLORS: [string, string][] = [
  ['Yellow', '#ffd400'],
  ['Green', '#4ade80'],
  ['Blue', '#60a5fa'],
  ['Pink', '#f472b6'],
  ['Orange', '#fb923c'],
];

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

interface PageText {
  /** The page's text, with line ends and control characters as spaces
   *  (same length as PDFium's, so indexes still match the boxes) */
  spoken: string;
  boxes: { x: number; y: number; w: number; h: number }[];
  /** Where the voice may pause: sentence ends, and the ends of short lines
   *  without punctuation (headings) */
  breaks: Set<number>;
}

interface Session {
  tabId: string;
  /** Page being read and the last one to read (0-based) */
  page: number;
  last: number;
  /** Where the word being read starts in the page's text */
  pos: number;
  paused: boolean;
  /** Bumped whenever speech is cancelled: late events are ignored */
  gen: number;
}

const MAX_CHUNK = 320;
/** How long a voice may take to start speaking */
const START_TIMEOUT = 10000;

/** Prefs as stored, with anything missing or broken put right */
export function readAloudPrefs(): ReadAloudPrefs {
  const p = getPrefs().readAloud as Partial<ReadAloudPrefs> | undefined;
  const rate = Number(p?.rate);
  return {
    voice: typeof p?.voice === 'string' ? p.voice : READ_ALOUD_DEFAULTS.voice,
    rate: SPEEDS.includes(rate) ? rate : READ_ALOUD_DEFAULTS.rate,
    color:
      typeof p?.color === 'string' &&
      (p.color === '' || /^#[0-9a-f]{6}$/i.test(p.color))
        ? p.color
        : READ_ALOUD_DEFAULTS.color,
  };
}

function savePrefs(patch: Partial<ReadAloudPrefs>) {
  setPrefs({ readAloud: { ...readAloudPrefs(), ...patch } });
}

/** The page's text made ready to speak */
export function prepareText(text: string, boxes: PageText['boxes']): PageText {
  // eslint-disable-next-line no-control-regex
  const spoken = text.replace(/[\u0000-\u001f\u007f￾￿]/g, ' ');
  const breaks = new Set<number>();
  // Sentence ends: . ! ? … (and closing quotes or brackets) before a space
  for (const m of spoken.matchAll(/[.!?…]["'”’)\]]*(?=\s)/g))
    breaks.add(m.index + m[0].length);
  // Line ends (PDFium's \r\n): a short line that doesn't end a sentence or
  // run on (comma, hyphen) is a heading or a list item
  const lines: { start: number; end: number }[] = [];
  let start = 0;
  for (const m of text.matchAll(/\r?\n/g)) {
    lines.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  lines.push({ start, end: text.length });
  const lengths = lines
    .map((l) => spoken.slice(l.start, l.end).trim().length)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const typical = lengths[Math.floor(lengths.length / 2)] ?? 0;
  for (const l of lines) {
    const line = spoken.slice(l.start, l.end).trimEnd();
    if (!line.trim() || l.end >= text.length) continue;
    if (/[,;\-–]$/.test(line)) continue;
    if (line.trim().length <= typical * 0.6) breaks.add(l.start + line.length);
  }
  return { spoken, boxes, breaks };
}

/** The next piece to speak from `pos`: [start, end), or null at the end */
export function chunkAt(t: PageText, pos: number): [number, number] | null {
  const s = t.spoken;
  let a = pos;
  while (a < s.length && /\s/.test(s[a])) a++;
  if (a >= s.length) return null;
  let b = -1;
  for (let i = a + 1; i <= s.length && i - a <= MAX_CHUNK; i++)
    if (t.breaks.has(i)) {
      b = i;
      break;
    }
  if (b < 0) {
    if (s.length - a <= MAX_CHUNK) b = s.length;
    else {
      // A very long sentence: cut it at a space
      const cut = s.lastIndexOf(' ', a + MAX_CHUNK);
      b = cut > a ? cut : a + MAX_CHUNK;
    }
  }
  return [a, b];
}

/** The boxes of the word starting at `at`, joined into one box per line */
export function wordRects(
  t: PageText,
  at: number,
  length?: number
): { x: number; y: number; w: number; h: number }[] {
  let end = at + (length && length > 0 ? length : 0);
  if (end <= at) {
    end = at;
    while (end < t.spoken.length && !/\s/.test(t.spoken[end])) end++;
  }
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  for (const b of t.boxes.slice(at, end)) {
    if (!b || !(b.w > 0) || !(b.h > 0)) continue;
    const r = rects[rects.length - 1];
    // Same line: the boxes overlap by half their height
    const overlap = r ? Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y) : 0;
    if (r && overlap > Math.min(r.h, b.h) / 2) {
      const x = Math.min(r.x, b.x);
      const y = Math.min(r.y, b.y);
      r.w = Math.max(r.x + r.w, b.x + b.w) - x;
      r.h = Math.max(r.y + r.h, b.y + b.h) - y;
      r.x = x;
      r.y = y;
    } else rects.push({ ...b });
  }
  return rects;
}

/** Voices on this computer, once the system has listed them */
function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const local = () => speechSynthesis.getVoices().filter((v) => v.localService);
  if (local().length) return Promise.resolve(local());
  return new Promise((resolve) => {
    const done = () => {
      speechSynthesis.removeEventListener('voiceschanged', done);
      clearTimeout(timer);
      resolve(local());
    };
    speechSynthesis.addEventListener('voiceschanged', done);
    const timer = setTimeout(done, 3000);
  });
}

function languageName(lang: string): string {
  try {
    const names = new Intl.DisplayNames([navigator.language || 'en'], {
      type: 'language',
      // "English (United States)", not "American English"
      languageDisplay: 'standard',
    });
    return names.of(lang.replace('_', '-')) ?? lang;
  } catch {
    return lang;
  }
}

/** A voice's name without what its language group already says:
 *  "Microsoft David - English (United States)" → "David",
 *  "Eddy (English (United States))" → "Eddy" */
export function voiceName(name: string, language: string): string {
  let n = name.replace(/^Microsoft\s+/, '');
  n = n.replace(/\s+[-–]\s+[^-–]+$/, '');
  if (n.endsWith(`(${language})`)) n = n.slice(0, -language.length - 2).trim();
  return n || name;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...(children.filter(Boolean) as (Node | string)[]));
  return e;
}

export class ReadAloud {
  private session: Session | null = null;
  private texts = new Map<number, Promise<PageText | null>>();
  private voices: SpeechSynthesisVoice[] = [];
  /** Kept so the browser doesn't drop it (and its events) while speaking */
  private utterance: SpeechSynthesisUtterance | null = null;
  private word: { page: number; at: number; length?: number } | null = null;
  /** The highlight follows the reading until the reader scrolls away */
  private following = true;
  private bar: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private playBtn: HTMLButtonElement | null = null;
  private offs: (() => void)[] = [];
  private watchdog = 0;
  /** Tests turn the voice down */
  volume = 1;

  constructor(private host: ReadAloudHost) {}

  get active(): boolean {
    return !!this.session;
  }

  get paused(): boolean {
    return !!this.session?.paused;
  }

  get tabId(): string | null {
    return this.session?.tabId ?? null;
  }

  /** Reads the page shown ('page') or from it to the end ('end') */
  async start(tabId: string, scope: 'page' | 'end'): Promise<void> {
    this.stop();
    const viewer = this.host.viewer;
    const info = viewer.pageInfo(tabId);
    if (!info) return;
    if (typeof speechSynthesis === 'undefined') {
      this.host.toast("Read aloud isn't available on this computer.");
      return;
    }
    this.voices = await loadVoices();
    if (!this.voices.length) {
      this.host.toast(
        'No voices are installed on this computer. Add one in your system’s speech settings, then try again.'
      );
      return;
    }
    const first = info.current - 1;
    const last = scope === 'page' ? first : info.total - 1;
    const page = await this.nextPageWithText(tabId, first, last);
    if (page < 0) {
      this.host.toast(
        scope === 'page'
          ? 'This page has no text to read. If it’s a scanned page, recognize its text first.'
          : 'There’s no text to read from this page on. If these are scanned pages, recognize their text first.',
        {
          label: 'Recognize text',
          onClick: () => this.host.recognizeText(tabId),
        }
      );
      return;
    }
    this.session = { tabId, page, last, pos: 0, paused: false, gen: 0 };
    this.following = true;
    this.showBar();
    this.listen();
    this.speakFrom(page, 0, true);
  }

  pause() {
    const s = this.session;
    if (!s || s.paused) return;
    s.paused = true;
    s.gen++;
    clearTimeout(this.watchdog);
    speechSynthesis.cancel();
    this.updateBar();
  }

  resume() {
    const s = this.session;
    if (!s || !s.paused) return;
    s.paused = false;
    this.following = true;
    this.updateBar();
    this.speakFrom(s.page, s.pos, true);
  }

  togglePause() {
    if (this.session?.paused) this.resume();
    else this.pause();
  }

  stop() {
    const s = this.session;
    if (!s) return;
    s.gen++;
    this.session = null;
    clearTimeout(this.watchdog);
    speechSynthesis.cancel();
    this.utterance = null;
    this.word = null;
    this.texts.clear();
    this.offs.forEach((off) => off());
    this.offs = [];
    this.clearHighlight();
    this.bar?.remove();
    this.bar = null;
    document.body.classList.remove('is-reading-aloud');
  }

  /** The document changed (pages edited, another file in the tab) */
  documentChanged(tabId: string) {
    if (this.session?.tabId !== tabId) return;
    this.stop();
  }

  private text(tabId: string, page: number): Promise<PageText | null> {
    let t = this.texts.get(page);
    if (!t) {
      t = this.host.viewer
        .pageText(tabId, page)
        .then((r) => (r ? prepareText(r.text, r.boxes) : null))
        .catch((): null => null);
      this.texts.set(page, t);
    }
    return t;
  }

  private async nextPageWithText(
    tabId: string,
    from: number,
    last: number
  ): Promise<number> {
    for (let p = from; p <= last; p++) {
      const t = await this.text(tabId, p);
      if (t && t.spoken.trim()) return p;
    }
    return -1;
  }

  private voice(): SpeechSynthesisVoice | undefined {
    const { voice } = readAloudPrefs();
    return (
      this.voices.find((v) => v.voiceURI === voice) ??
      this.voices.find((v) => v.default) ??
      this.voices.find((v) =>
        v.lang
          .toLowerCase()
          .startsWith((navigator.language || 'en').slice(0, 2))
      ) ??
      this.voices[0]
    );
  }

  /** Speaks from `pos` on page `page`, a sentence at a time */
  private async speakFrom(page: number, pos: number, restart = false) {
    const s = this.session;
    if (!s) return;
    const gen = ++s.gen;
    if (restart) {
      speechSynthesis.cancel();
      // (speaking straight after cancelling loses the new words on some
      // systems)
      await new Promise((r) => setTimeout(r, 60));
      if (gen !== s.gen) return;
    }
    const t = await this.text(s.tabId, page);
    if (gen !== s.gen || this.session !== s) return;
    const pageChanged = page !== s.page;
    s.page = page;
    s.pos = pos;
    const chunk = t ? chunkAt(t, pos) : null;
    if (!t || !chunk) {
      const next = await this.nextPageWithText(s.tabId, page + 1, s.last);
      if (gen !== s.gen || this.session !== s) return;
      if (next < 0) this.stop();
      else this.speakFrom(next, 0);
      return;
    }
    if (pageChanged || restart) {
      if (this.following || pageChanged) this.host.turnTo(s.tabId, page + 1);
      this.updateBar();
    }
    const [a, b] = chunk;
    const u = new SpeechSynthesisUtterance(t.spoken.slice(a, b));
    const voice = this.voice();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = readAloudPrefs().rate;
    u.volume = this.volume;
    // A voice that never starts (no sound device, a broken voice): say so
    // rather than show "Reading" with nothing heard
    clearTimeout(this.watchdog);
    this.watchdog = window.setTimeout(() => {
      if (gen !== s.gen || this.session !== s) return;
      this.stop();
      this.host.toast(
        'The voice didn’t start. Check your computer’s sound and speech settings, or choose another voice.'
      );
    }, START_TIMEOUT);
    u.onstart = () => {
      clearTimeout(this.watchdog);
      if (gen !== s.gen) return;
      s.pos = a;
      this.mark(page, a);
    };
    u.onboundary = (e) => {
      if (gen !== s.gen || e.name !== 'word') return;
      s.pos = a + e.charIndex;
      this.mark(page, s.pos, e.charLength);
    };
    u.onend = () => {
      if (gen === s.gen) void this.speakFrom(page, b);
    };
    u.onerror = (e) => {
      clearTimeout(this.watchdog);
      if (gen !== s.gen) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      this.stop();
      this.host.toast(`The voice stopped reading (${e.error}).`);
    };
    this.utterance = u;
    speechSynthesis.speak(u);
  }

  /* Highlight ----------------------------------------------------------- */

  private mark(page: number, at: number, length?: number) {
    this.word = { page, at, length };
    void this.draw();
  }

  private clearHighlight() {
    this.host.viewer
      .shadow()
      ?.querySelectorAll('.pw-ra-layer')
      .forEach((l) => l.remove());
  }

  /** Draws the word's highlight on its page (again after the pages move) */
  private async draw() {
    const s = this.session;
    const w = this.word;
    if (!s || !w) return;
    const t = await this.text(s.tabId, w.page);
    if (!t || this.word !== w) return;
    const viewer = this.host.viewer;
    const root = viewer.shadow();
    const layout = viewer.pageLayout(s.tabId);
    const size = viewer.pageSizes(s.tabId)[w.page];
    if (!root || !layout || !size || !viewer.isShowing(s.tabId)) return;
    const shown = findPages(root, layout);
    const target = shown.find((p) => p.index === w.page)?.page;
    // Highlights left on other pages
    root.querySelectorAll<HTMLElement>('.pw-ra-layer').forEach((l) => {
      if (l.parentElement !== target) l.remove();
    });
    const { color } = readAloudPrefs();
    if (!target || !color) {
      target?.querySelector('.pw-ra-layer')?.remove();
      return;
    }
    let layer = target.querySelector<HTMLElement>(':scope > .pw-ra-layer');
    if (!layer) {
      layer = el('div', { class: 'pw-ra-layer', 'aria-hidden': 'true' });
      // (multiply, like a highlighter: the text stays dark under the
      // colour; the layer blends with the page drawn under it)
      Object.assign(layer.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        mixBlendMode: 'multiply',
      });
      target.append(layer);
    }
    const rects = wordRects(t, w.at, w.length);
    const pad = 1.5;
    layer.replaceChildren(
      ...rects.map((r) => {
        const d = el('div', { class: 'pw-ra-word' });
        Object.assign(d.style, {
          position: 'absolute',
          left: `${((r.x - pad) / size.width) * 100}%`,
          top: `${((r.y - pad) / size.height) * 100}%`,
          width: `${((r.w + 2 * pad) / size.width) * 100}%`,
          height: `${((r.h + 2 * pad) / size.height) * 100}%`,
          background: color,
          opacity: '0.6',
          borderRadius: '2px',
        });
        return d;
      })
    );
    this.keepInView(layer.firstElementChild as HTMLElement | null);
  }

  /** Scrolls the word into view, unless the reader has scrolled away */
  private keepInView(word: HTMLElement | null) {
    if (!word || this.host.presenting()) return;
    const area = this.area();
    if (!area) return;
    const a = area.getBoundingClientRect();
    const r = word.getBoundingClientRect();
    const inView = r.top >= a.top + 24 && r.bottom <= a.bottom - 24;
    if (inView) {
      this.following = true;
      return;
    }
    if (!this.following) return;
    this.scrolling = true;
    area.scrollTop += r.top - (a.top + a.height / 3);
    setTimeout(() => (this.scrolling = false), 200);
  }

  private scrolling = false;

  private area(): HTMLElement | null {
    return (
      this.host.viewer.shadow()?.querySelector<HTMLElement>('.bg-bg-app') ??
      null
    );
  }

  private listen() {
    const viewer = this.host.viewer;
    this.offs.push(
      viewer.onPagesMoved((tabId) => {
        if (tabId === this.session?.tabId) void this.draw();
      })
    );
    // Scrolling by hand: the highlight stops pulling the page along
    const away = () => {
      if (!this.scrolling) this.following = false;
    };
    const area = this.area();
    if (area) {
      // (pointerdown: dragging the scroll bar, or clicking in the pages)
      const events = ['wheel', 'touchmove', 'pointerdown', 'keydown'];
      for (const type of events)
        area.addEventListener(type, away, { passive: true });
      this.offs.push(() => {
        for (const type of events) area.removeEventListener(type, away);
      });
    }
  }

  /* The control bar ------------------------------------------------------ */

  private showBar() {
    this.bar?.remove();
    const play = el('button', {
      type: 'button',
      class: 'ra-btn ra-play',
    }) as HTMLButtonElement;
    play.addEventListener('click', () => this.togglePause());
    const stop = el(
      'button',
      {
        type: 'button',
        class: 'ra-btn ra-stop',
        'aria-label': 'Stop reading',
        title: `Stop reading (${this.host.shortcut('readStop')})`,
      },
      icon('stop', 16)
    );
    stop.addEventListener('click', () => this.stop());

    const voice = el('select', {
      class: 'pref-select ra-voice',
      'aria-label': 'Voice',
      title: 'Voice',
    });
    this.fillVoices(voice);
    voice.addEventListener('change', () => {
      savePrefs({ voice: voice.value });
      this.restartAtWord();
    });

    const speed = el('select', {
      class: 'pref-select ra-speed',
      'aria-label': 'Speed',
      title: 'Speed',
    });
    for (const r of SPEEDS)
      speed.append(el('option', { value: String(r) }, `${r}×`));
    speed.value = String(readAloudPrefs().rate);
    speed.addEventListener('change', () => {
      savePrefs({ rate: Number(speed.value) });
      this.restartAtWord();
    });

    const swatch = el('span', { class: 'ra-swatch' });
    const colorBtn = el(
      'button',
      {
        type: 'button',
        class: 'ra-btn ra-color',
        'aria-label': 'Highlight colour',
        title: 'Highlight colour',
        'aria-haspopup': 'menu',
      },
      swatch
    ) as HTMLButtonElement;
    const custom = el('input', {
      type: 'color',
      class: 'ra-custom-color',
      tabindex: '-1',
      'aria-hidden': 'true',
    }) as HTMLInputElement;
    custom.addEventListener('input', () => this.setColor(custom.value));
    colorBtn.addEventListener('click', () => {
      const current = readAloudPrefs().color;
      const known = HIGHLIGHT_COLORS.some(([, c]) => c === current);
      this.host.menu(colorBtn, [
        ...HIGHLIGHT_COLORS.map(([name, c]) => ({
          label: name,
          icon: this.swatchIcon(c),
          checked: c === current,
          onClick: () => this.setColor(c),
        })),
        {
          label: 'Custom colour…',
          icon: this.swatchIcon(known || !current ? 'custom' : current),
          checked: !known && !!current,
          onClick: () => {
            custom.value = current || READ_ALOUD_DEFAULTS.color;
            custom.click();
          },
        },
        {
          label: 'No highlight',
          icon: this.swatchIcon(''),
          checked: !current,
          onClick: () => this.setColor(''),
        },
      ]);
    });

    this.status = el('span', { class: 'ra-status', 'aria-live': 'polite' });
    this.playBtn = play;
    this.bar = el(
      'div',
      { class: 'ra-bar', role: 'toolbar', 'aria-label': 'Read aloud' },
      play,
      stop,
      this.status,
      el('span', { class: 'ra-sep' }),
      voice,
      speed,
      colorBtn,
      custom
    );
    document.body.append(this.bar);
    document.body.classList.add('is-reading-aloud');
    this.updateBar();
  }

  private swatchIcon(color: string): HTMLElement {
    const s = el('span', { class: 'ra-swatch' });
    if (color === 'custom') s.classList.add('is-custom');
    else if (color) s.style.background = color;
    else s.classList.add('is-none');
    return s;
  }

  private setColor(color: string) {
    savePrefs({ color });
    this.updateBar();
    if (color) void this.draw();
    else this.clearHighlight();
  }

  private fillVoices(select: HTMLSelectElement) {
    const current = this.voice();
    const mine = (navigator.language || 'en').slice(0, 2).toLowerCase();
    const groups = new Map<string, SpeechSynthesisVoice[]>();
    for (const v of this.voices) {
      const name = languageName(v.lang);
      groups.set(name, [...(groups.get(name) ?? []), v]);
    }
    const order = [...groups.keys()].sort((x, y) => {
      const mx = groups.get(x)![0].lang.toLowerCase().startsWith(mine);
      const my = groups.get(y)![0].lang.toLowerCase().startsWith(mine);
      return mx === my ? x.localeCompare(y) : mx ? -1 : 1;
    });
    select.replaceChildren(
      ...order.map((name) =>
        el(
          'optgroup',
          { label: name },
          ...groups
            .get(name)!
            .sort((x, y) => x.name.localeCompare(y.name))
            .map((v) =>
              el('option', { value: v.voiceURI }, voiceName(v.name, name))
            )
        )
      )
    );
    if (current) select.value = current.voiceURI;
  }

  /** A new voice or speed: from the word being read, at once */
  private restartAtWord() {
    const s = this.session;
    if (!s || s.paused) return;
    void this.speakFrom(s.page, s.pos, true);
  }

  private updateBar() {
    const s = this.session;
    if (!s || !this.bar) return;
    const total = this.host.viewer.pageInfo(s.tabId)?.total ?? s.last + 1;
    if (this.status)
      this.status.textContent = s.paused
        ? `Paused · page ${s.page + 1} of ${total}`
        : `Reading page ${s.page + 1} of ${total}`;
    if (this.playBtn) {
      const label = s.paused ? 'Go on reading' : 'Pause reading';
      this.playBtn.replaceChildren(icon(s.paused ? 'play' : 'pause', 16));
      this.playBtn.setAttribute('aria-label', label);
      this.playBtn.title = `${label} (${this.host.shortcut('readPause')})`;
    }
    const color = readAloudPrefs().color;
    const swatch = this.bar.querySelector<HTMLElement>('.ra-color .ra-swatch');
    if (swatch) {
      swatch.style.background = color || '';
      swatch.classList.toggle('is-none', !color);
    }
  }
}
