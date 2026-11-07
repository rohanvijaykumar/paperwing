/**
 * The scan dialog's pages: thumbnails as they arrive, then after each pass
 * rotate, delete, drag to reorder (or Ctrl+arrow keys), rescan this page,
 * and pages found blank shown as left out, with Keep to keep them.
 */
import { icon } from './icons';

export interface ReviewPage {
  id: number;
  /** The thumbnail ('' while it's being cleaned up) */
  url: string;
  rotation: number;
  /** Found blank: left out unless kept */
  blank: boolean;
  keep: boolean;
  canRescan: boolean;
}

export interface ReviewActions {
  rotate(id: number, by: 90 | -90): void;
  remove(id: number): void;
  /** Moves the page to `to` (an index among all pages) */
  move(id: number, to: number): void;
  rescan(id: number): void;
  keep(id: number): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...(children.filter(Boolean) as (Node | string)[]));
  return e;
}

export function createReview(actions: ReviewActions) {
  const list = el('div', {
    class: 'sr-pages',
    role: 'list',
    'aria-label': 'Scanned pages',
  });
  const empty = el('p', { class: 'sr-empty' });
  const root = el('div', { class: 'sr-review' }, list, empty);
  let pages: ReviewPage[] = [];
  let locked = false;

  const tool = (
    label: string,
    glyph: 'rotateCcw' | 'rotate' | 'refresh' | 'trash',
    onClick: () => void
  ) => {
    const b = el(
      'button',
      { type: 'button', class: 'sr-tool', title: label, 'aria-label': label },
      icon(glyph, 14)
    );
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!locked) onClick();
    });
    return b;
  };

  function card(p: ReviewPage, k: number) {
    const n = k + 1;
    const left = p.blank && !p.keep;
    const img = p.url
      ? el('img', { src: p.url, alt: '', draggable: 'false' })
      : el('span', { class: 'sr-wait' }, 'Cleaning up…');
    if (p.url) (img as HTMLElement).style.transform = `rotate(${p.rotation}deg)`;
    const tools = el(
      'div',
      { class: 'sr-tools' },
      tool(`Rotate page ${n} counterclockwise`, 'rotateCcw', () =>
        actions.rotate(p.id, -90)
      ),
      tool(`Rotate page ${n} clockwise`, 'rotate', () => actions.rotate(p.id, 90)),
      p.canRescan
        ? tool(`Rescan page ${n}`, 'refresh', () => actions.rescan(p.id))
        : null,
      tool(`Delete page ${n}`, 'trash', () => actions.remove(p.id))
    );
    const keep = left
      ? el(
          'button',
          { type: 'button', class: 'sr-keep', 'aria-label': `Keep blank page ${n}` },
          'Keep'
        )
      : null;
    keep?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!locked) actions.keep(p.id);
    });
    const item = el(
      'div',
      {
        class: `sr-page${left ? ' is-left-out' : ''}`,
        role: 'listitem',
        tabindex: '0',
        'data-id': String(p.id),
        'aria-label': left
          ? `Page ${n}, blank: left out`
          : `Page ${n}${p.rotation ? `, turned ${p.rotation}°` : ''}`,
        title: 'Drag to move. Ctrl+arrow keys move it too.',
      },
      el('div', { class: 'sr-thumb' }, img),
      el(
        'div',
        { class: 'sr-foot' },
        el('span', { class: 'sr-num' }, left ? `${n} · Blank` : String(n)),
        keep
      ),
      tools
    );
    item.addEventListener('keydown', (e) => {
      if (locked) return;
      const step =
        (e.ctrlKey || e.metaKey) && e.key === 'ArrowLeft'
          ? -1
          : (e.ctrlKey || e.metaKey) && e.key === 'ArrowRight'
            ? 1
            : 0;
      if (step) {
        e.preventDefault();
        const to = Math.min(pages.length - 1, Math.max(0, k + step));
        if (to !== k) {
          actions.move(p.id, to);
          list.querySelector<HTMLElement>(`[data-id="${p.id}"]`)?.focus();
        }
      } else if (e.key === 'Delete') {
        e.preventDefault();
        actions.remove(p.id);
      }
    });
    item.addEventListener('pointerdown', (e) => startDrag(e, item, p.id));
    return item;
  }

  /** Dragging a page: a line shows where it will go */
  function startDrag(start: PointerEvent, item: HTMLElement, id: number) {
    if (locked || start.button !== 0 || (start.target as HTMLElement).closest('button'))
      return;
    let dragging = false;
    let to = -1;
    const marker = el('div', { class: 'sr-drop' });
    const move = (e: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) < 6)
          return;
        dragging = true;
        item.classList.add('is-dragging');
        item.setPointerCapture(e.pointerId);
      }
      // The page whose middle is nearest decides; before or after it
      const cards = [...list.querySelectorAll<HTMLElement>('.sr-page')];
      let best = 0;
      let bestD = Infinity;
      cards.forEach((c, k) => {
        const r = c.getBoundingClientRect();
        const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      });
      const r = cards[best].getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      const from = cards.indexOf(item);
      let target = best + (after ? 1 : 0);
      if (target > from) target--;
      to = target;
      marker.style.left = `${(after ? r.right : r.left) - list.getBoundingClientRect().left + list.scrollLeft - 3}px`;
      marker.style.top = `${r.top - list.getBoundingClientRect().top + list.scrollTop}px`;
      marker.style.height = `${r.height}px`;
      if (!marker.isConnected) list.append(marker);
    };
    const up = () => {
      item.removeEventListener('pointermove', move);
      item.removeEventListener('pointerup', up);
      item.removeEventListener('pointercancel', up);
      marker.remove();
      item.classList.remove('is-dragging');
      if (dragging && to >= 0 && to !== pages.findIndex((p) => p.id === id))
        actions.move(id, to);
    };
    item.addEventListener('pointermove', move);
    item.addEventListener('pointerup', up);
    item.addEventListener('pointercancel', up);
  }

  return {
    el: root,
    render(next: ReviewPage[], emptyText: string) {
      const focused = (document.activeElement as HTMLElement | null)?.closest?.('.sr-page')
        ?.getAttribute('data-id');
      const scroll = list.scrollTop;
      pages = next;
      list.replaceChildren(...pages.map(card));
      list.scrollTop = scroll;
      empty.textContent = emptyText;
      empty.hidden = pages.length > 0;
      list.hidden = !pages.length;
      if (focused) list.querySelector<HTMLElement>(`[data-id="${focused}"]`)?.focus();
    },
    /** Scrolls to the newest page */
    showLast() {
      list.lastElementChild?.scrollIntoView({ block: 'nearest' });
    },
    lock(on: boolean) {
      locked = on;
      root.classList.toggle('is-locked', on);
    },
  };
}
