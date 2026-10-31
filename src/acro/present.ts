/**
 * Full screen, as in Acrobat: one page at a time, as big as the screen
 * allows, on black. The arrow keys, Page Up/Down, Space, the mouse wheel and
 * a click move between pages; Esc leaves (app.ts).
 *
 * The viewer still lays the pages out one under another; this fits a page to
 * the screen, centres it, stops the viewer scrolling by itself and covers
 * whatever of the pages next to it would show.
 */
import type { Viewer } from './viewer';

const STYLE_ID = 'pw-present';
const HIDE_CURSOR_AFTER = 2500;

export class Presentation {
  private host = document.querySelector<HTMLElement>('embedpdf-container');
  private frame = document.createElement('div');
  private observer?: ResizeObserver;
  private refit = 0;
  private idle = 0;
  private wheelUntil = 0;
  private placing = 0;
  private stopped = false;
  /** The page shown (the viewer's own idea of it lags behind while it
   *  scrolls there, and moves to a neighbour once a page is centred) */
  private page: number;

  constructor(
    private viewer: Viewer,
    private tabId: string,
    private restoreZoom: number | null = viewer.zoom(tabId)
  ) {
    this.page = viewer.pageInfo(tabId)?.current ?? 1;
    const root = this.host?.shadowRoot;
    if (root && !root.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      // The viewer's page area: black, and only moved by us
      style.textContent = `
        :host(.is-presenting) .bg-bg-app {
          background: #000 !important;
          overflow: hidden !important;
        }
        :host(.is-presenting.is-idle) * { cursor: none !important; }`;
      root.append(style);
    }
    this.host?.classList.add('is-presenting');
    this.frame.className = 'present-frame';
    document.body.append(this.frame);

    window.addEventListener('wheel', this.onWheel, {
      capture: true,
      passive: false,
    });
    window.addEventListener('click', this.onClick, true);
    window.addEventListener('mousemove', this.onMove, true);
    // Entering full screen resizes the window: fit again once it settles
    const area = this.area();
    if (area) {
      this.observer = new ResizeObserver(() => {
        clearTimeout(this.refit);
        this.refit = window.setTimeout(() => this.fit(), 120);
      });
      this.observer.observe(area);
    }
    this.fit();
    this.onMove();
  }

  /** Keys that move between pages; true if it was one */
  key(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const target = e.composedPath()[0] as HTMLElement | undefined;
    if (target && isField(target)) return false;
    const current = this.page;
    const total = this.viewer.pageInfo(this.tabId)?.total ?? 1;
    let page: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
      case 'Enter':
      case 'n':
        page = current + 1;
        break;
      case ' ':
        page = current + (e.shiftKey ? -1 : 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
      case 'Backspace':
      case 'p':
        page = current - 1;
        break;
      case 'Home':
        page = 1;
        break;
      case 'End':
        page = total;
        break;
      default:
        return false;
    }
    this.go(page);
    return true;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    window.removeEventListener('wheel', this.onWheel, { capture: true });
    window.removeEventListener('click', this.onClick, true);
    window.removeEventListener('mousemove', this.onMove, true);
    this.observer?.disconnect();
    clearTimeout(this.refit);
    clearTimeout(this.idle);
    cancelAnimationFrame(this.placing);
    this.frame.remove();
    this.host?.classList.remove('is-presenting', 'is-idle');
    // Back to the zoom it had, on the page it's at now
    const page = this.page;
    if (this.restoreZoom) this.viewer.setZoom(this.tabId, this.restoreZoom);
    setTimeout(() => {
      if (this.viewer.pageInfo(this.tabId))
        this.viewer.goToPage(this.tabId, page);
    }, 60);
  }

  /** The page fitted to the screen, then centred */
  private fit() {
    if (this.stopped) return;
    this.viewer.setZoom(this.tabId, 'fit-page');
    setTimeout(() => this.go(this.page), 60);
  }

  private go(page: number) {
    const info = this.viewer.pageInfo(this.tabId);
    if (!info || this.stopped) return;
    this.page = Math.min(Math.max(1, page), info.total);
    this.viewer.goToPage(this.tabId, this.page);
    this.place(this.page);
  }

  /**
   * Centres the page and frames it, once the viewer has scrolled there in
   * its own time: it says it's on that page, and a page sits at the top
   */
  private place(page: number) {
    cancelAnimationFrame(this.placing);
    let tries = 0;
    let framed = 0;
    let centred = false;
    const step = () => {
      if (this.stopped || page !== this.page) return;
      const area = this.area();
      if (!area) return;
      const a = area.getBoundingClientRect();
      if (!centred) {
        const box =
          this.viewer.pageInfo(this.tabId)?.current === page
            ? this.nearest(area, a.top, 'top')
            : null;
        const r = box?.getBoundingClientRect();
        if (!r || Math.abs(r.top - a.top) > 40) {
          if (++tries < 90) this.placing = requestAnimationFrame(step);
          return;
        }
        area.scrollTop += r.top + r.height / 2 - (a.top + a.height / 2);
        area.scrollLeft += r.left + r.width / 2 - (a.left + a.width / 2);
        centred = true;
      }
      // The page now in the middle (the viewer may redraw it a moment later)
      const box = this.nearest(area, a.top + a.height / 2, 'middle');
      if (box) {
        const r = box.getBoundingClientRect();
        Object.assign(this.frame.style, {
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        });
      }
      if (framed++ < 6) this.placing = requestAnimationFrame(step);
    };
    this.placing = requestAnimationFrame(step);
  }

  /** The viewer's scrolling page area */
  private area(): HTMLElement | null {
    return (
      this.host?.shadowRoot?.querySelector<HTMLElement>('.bg-bg-app') ?? null
    );
  }

  /** The page whose top (or middle) is nearest `y` */
  private nearest(
    area: HTMLElement,
    y: number,
    by: 'top' | 'middle'
  ): HTMLElement | null {
    let best: HTMLElement | null = null;
    let distance = Infinity;
    for (const box of area.querySelectorAll<HTMLElement>('div')) {
      if (
        box.style.position !== 'relative' ||
        box.style.touchAction !== 'none' ||
        !(box.firstElementChild instanceof HTMLImageElement)
      )
        continue;
      const r = box.getBoundingClientRect();
      if (!r.height) continue;
      const d = Math.abs((by === 'top' ? r.top : r.top + r.height / 2) - y);
      if (d < distance) {
        distance = d;
        best = box;
      }
    }
    return best;
  }

  /** One page per turn of the wheel */
  private onWheel = (e: WheelEvent) => {
    if (!this.inArea(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    if (now < this.wheelUntil || Math.abs(e.deltaY) < 4) return;
    this.wheelUntil = now + 350;
    this.go(this.page + (e.deltaY > 0 ? 1 : -1));
  };

  /** A click on the page moves on, unless it's on a link or a field */
  private onClick = (e: MouseEvent) => {
    if (e.button !== 0 || !this.inArea(e)) return;
    const target = e.composedPath()[0] as HTMLElement | undefined;
    if (target?.closest?.('a, button, [role="button"]') || isField(target))
      return;
    this.go(this.page + 1);
  };

  /** The pointer hides while it's not moving */
  private onMove = () => {
    this.host?.classList.remove('is-idle');
    clearTimeout(this.idle);
    this.idle = window.setTimeout(
      () => this.host?.classList.add('is-idle'),
      HIDE_CURSOR_AFTER
    );
  };

  private inArea(e: Event) {
    const area = this.area();
    return !!area && e.composedPath().includes(area);
  }
}

const isField = (el: HTMLElement | undefined) =>
  !!el &&
  (/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName) || el.isContentEditable);
