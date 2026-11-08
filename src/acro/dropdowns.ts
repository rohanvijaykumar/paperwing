/**
 * The app's dropdowns (select.pref-select) draw their own list in the page
 * (app.css: appearance: base-select), so it looks like the app's menus in
 * both themes. The system's list showed the highlighted option in pale blue
 * with grey text in the dark theme. What that needs:
 * - each dropdown shows its choice in a <selectedcontent>, so a long one is
 *   cut short with "…" (the dropdowns are made in many places, and their
 *   options replaced as things change, hence the observer)
 * - the list's keys reach the page's handlers, which a system list's never
 *   did: Escape closes just the list, not the dialog under it
 */

const DROPDOWN = 'select.pref-select';

/** The dropdown whose list is open, if a key comes from inside it */
export function openDropdown(
  target: EventTarget | null
): HTMLSelectElement | null {
  const s = (target as Element | null)?.closest?.('select');
  return s?.matches(':open') ? s : null;
}

/** Gives a dropdown the button that shows its choice */
export function showsChoice(select: HTMLSelectElement): void {
  if (select.querySelector(':scope > button')) return;
  const button = document.createElement('button');
  button.append(document.createElement('selectedcontent'));
  select.prepend(button);
}

function watch(): void {
  const within = (node: Node) => {
    if (!(node instanceof Element)) return;
    if (node.matches(DROPDOWN)) showsChoice(node as HTMLSelectElement);
    for (const s of node.querySelectorAll<HTMLSelectElement>(DROPDOWN))
      showsChoice(s);
  };
  within(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      // (its options replaced: the button went with them)
      if (r.target instanceof HTMLSelectElement && r.target.matches(DROPDOWN))
        showsChoice(r.target);
      r.addedNodes.forEach(within);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // (capture, on window, and registered before the app's own handlers: this
  // runs first)
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && openDropdown(e.target))
        e.stopImmediatePropagation();
    },
    true
  );
}

watch();
