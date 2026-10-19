/**
 * Tooltips, Acrobat-style, for the workspace and every tool page: a small
 * label under the control after a short pause, with its keyboard shortcut
 * in a lighter tone. They replace the browser's own title tooltips.
 *
 * Any element with a `title` (or `data-tip`) gets one; so does an icon-only
 * button that only has an `aria-label`. A title like "Zoom level (Ctrl+Y)"
 * shows the shortcut separately. `data-tip-shortcut` sets it explicitly,
 * and `data-tip="none"` turns the tooltip off.
 */

const SHOW_DELAY = 550;
/** Moving from one control to the next soon after shows at once */
const WARM_MS = 400;
const GAP = 6;

const STYLE = `
.pw-tip {
  position: fixed;
  z-index: 2147483647;
  max-width: 280px;
  padding: 5px 9px;
  border-radius: 4px;
  background: light-dark(#323232, #ebebeb);
  color: light-dark(#fff, #1b1b1b);
  font: 500 12px/1.35 'Source Sans 3', 'Segoe UI', system-ui, sans-serif;
  letter-spacing: 0.01em;
  white-space: normal;
  pointer-events: none;
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.18);
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 0.1s ease, transform 0.1s ease;
}
.pw-tip.is-above { transform: translateY(2px); }
.pw-tip.is-shown { opacity: 1; transform: none; }
.pw-tip kbd {
  margin-left: 6px;
  font: inherit;
  opacity: 0.68;
}
@media (prefers-reduced-motion: reduce) {
  .pw-tip { transition: none; }
}`;

let tip: HTMLDivElement | null = null;
let target: Element | null = null;
let timer = 0;
let hiddenAt = 0;

/** "Zoom level (Ctrl+Y)" -> ["Zoom level", "Ctrl+Y"] */
function splitShortcut(text: string): [string, string] {
  const m =
    /^(.*\S)\s+\(([^()]*(?:Ctrl|Cmd|Alt|Shift|⌘|⌥|⇧|F\d+|Esc|Del|\b[A-Z]\b)[^()]*)\)$/.exec(
      text.trim()
    );
  return m ? [m[1], forPlatform(m[2])] : [text.trim(), ''];
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** Mac key symbols (⌘S, ⇧⌘Z) read as Ctrl+S, Ctrl+Shift+Z elsewhere */
function forPlatform(keys: string): string {
  if (IS_MAC || !/[⌘⌥⇧]/.test(keys)) return keys;
  const mods = [
    keys.includes('⌘') && 'Ctrl',
    keys.includes('⇧') && 'Shift',
    keys.includes('⌥') && 'Alt',
  ].filter(Boolean);
  return [...mods, keys.replace(/[⌘⌥⇧]/g, '').trim()].join('+');
}

/** The element a pointer or focus target should show a tooltip for */
function tipTarget(el: EventTarget | null): Element | null {
  if (!(el instanceof Element)) return null;
  const t = el.closest(
    '[title], [data-tip], button[aria-label], [role="button"][aria-label], a[aria-label]'
  );
  if (!t || t.getAttribute('data-tip') === 'none') return null;
  // A labelled button that shows its label as text needs no tooltip
  if (!t.hasAttribute('title') && !t.hasAttribute('data-tip')) {
    if ((t.textContent || '').trim()) return null;
  }
  return t;
}

/** The tooltip's text: moves `title` aside so the browser's own tooltip
 *  doesn't show as well */
function tipText(t: Element): [string, string] {
  const title = t.getAttribute('title');
  if (title) {
    t.setAttribute('data-tip', title);
    if (!t.hasAttribute('aria-label') && !(t.textContent || '').trim())
      t.setAttribute('aria-label', splitShortcut(title)[0]);
    t.removeAttribute('title');
  }
  const text = t.getAttribute('data-tip') || t.getAttribute('aria-label') || '';
  const [label, inText] = splitShortcut(text);
  return [label, t.getAttribute('data-tip-shortcut') || inText];
}

function place(el: HTMLDivElement, t: Element) {
  const r = t.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let top = r.bottom + GAP;
  let above = false;
  if (top + h > innerHeight - 4 && r.top - GAP - h > 4) {
    top = r.top - GAP - h;
    above = true;
  }
  let left = r.left + r.width / 2 - w / 2;
  // Beside a vertical toolbar reads better than below: to the right of the
  // floating one, to the left of the rail at the window's edge
  if (t.closest('#quickbar, #right-rail')) {
    left = t.closest('#quickbar') ? r.right + GAP : r.left - GAP - w;
    top = r.top + r.height / 2 - h / 2;
    above = false;
  }
  left = Math.max(4, Math.min(left, innerWidth - w - 4));
  top = Math.max(4, Math.min(top, innerHeight - h - 4));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.classList.toggle('is-above', above);
}

function show(t: Element) {
  const [label, shortcut] = tipText(t);
  if (!label) return;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'pw-tip';
    tip.setAttribute('role', 'tooltip');
    tip.id = 'pw-tip';
  }
  tip.replaceChildren(label);
  if (shortcut) {
    const k = document.createElement('kbd');
    k.textContent = shortcut;
    tip.append(k);
  }
  document.body.append(tip);
  place(tip, t);
  t.setAttribute('aria-describedby', 'pw-tip');
  requestAnimationFrame(() => tip?.classList.add('is-shown'));
}

function hide() {
  clearTimeout(timer);
  if (target) target.removeAttribute('aria-describedby');
  if (tip?.isConnected) {
    tip.remove();
    tip.classList.remove('is-shown');
    hiddenAt = performance.now();
  }
  target = null;
}

function schedule(t: Element) {
  if (t === target) return;
  hide();
  target = t;
  const warm = performance.now() - hiddenAt < WARM_MS;
  timer = window.setTimeout(
    () => {
      if (target === t && t.isConnected) show(t);
    },
    warm ? 0 : SHOW_DELAY
  );
}

let started = false;

export function initTooltips() {
  if (started) return;
  started = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);

  document.addEventListener('pointerover', (e) => {
    if ((e as PointerEvent).pointerType === 'touch') return;
    const t = tipTarget(e.target);
    if (t) schedule(t);
    else if (target && !target.contains(e.target as Node)) hide();
  });
  document.addEventListener('pointerout', (e) => {
    if (target && !target.contains(e.relatedTarget as Node)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target as Element;
    if (!el.matches?.(':focus-visible')) return;
    const t = tipTarget(el);
    if (t) schedule(t);
  });
  document.addEventListener('focusout', hide);
  for (const type of ['pointerdown', 'keydown', 'wheel']) {
    document.addEventListener(type, hide, { capture: true, passive: true });
  }
  window.addEventListener('blur', hide);
  window.addEventListener('scroll', hide, { capture: true, passive: true });
  // Titles set later (re-rendered controls) are picked up on hover; the
  // browser's own tooltip would win the race, so new ones are moved now
  new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as Element;
      if (r.type === 'attributes' && el.hasAttribute('title')) tipText(el);
      for (const n of r.addedNodes) {
        if (!(n instanceof Element)) continue;
        if (n.hasAttribute('title')) tipText(n);
        n.querySelectorAll('[title]').forEach(tipText);
      }
    }
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['title'],
  });
  document.querySelectorAll('[title]').forEach(tipText);
}
